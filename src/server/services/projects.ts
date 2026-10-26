import "server-only";
/**
 * Projects: create (resumable job copying the template), edit details, archive/restore, reconcile mirrors.
 */
import { formatValue } from "@/domain/format";
import { buildProjectSnapshot, remapFlow, type StepDraft } from "@/domain/snapshot";
import { stableStringify } from "@/domain/syncPlan";
import {
  PROJECT_STATUSES,
  type Attachment,
  type Choice,
  type DropdownValue,
  type MultipleValue,
  type Note,
  type Project,
  type ProjectField,
  type ProjectStatus,
  type Value,
} from "@/domain/types";
import { normalizeValue } from "@/domain/values";
import type { ProjectInput, Repo, StepInput, StoredStep } from "@/server/repo/types";
import {
  appendHistory,
  AppError,
  EV,
  notFound,
  requireName,
  summaryFor,
  type Ctx,
} from "./context";
import {
  assertJobFits,
  BATCH_SIZE,
  beginJobCall,
  claimJob,
  elsewhereResult,
  finishJob,
  isFinished,
  loadJob,
  loadJobForContinue,
  mergeRecord,
  newJob,
  orphansOf,
  recheckJob,
  SAMPLE_ID,
  SAMPLE_LEASE,
  sameRecord,
  saveJob,
  saveRunningJob,
  settleSome,
  stepResult,
  type JobBase,
  type JobCall,
  type JobStepResult,
} from "./jobs";
import { getTemplate } from "./library";
import { attachmentCounts, buildCells, cellsEqual, currentMirror, progressOfCells, projectDetailMirrors } from "./mirrors";
import { listProjectFields } from "./projectFields";

export const PROJECT_CODE_PATTERN = /^[A-Z0-9][A-Z0-9-]{1,19}$/;
export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = { ACTIVE: "Active", ON_HOLD: "On hold", CLOSED: "Closed" };

/** Trimmed and upper-cased; AppError VALIDATION unless it matches ^[A-Z0-9][A-Z0-9-]{1,19}$. */
export function normalizeProjectCode(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) throw new AppError("VALIDATION", "Enter a project code, for example C0822.");
  const code = raw.trim().toUpperCase();
  if (!PROJECT_CODE_PATTERN.test(code)) {
    throw new AppError(
      "VALIDATION",
      "A project code is 2–20 letters, digits or dashes and starts with a letter or digit, for example C0822 or C0822-SP1.",
    );
  }
  return code;
}

function requireStatus(raw: unknown): ProjectStatus {
  if (typeof raw === "string" && (PROJECT_STATUSES as readonly string[]).includes(raw)) return raw as ProjectStatus;
  throw new AppError("VALIDATION", "Pick a status: Active, On hold or Closed.");
}

export async function requireProject(repo: Repo, id: string): Promise<Project> {
  const p = await repo.projects.get(id);
  if (!p) throw notFound("This project");
  return p;
}

/** Throws CODE_TAKEN when another project (archived included) uses the code. */
export async function assertCodeFree(repo: Repo, code: string, exceptId?: string): Promise<void> {
  const other = await repo.projects.findByCode(code);
  if (!other || other.id === exceptId) return;
  if (other.archived) {
    throw new AppError("CODE_TAKEN", `${code} is used by an archived project. Restore it from the Archive.`, {
      projectId: other.id,
    });
  }
  throw new AppError("CODE_TAKEN", `${code} is already used by "${other.name}".`, { projectId: other.id });
}

function selectedChoiceIds(v: Value | null | undefined): string[] {
  if (!v || typeof v !== "object") return [];
  if ("choiceId" in v) return [(v as DropdownValue).choiceId];
  if ("choiceIds" in v) return (v as MultipleValue).choiceIds ?? [];
  return [];
}

/**
 * Rejects newly picked retired (archived) choices; a value that already uses a retired choice may be kept.
 */
