import "server-only";
/**
 * Projects: create (resumable job copying the template), edit details, archive/restore, reconcile mirrors.
 */
import { formatValue } from "@/domain/format";
import { buildProjectSnapshot, remapFlow, type StepDraft } from "@/domain/snapshot";
import { stableStringify } from "@/domain/syncPlan";
import {
  PROJECT_STATUSES,
  type Choice,
  type DropdownValue,
  type MultipleValue,
  type Project,
  type ProjectField,
  type ProjectStatus,
  type Value,
} from "@/domain/types";
import { normalizeValue } from "@/domain/values";
import type { ProjectInput, Repo, StepInput, StoredStep } from "@/server/repo/types";
import {
  alreadyLogged,
  appendHistory,
  AppError,
  EV,
  notFound,
  requireName,
  summaryFor,
  type Ctx,
} from "./context";
import {
  BATCH_SIZE,
  finishJob,
  isFinished,
  loadJob,
  newJob,
  saveJob,
  stepResult,
  type JobBase,
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
  await saveJob(ctx.repo, job);

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
 * Creates up to 8 missing steps per call (stepKey = `<projectId>:<tempId>`, so a resumed batch never duplicates).
 * When all exist: remaps the flow to step ids, builds cells, sets setup READY and progress, writes ONE History row
 * `project.created` { revision, nodeCount, edgeCount } and clears the job. Calling again after done is a no-op.
 */
export async function continueCreateProject(ctx: Ctx, opId: string): Promise<CreateProgress> {
  const job = await loadJob<CreateProjectJob>(ctx.repo, opId);
  if (!job || job.kind !== "createProject") throw new AppError("NOT_FOUND", "This project setup was not found. Start again.");
  if (isFinished(job)) {
    return { ...stepResult(true, job.total, job.total, "Project ready"), projectId: job.projectId ?? "", created: job.total };
  }
  const project = job.projectId ? await requireProject(ctx.repo, job.projectId) : await adoptOrCreateProject(ctx, job);
  const projectId = project.id;
  const total = job.drafts.length;

  const existing = await ctx.repo.steps.listByProject(projectId, { includeArchived: true });
  const byKey = new Map(existing.map((s) => [s.stepKey, s]));
  const missing = job.drafts.filter((d) => !byKey.has(stepKeyOf(projectId, d.tempId)));
  const batch = missing.slice(0, BATCH_SIZE);

  const created = await settleAll(
    batch.map((d) => {
      const { tempId, ...rest } = d;
      const input: StepInput = { ...rest, projectId, stepKey: stepKeyOf(projectId, tempId), lastOp: job.opId };
      return () => ctx.repo.steps.create(input);
    }),
  );
  for (const s of created) byKey.set(s.stepKey, s);

  const have = job.drafts.filter((d) => byKey.has(stepKeyOf(projectId, d.tempId))).length;
  if (have < total) {
    return { ...stepResult(false, have, total, `Copied ${have} of ${total} milestones`), projectId, created: have };
  }

  // All steps exist: finalize.
  const idMap: Record<string, string> = {};
  const steps: StoredStep[] = [];
  for (const d of job.drafts) {
    const s = byKey.get(stepKeyOf(projectId, d.tempId))!;
    idMap[d.tempId] = s.id;
    steps.push(s);
  }
  const fresh = await requireProject(ctx.repo, projectId);
  const flow = remapFlow(fresh.flow, idMap);
  const cells = buildCells(steps, {});
  const progress = progressOfCells(cells, ctx.day).pct;
  // READY is written together with the remapped flow and the cells, so a READY project was finalized already (a
  // resumed call only completes the History row and the job). Rewriting it would drop changes made since.
  if (fresh.setup !== "READY") {
    await ctx.repo.projects.update(projectId, {
      flow,
      cells,
      progress,
      setup: "READY",
      mirrors: { current: currentMirror(cells, flow, ctx.day) },
    });
  }
  const edgeCount = flow.edges.filter((e) => !e.archivedAt).length;
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
  return { ...stepResult(true, total, total, "Project ready"), projectId, created: total };
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
  if (await alreadyLogged(ctx)) return { project: p, changes: [] };

  const project = await ctx.repo.projects.update(id, update);
  const codeChanged = update.code !== undefined;
  await appendHistory(ctx, {
    type: codeChanged ? EV.projectCodeChanged : EV.projectUpdated,
    summary: summaryFor(project.code, changes.map((c) => `${c.label}: ${c.old} → ${c.new}`).join("; ")),
    projectId: id,
    data: { changes, ...(codeChanged ? { oldCode: p.code, newCode: project.code } : {}) },
  });
  return { project, changes };
}

export async function archiveProject(ctx: Ctx, id: string): Promise<Project> {
  const p = await requireProject(ctx.repo, id);
  if (p.archived) return p;
  const project = await ctx.repo.projects.update(id, { archived: true, archivedAt: ctx.now });
  await appendHistory(ctx, {
    type: EV.projectArchived,
    summary: summaryFor(p.code, "Project archived"),
    projectId: id,
    data: { code: p.code, name: p.name },
  });
  return project;
}

export async function restoreProject(ctx: Ctx, id: string): Promise<Project> {
  const p = await requireProject(ctx.repo, id);
  if (!p.archived) return p;
  const project = await ctx.repo.projects.update(id, { archived: false, archivedAt: undefined });
  await appendHistory(ctx, {
    type: EV.projectRestored,
    summary: summaryFor(p.code, "Project restored"),
    projectId: id,
    data: { code: p.code, name: p.name },
  });
  return project;
}

/**
 * Recomputes Cells and Progress from all steps (+ attachment counts) and PATCHes the project only when they
 * differ. Called after the project page renders and by "Repair mirrors". No History.
 */
export async function reconcileProject(ctx: Ctx, projectId: string): Promise<{ changed: boolean }> {
  const [project, steps, attachments] = await Promise.all([
    requireProject(ctx.repo, projectId),
    ctx.repo.steps.listByProject(projectId),
    ctx.repo.attachments.listByProject(projectId),
  ]);
  if (project.setup !== "READY") return { changed: false };
  const cells = buildCells(steps, attachmentCounts(attachments));
  const progress = progressOfCells(cells, ctx.day).pct;
  if (cellsEqual(cells, project.cells ?? {}) && progress === project.progress) return { changed: false };
  await ctx.repo.projects.update(projectId, { cells, progress, mirrors: { current: currentMirror(cells, project.flow, ctx.day) } });
  return { changed: true };
}