export function assertNoNewRetiredChoice(choices: Choice[], next: Value | null, current: Value | null | undefined): void {
  const archived = new Set((choices ?? []).filter((c) => c.archived).map((c) => c.id));
  if (archived.size === 0) return;
  const had = new Set(selectedChoiceIds(current));
  for (const id of selectedChoiceIds(next)) {
    if (archived.has(id) && !had.has(id)) {
      const label = choices.find((c) => c.id === id)?.label ?? id;
      throw new AppError("VALIDATION", `"${label}" is retired and can't be picked any more.`);
    }
  }
}

/**
 * Normalises detail values per field (keys: field id, or field key). Unknown or archived fields are refused.
 * Returns only the fields present in `raw`.
 */
export function normalizeDetails(
  fields: ProjectField[],
  raw: Record<string, unknown> | undefined,
  current: Record<string, Value | null> = {},
): Record<string, Value | null> {
  const out: Record<string, Value | null> = {};
  if (!raw) return out;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new AppError("VALIDATION", "Project details must be an object.");
  const byId = new Map(fields.map((f) => [f.id, f]));
  const byKey = new Map(fields.map((f) => [f.key, f]));
  for (const [k, v] of Object.entries(raw)) {
    const f = byId.get(k) ?? byKey.get(k);
    if (!f) throw new AppError("VALIDATION", `Unknown project field "${k}".`);
    const def = { fieldType: f.fieldType, choices: f.choices ?? [], config: f.config ?? {} };
    const r = normalizeValue(def, v);
    if (!r.ok) throw new AppError("VALIDATION", `${f.label}: ${r.error}`);
    if (f.archived && r.value !== null && stableStringify(r.value) !== stableStringify(current[f.id] ?? null)) {
      throw new AppError("VALIDATION", `"${f.label}" is archived. Restore it in the Library first.`);
    }
    assertNoNewRetiredChoice(f.choices ?? [], r.value, current[f.id]);
    out[f.id] = r.value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Create (resumable)
// ---------------------------------------------------------------------------

export interface CreateProjectInput {
  code: string;
  name: string;
  status?: ProjectStatus;
  /** Keyed by project field id (or key). */
  details?: Record<string, unknown>;
}

export interface CreateProjectJob extends JobBase<"createProject"> {
  /** null until the Project row exists (the job is saved first, so a retry finds the row by code). */
  projectId?: string;
  code: string;
  name: string;
  drafts: StepDraft[];
  revision: number;
  /** The Project row to create, so a retry after a crash before the row existed can still create it. */
  row?: ProjectInput;
  /**
   * tempId → id of the step created for it, saved after every batch. The next batch counts these as done instead of
   * looking for them with a query that may not show them yet (and would create them a second time).
   */
  created?: Record<string, string>;
}

export function stepKeyOf(projectId: string, tempId: string): string {
  return `${projectId}:${tempId}`;
}

/**
 * Validates and starts a project: creates the Project row (setup CREATING, flow = template snapshot keyed by temp
 * ids, no cells) and stores job `job:<opId>` with the step drafts. Call continueCreateProject until done.
 * A repeated call with the same opId returns the same project.
 */
export async function startCreateProject(ctx: Ctx, input: CreateProjectInput): Promise<{ projectId: string; total: number }> {
  const existingJob = await loadJob<CreateProjectJob>(ctx.repo, ctx.opId);
  if (existingJob?.kind === "createProject") {
    const projectId = existingJob.projectId ?? (await adoptOrCreateProject(ctx, existingJob)).id;
    return { projectId, total: existingJob.total };
  }

  const code = normalizeProjectCode(input.code);
  const name = requireName(input.name, "The project name");
  const status = input.status === undefined ? "ACTIVE" : requireStatus(input.status);
  const fields = await listProjectFields(ctx.repo, { includeArchived: true });
  const details = normalizeDetails(fields, input.details);
  await assertCodeFree(ctx.repo, code);

  const template = await getTemplate(ctx.repo);
  if (!template.milestones.some((m) => !m.archived)) {
    throw new AppError("VALIDATION", "The template has no milestones yet. Load the 64 milestones in Setup first.");
  }
  const snapshot = buildProjectSnapshot(template, ctx.now);

  const row: ProjectInput = {
    code,
    name,
    status,
    details,
    mirrors: projectDetailMirrors(fields, details),
    flow: snapshot.flow,
    cells: {},
    progress: 0,
    templateRevision: template.revision,
    syncDismissed: {},
    setup: "CREATING",
    archived: false,
  };
  const job: CreateProjectJob = {
    ...newJob(ctx, "createProject", snapshot.steps.length),
    code,
    name,
    drafts: snapshot.steps,
    revision: template.revision,
    row,
  };
  // The job grows as the copy records its steps: refuse up front a template whose copy could not be saved to the end.
  const later: CreateProjectJob = {
    ...job,
    projectId: SAMPLE_ID,
    created: Object.fromEntries(job.drafts.map((d) => [d.tempId, SAMPLE_ID])),
    lease: SAMPLE_LEASE,
  };
  delete later.row;
  assertJobFits(job, "Copying this template");
  assertJobFits(later, "Copying this template");
  await saveJob(ctx.repo, job, { creates: true });

  const project = await ctx.repo.projects.create(row);
  job.projectId = project.id;
  delete job.row;
  await saveJob(ctx.repo, job);
  return { projectId: project.id, total: job.total };
}

/**
 * Resume after a crash between saving the job and recording the project id: find our row by code (it may have been
 * created), or create it from the job when the first attempt never got that far.
 */
async function adoptOrCreateProject(ctx: Ctx, job: CreateProjectJob): Promise<Project> {
  const found = await ctx.repo.projects.findByCode(job.code);
  if (found && found.setup === "CREATING") {
    job.projectId = found.id;
    delete job.row;
    await saveJob(ctx.repo, job);
    return found;
  }
  if (found) throw new AppError("CODE_TAKEN", `${job.code} is already used by "${found.name}".`);
  if (!job.row) throw new AppError("NOT_FOUND", "This project was not created. Start again.");
  const project = await ctx.repo.projects.create(job.row);
  job.projectId = project.id;
  delete job.row;
  await saveJob(ctx.repo, job);
  return project;
}

export interface CreateProgress extends JobStepResult {
  projectId: string;
  created: number;
}

/**
 * Creates up to 8 missing steps per call. The job records each created step's id (tempId → step id) and is saved
 * after every batch, so a lagging query never makes a later batch create a step twice; stepKey
 * (`<projectId>:<tempId>`) finds steps a crashed batch created before it could record them.
 * When all exist: remaps the flow to the recorded step ids, builds cells, sets setup READY and progress, moves any
 * second copy of a step to Notion's trash, writes ONE History row `project.created` { revision, nodeCount, edgeCount }
 * and clears the job. Calling again after done is a no-op.
 *
 * `driver` identifies the browser run (see claimJob): while another run holds the job, the call only reports
 * RUNNING_ELSEWHERE. Finalizing works from the record Notion has (read again by page id first), and a second copy is
 * only discarded when nothing uses it: not the project's flow or cells, and no file, link or note.
 */
export async function continueCreateProject(ctx: Ctx, opId: string, opts: { driver?: string } = {}): Promise<CreateProgress> {
  const call = beginJobCall(ctx, opts.driver);
  const loaded = await loadJobForContinue<CreateProjectJob>(ctx.repo, opId);
  if (!loaded || loaded.kind !== "createProject") throw new AppError("NOT_FOUND", "This project setup was not found. Start again.");
  const claim = await claimJob(call, loaded);
  if (claim.wait) return { ...claim.wait, projectId: loaded.projectId ?? "", created: loaded.doneCount };
  const job = claim.job;
  const ready = (): CreateProgress => ({
    ...stepResult(true, job.total, job.total, "Project ready"),
    projectId: job.projectId ?? "",
    created: job.total,
  });
  if (isFinished(job)) return ready();
  const project = job.projectId ? await requireProject(ctx.repo, job.projectId) : await adoptOrCreateProject(ctx, job);
  const projectId = project.id;
  const total = job.drafts.length;
  const created: Record<string, string> = { ...(job.created ?? {}) };
  const progress = (n: number): CreateProgress => ({
    ...stepResult(false, n, total, `Copied ${n} of ${total} milestones`),
    projectId,
    created: n,
  });
  const countHave = () => job.drafts.filter((d) => created[d.tempId]).length;

  // The query only finds what a crashed batch created before the job could record it (when Notion already shows it).
  const listed = await ctx.repo.steps.listByProject(projectId, { includeArchived: true });
  const byId = new Map(listed.map((s) => [s.id, s]));
  const firstByKey = new Map<string, StoredStep>();
  for (const s of listed) if (!firstByKey.has(s.stepKey)) firstByKey.set(s.stepKey, s);
  let recorded = false;
  for (const d of job.drafts) {
    if (created[d.tempId]) continue;
    const s = firstByKey.get(stepKeyOf(projectId, d.tempId));
    if (s) {
      created[d.tempId] = s.id;
      recorded = true;
    }
  }

  const batch = job.drafts.filter((d) => !created[d.tempId]).slice(0, BATCH_SIZE);
  const { results, error } = await settleSome(
    batch.map((d) => () => {
      const { tempId, ...rest } = d;
      const input: StepInput = { ...rest, projectId, stepKey: stepKeyOf(projectId, tempId), lastOp: job.opId };
      return ctx.repo.steps.create(input);
    }),
  );
  const madeHere = new Set<string>();
  results.forEach((s, i) => {
    if (!s) return;
    created[batch[i].tempId] = s.id;
    byId.set(s.id, s);
    madeHere.add(s.id);
    recorded = true;
  });
  if (recorded) {
    const saved = await saveCreated(call, job, created, madeHere, countHave);
    if (saved !== "saved") {
      if (error) throw error;
      return saved === "finished" ? ready() : { ...elsewhereResult(job, job.lease!, call.now()), projectId, created: job.doneCount };
    }
  }
  if (error) throw error;
  const have = countHave();
  if (have < total) return progress(have);

  // All steps exist: finalize with the recorded ids (steps the query does not show yet are read by id).
  const unseen = [...new Set(Object.values(created))].filter((id) => !byId.has(id));
  const read = await settleAll(unseen.map((id) => () => ctx.repo.steps.get(id)));
  read.forEach((s, i) => {
    if (s && s.projectId === projectId) byId.set(unseen[i], s);
  });
  const lost = job.drafts.filter((d) => !byId.has(created[d.tempId]));
  if (lost.length) {
    // A recorded step is gone (deleted in Notion meanwhile): forget it, so the next call creates it again.
    const gone = new Set(lost.map((d) => created[d.tempId]));
    for (const d of lost) delete created[d.tempId];
    const saved = await saveCreated(call, job, created, new Set(), countHave, gone);
    if (saved === "finished") return ready();
    return progress(countHave());
  }

  // Only the record Notion has is finalized: when another call saved a different one meanwhile, the next call goes on
  // from that one (two finalizing calls then write the same flow).
  const before = await recheckJob<CreateProjectJob>(call, job.opId, (j) => sameRecord(j.created, created));
  if (before === "finished") return ready();
  if (before !== "same") return before === "changed" ? progress(have) : { ...before, projectId, created: have };
  const idMap: Record<string, string> = {};
  const steps: StoredStep[] = [];
  for (const d of job.drafts) {
    idMap[d.tempId] = created[d.tempId];
    steps.push(byId.get(created[d.tempId])!);
  }
  const fresh = await requireProject(ctx.repo, projectId);
  const flow = remapFlow(fresh.flow, idMap);
  const cells = buildCells(steps, {});
  const progressPct = progressOfCells(cells, ctx.day).pct;
  // READY is written together with the remapped flow and the cells, so a READY project was finalized already (a
  // resumed call only completes the History row and the job). Rewriting it would drop changes made since.
  if (fresh.setup !== "READY") {
    await ctx.repo.projects.update(projectId, {
      flow,
      cells,
      progress: progressPct,
      setup: "READY",
      mirrors: { current: currentMirror(cells, flow, ctx.day) },
    });
  }
  const edgeCount = flow.edges.filter((e) => !e.archivedAt).length;
  // Second copies go first: the History row is the last write before the tombstone (see continueImport).
  const after = await recheckJob<CreateProjectJob>(call, job.opId, (j) => sameRecord(j.created, created));
  if (after === "finished") return ready();
  if (after !== "same") return after === "changed" ? progress(have) : { ...after, projectId, created: have };
  const copies = findStepCopies(listed, keyedIds(projectId, created), job.opId);
  await discardUnusedCopies(ctx, projectId, copies.map((s) => s.id), new Set(Object.values(created)));
  await appendHistory(
    ctx,
    {
      type: EV.projectCreated,
      summary: summaryFor(fresh.code, `Project created (${steps.length} milestones)`),
      projectId,
      newDisplay: fresh.name,
      data: { revision: job.revision, nodeCount: steps.length, edgeCount, code: fresh.code, name: fresh.name },
    },
    { opId: job.opId },
  );
  await finishJob(ctx, job, { projectId });
  return ready();
}

/**
 * Saves the steps a create job recorded, keeping what another call recorded meanwhile (Notion's entry wins for a
 * step both created). A copy this call made that lost, or that nobody will record because the job finished, is
 * discarded at once when nothing uses it (see orphansOf).
 */
async function saveCreated(
  call: JobCall,
  job: CreateProjectJob,
  created: Record<string, string>,
  madeHere: Set<string>,
  countHave: () => number,
  gone: ReadonlySet<string> = new Set(),
): Promise<"saved" | "finished" | "elsewhere"> {
  const lost: string[] = [];
  job.created = created;
  job.doneCount = countHave();
  job.updatedAt = call.ctx.now;
  const { outcome, stored } = await saveRunningJob(call, job, (s) => {
    lost.push(...mergeRecord(created, s.created, gone));
    job.doneCount = countHave();
  });
  if (outcome === "elsewhere" && stored) job.lease = stored.lease;
  const orphans = orphansOf(outcome, lost, madeHere);
  if (orphans.length && job.projectId) {
    const keep = new Set(Object.values(outcome === "saved" ? created : (stored?.created ?? {})));
    await discardUnusedCopies(call.ctx, job.projectId, orphans, keep);
  }
  return outcome;
}

/** stepKey → the step id a job recorded for it. */
export function keyedIds(projectId: string, created: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(created).map(([tempId, id]) => [stepKeyOf(projectId, tempId), id]));
}

/**
 * Second copies of steps a job created: rows with one of the job's step keys that are not the recorded step, still
 * exactly as the job created them (lastOp = the job's op, never edited). `referenced`: steps with a file, link or note.
 */
export function findStepCopies(
  listed: StoredStep[],
  recorded: Map<string, string>,
  opId: string,
  referenced: ReadonlySet<string> = new Set(),
): StoredStep[] {
  return listed.filter((s) => {
    const keep = recorded.get(s.stepKey);
    return keep !== undefined && keep !== s.id && s.lastOp === opId && untouched(s, referenced);
  });
}

/**
 * Moves second copies to Notion's trash (recoverable there for 30 days; the app never shows them again), after
 * checking each against Notion as it is now: a copy stays when the project's flow or cells use it, when it has an
 * active file, link or note, when it is in `keep`, or when it was changed (read again by id).
 */
export async function discardUnusedCopies(
  ctx: Ctx,
  projectId: string,
  ids: string[],
  keep: ReadonlySet<string> = new Set(),
): Promise<string[]> {
  const candidates = [...new Set(ids)].filter((id) => !keep.has(id));
  if (candidates.length === 0) return [];
  const [project, attachments, notes] = await Promise.all([
    ctx.repo.projects.get(projectId),
    ctx.repo.attachments.listByProject(projectId),
    ctx.repo.notes.listByProject(projectId),
  ]);
  const used = new Set([...Object.keys(project?.flow?.nodes ?? {}), ...Object.keys(project?.cells ?? {})]);
  const referenced = referencedStepIds(project, attachments, notes);
  const now = await settleAll(candidates.filter((id) => !used.has(id)).map((id) => () => ctx.repo.steps.get(id)));
  const discard = now.filter((s): s is StoredStep => !!s && s.projectId === projectId && untouched(s, referenced)).map((s) => s.id);
  await settleAll(discard.map((id) => () => ctx.repo.steps.discard(id)));
  return discard;
}

/**
 * Steps someone has added something to that a step's own fields do not show: an active file, link or note, or a file
 * count in the project's cells (written straight away when a file is added, before the Files query shows it).
 */
export function referencedStepIds(project: Project | null, attachments: Attachment[], notes: Note[]): Set<string> {
  const out = new Set<string>();
  for (const a of attachments) if (a.stepId && !a.archived) out.add(a.stepId);
  for (const n of notes) if (n.stepId && !n.archived) out.add(n.stepId);
  for (const [id, cell] of Object.entries(project?.cells ?? {})) if ((cell.fc ?? 0) > 0) out.add(id);
  return out;
}

/** A step nobody has changed since it was created (no value, N/A, flag, revision, file, link or note). */
export function untouched(s: StoredStep, referenced: ReadonlySet<string> = new Set()): boolean {
  return (s.rev ?? 0) === 0 && (s.value ?? null) === null && !s.notApplicable && !s.flag && !s.archived && !referenced.has(s.id);
}

/** Runs write thunks in parallel and waits for all of them before throwing the first error (no write left in flight). */
export async function settleAll<T>(tasks: (() => Promise<T>)[]): Promise<T[]> {
  const results = await Promise.allSettled(tasks.map((t) => t()));
  const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failed) throw failed.reason;
  return results.map((r) => (r as PromiseFulfilledResult<T>).value);
}

// ---------------------------------------------------------------------------
// Edit, archive, restore
// ---------------------------------------------------------------------------

export interface ProjectPatch {
  code?: string;
  name?: string;
  status?: ProjectStatus;
  /** Only the fields to change; null clears a value. */
  details?: Record<string, unknown>;
}

export interface ProjectChange {
  field: string;
  label: string;
  old: string;
  new: string;
}

/**
 * Edits code, name, status and detail values. History `project.updated` (or `project.code_changed` when the code
 * changed, so Phase 2 can map old codes) listing every changed field old → new.
 */
export async function updateProject(
  ctx: Ctx,
  id: string,
  patch: ProjectPatch,
): Promise<{ project: Project; changes: ProjectChange[] }> {
  const p = await requireProject(ctx.repo, id);
  const update: Partial<ProjectInput> = {};
  const changes: ProjectChange[] = [];

  if (patch.code !== undefined) {
    const code = normalizeProjectCode(patch.code);
    if (code !== p.code) {
      await assertCodeFree(ctx.repo, code, id);
      update.code = code;
      changes.push({ field: "code", label: "Code", old: p.code, new: code });
    }
  }
  if (patch.name !== undefined) {
    const name = requireName(patch.name, "The project name");
    if (name !== p.name) {
      update.name = name;
      changes.push({ field: "name", label: "Name", old: p.name, new: name });
    }
  }
  if (patch.status !== undefined) {
    const status = requireStatus(patch.status);
    if (status !== p.status) {
      update.status = status;
      changes.push({ field: "status", label: "Status", old: PROJECT_STATUS_LABELS[p.status], new: PROJECT_STATUS_LABELS[status] });
    }
  }
  if (patch.details !== undefined) {
    const fields = await listProjectFields(ctx.repo, { includeArchived: true });
    const normalized = normalizeDetails(fields, patch.details, p.details ?? {});
    const details = { ...(p.details ?? {}) };
    let changed = false;
    for (const [fid, value] of Object.entries(normalized)) {
      const before = details[fid] ?? null;
      if (stableStringify(before) === stableStringify(value)) continue;
      const f = fields.find((x) => x.id === fid)!;
      const def = { fieldType: f.fieldType, choices: f.choices ?? [], config: f.config ?? {} };
      changes.push({ field: fid, label: f.label, old: formatValue(def, before), new: formatValue(def, value) });
      if (value === null) delete details[fid];
      else details[fid] = value;
      changed = true;
    }
    if (changed) {
      update.details = details;
      update.mirrors = projectDetailMirrors(fields, details);
    }
  }

  if (changes.length === 0) return { project: p, changes };

  // The row (with the old values) is written before the project: an old code must reach History for Phase 2 mail
  // mapping. A retry with the same opId then finishes the project update without a second row.
  const codeChanged = update.code !== undefined;
  const newCode = update.code ?? p.code;
  await appendHistory(ctx, {
    type: codeChanged ? EV.projectCodeChanged : EV.projectUpdated,
    summary: summaryFor(newCode, changes.map((c) => `${c.label}: ${c.old} → ${c.new}`).join("; ")),
    projectId: id,
    data: { changes, ...(codeChanged ? { oldCode: p.code, newCode } : {}) },
  });
  const project = await ctx.repo.projects.update(id, update);
  return { project, changes };
}

/**
 * Archive / restore write the History row first and then the project, so a retry with the same opId after a crash
 * between the two finishes the change with exactly one row (a toggle found already done can't tell whose it was).
 */
export async function archiveProject(ctx: Ctx, id: string): Promise<Project> {
  const p = await requireProject(ctx.repo, id);
  if (p.archived) return p;
  await appendHistory(ctx, {
    type: EV.projectArchived,
    summary: summaryFor(p.code, "Project archived"),
    projectId: id,
    data: { code: p.code, name: p.name },
  });
  return ctx.repo.projects.update(id, { archived: true, archivedAt: ctx.now });
}

export async function restoreProject(ctx: Ctx, id: string): Promise<Project> {
  const p = await requireProject(ctx.repo, id);
  if (!p.archived) return p;
  await appendHistory(ctx, {
    type: EV.projectRestored,
    summary: summaryFor(p.code, "Project restored"),
    projectId: id,
    data: { code: p.code, name: p.name },
  });
  return ctx.repo.projects.update(id, { archived: false, archivedAt: undefined });
}

/**
 * How long after a project was written its cells' attachment counts are trusted over the Files query, which can miss
 * a file added moments ago (or still count one removed moments ago).
 */
export const RECENT_WRITE_MS = 120_000;

export interface ReconcileOptions {
  /**
   * Settings → Repair mirrors: also rewrite the Notion mirrors (Current, Customer, Project type, Summary) even when the
   * cells match. Pass every project field (archived included).
   */
  rewriteMirrors?: { fields: ProjectField[] };
}

/**
 * Recomputes Cells and Progress from all steps (+ attachment counts) and PATCHes the project only when they
 * differ. Called after the project page renders and by "Repair mirrors". No History.
 *
 * A query can miss steps created moments ago: steps the cells know but the query does not return are read by id, and
 * a cell is dropped only when its step is archived or gone. Untouched second copies of a step (same stepKey, left by
 * a retried create) stay out of the cells and go to Notion's trash once the flow uses one copy (see dropStepCopies).
 */
export async function reconcileProject(ctx: Ctx, projectId: string, opts: ReconcileOptions = {}): Promise<{ changed: boolean }> {
  const [project, listed, attachments, notes] = await Promise.all([
    requireProject(ctx.repo, projectId),
    ctx.repo.steps.listByProject(projectId),
    ctx.repo.attachments.listByProject(projectId),
    ctx.repo.notes.listByProject(projectId),
  ]);
  if (project.setup !== "READY") return { changed: false };
  const referenced = referencedStepIds(project, attachments, notes);
  const steps = await dropStepCopies(ctx, project, await withKnownSteps(ctx.repo, project, listed), referenced);
  const cells = buildCells(steps, countsTrustingRecentCells(ctx, project, attachments));
  const progress = progressOfCells(cells, ctx.day).pct;
  const same = cellsEqual(cells, project.cells ?? {}) && progress === project.progress;
  if (same && !opts.rewriteMirrors) return { changed: false };
  const mirrors = {
    ...(opts.rewriteMirrors ? projectDetailMirrors(opts.rewriteMirrors.fields, project.details ?? {}) : {}),
    current: currentMirror(cells, project.flow, ctx.day),
  };
  await ctx.repo.projects.update(projectId, same ? { mirrors } : { cells, progress, mirrors });
  return { changed: !same };
}

/**
 * Active attachments per step from the Files query, except right after the project was written (RECENT_WRITE_MS):
 * then the counts its cells carry win, because the app wrote them from the attachment it had just added or removed
 * and the query may not show that change yet.
 */
export function countsTrustingRecentCells(ctx: Ctx, project: Project, attachments: Attachment[]): Record<string, number> {
  const counts = attachmentCounts(attachments);
  if (Date.parse(ctx.now) - Date.parse(project.updatedAt) < RECENT_WRITE_MS) {
    for (const [id, cell] of Object.entries(project.cells ?? {})) counts[id] = cell.fc ?? 0;
  }
  return counts;
}

/**
 * The project's active steps: the query result plus, read by id, the steps the project's cells (and `extraIds`) know
 * but the query does not return (it can miss rows created moments ago). A step read by id is left out only when it is
 * archived, gone, or belongs to another project.
 */
export async function withKnownSteps(repo: Repo, project: Project, listed: StoredStep[], extraIds: string[] = []): Promise<StoredStep[]> {
  const have = new Set(listed.map((s) => s.id));
  const unseen = [...new Set([...Object.keys(project.cells ?? {}), ...extraIds])].filter((id) => !have.has(id));
  if (unseen.length === 0) return listed;
  const read = await settleAll(unseen.map((id) => () => repo.steps.get(id)));
  return [...listed, ...read.filter((s): s is StoredStep => !!s && s.projectId === project.id && !s.archived)];
}

/**
 * Steps sharing a stepKey are copies of one step (a create retried while the query did not show the first one). The
 * copy the project uses (in the flow, else in the cells, else the oldest) is kept; untouched copies outside the flow
 * are left out (of the cells, and of the project page). They go to Notion's trash only once one copy is in the flow:
 * until then a create or sync job may still be running and decides itself which copy it keeps (it records its own).
 * Copies someone has changed, or added a file, link or note to (`referenced`), stay: nothing is lost; they show as
 * separate steps.
 */
export function stepCopies(
  project: Pick<Project, "flow" | "cells">,
  steps: StoredStep[],
  referenced: ReadonlySet<string> = new Set(),
): { leaveOut: Set<string>; discard: string[] } {
  const byKey = new Map<string, StoredStep[]>();
  for (const s of steps) {
    if (!s.stepKey || s.archived) continue;
    const group = byKey.get(s.stepKey) ?? [];
    group.push(s);
    byKey.set(s.stepKey, group);
  }
  const leaveOut = new Set<string>();
  const discard: string[] = [];
  const inFlow = (s: StoredStep) => Object.prototype.hasOwnProperty.call(project.flow?.nodes ?? {}, s.id);
  const inCells = (s: StoredStep) => Object.prototype.hasOwnProperty.call(project.cells ?? {}, s.id);
  for (const group of byKey.values()) {
    if (group.length < 2) continue;
    const oldest = [...group].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))[0];
    const placed = group.find(inFlow);
    const keeper = placed ?? group.find(inCells) ?? oldest;
    for (const s of group) {
      if (s === keeper || inFlow(s) || !untouched(s, referenced)) continue;
      leaveOut.add(s.id);
      if (placed) discard.push(s.id);
    }
  }
  return { leaveOut, discard };
}

/** Applies stepCopies: discards (each copy read again by id first; one changed meanwhile stays) and leaves out. */
async function dropStepCopies(ctx: Ctx, project: Project, steps: StoredStep[], referenced: ReadonlySet<string>): Promise<StoredStep[]> {
  const { leaveOut, discard } = stepCopies(project, steps, referenced);
  if (leaveOut.size === 0) return steps;
  const now = await settleAll(discard.map((id) => () => ctx.repo.steps.get(id)));
  for (const s of now) if (s && !untouched(s, referenced)) leaveOut.delete(s.id);
  const still = now.filter((s): s is StoredStep => !!s && untouched(s, referenced)).map((s) => s.id);
  await settleAll(still.map((id) => () => ctx.repo.steps.discard(id)));
  return steps.filter((s) => !leaveOut.has(s.id));
}
