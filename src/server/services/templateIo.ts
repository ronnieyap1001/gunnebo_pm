import "server-only";
/**
 * Template file: export, import preview, and the resumable import job used for import, seed and "Reset template to
 * seed". Before an import or reset the current template is saved as a History row `template.snapshot`.
 * Projects change only when they are synced.
 */
import { importTempId, planTemplateImport, type ImportPlan } from "@/domain/importPlan";
import { seedTemplateFile } from "@/domain/seed";
import { remapFlow } from "@/domain/snapshot";
import { exportTemplateFile, parseTemplateFile, type TemplateFile } from "@/domain/templateFile";
import { stableStringify } from "@/domain/syncPlan";
import type { Flow, Iso, Milestone, ProjectField } from "@/domain/types";
import type { MilestoneInput, ProjectFieldInput, Repo } from "@/server/repo/types";
import { appendHistory, AppError, EV, LIBRARY_PREFIX, newId, SETTINGS, summaryFor, type Ctx } from "./context";
import {
  assertJobFits,
  BATCH_SIZE,
  beginJobCall,
  claimJob,
  elsewhereResult,
  finishJob,
  isFinished,
  JOB_LOOKUP,
  JOB_PREFIX,
  jobPause,
  laterOf,
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
  stepResult,
  type JobBase,
  type JobStepResult,
  type JobTombstone,
  type SaveOutcome,
} from "./jobs";
import { getTemplate, readTemplateRevision, saveTemplateFlow } from "./library";
import { settleAll } from "./projects";
import { listProjectFields } from "./projectFields";

export type ImportReason = "import" | "seed" | "reset";

/** The template as a file (archived choices included; archived milestones and arrows left out). */
export async function exportTemplate(repo: Repo, exportedAt: Iso = new Date().toISOString()): Promise<TemplateFile> {
  const [template, fields] = await Promise.all([getTemplate(repo), listProjectFields(repo, { includeArchived: true })]);
  return exportTemplateFile(template, fields, exportedAt);
}

/** Validates a file (object or JSON text). AppError VALIDATION with details.errors (plain English, with paths). */
export function parseTemplateOrThrow(json: unknown): TemplateFile {
  const r = parseTemplateFile(json);
  if (!r.ok) {
    throw new AppError("VALIDATION", `The template file has ${r.errors.length === 1 ? "a problem" : `${r.errors.length} problems`}: ${r.errors.slice(0, 3).join("; ")}${r.errors.length > 3 ? " …" : ""}`, {
      errors: r.errors,
    });
  }
  return r.file;
}

async function planFor(ctx: Ctx, file: TemplateFile, reason: ImportReason): Promise<ImportPlan> {
  const [template, projectFields] = await Promise.all([getTemplate(ctx.repo), listProjectFields(ctx.repo, { includeArchived: true })]);
  const plan = planTemplateImport({ template, projectFields }, file, ctx.now, newId);
  if (reason === "reset") {
    // Reset keeps existing project fields as they are and only adds missing seed fields.
    plan.projectFieldUpdates = [];
    plan.summary.projectFieldsUpdated = [];
  }
  keepFieldLabelsUnique(plan, projectFields);
  return plan;
}

/**
 * An import must not leave two active project fields with the same name (forms and the Projects table could not
 * tell them apart; see assertLabelFree). Where it would, the field that already has the name keeps it and the import
 * gives way: a field it would restore stays archived, a rename is left out, and a new field gets a number ("Region
 * (2)"). Each case is noted in the summary shown before the import.
 */
export function keepFieldLabelsUnique(plan: ImportPlan, current: ProjectField[]): void {
  interface Row {
    label: string;
    archived: boolean;
    oldLabel?: string;
    patch?: Partial<ProjectField>;
    unarchives: boolean;
    renames: boolean;
    createIndex?: number;
  }
  const norm = (label: string) => label.trim().toLowerCase();
  const patchOf = new Map(plan.projectFieldUpdates.map((u) => [u.id, u.patch]));
  const rows: Row[] = current.map((f) => {
    const patch = patchOf.get(f.id);
    const renames = patch?.label !== undefined && patch.label !== f.label;
    const unarchives = f.archived && patch?.archived === false;
    return { label: renames ? patch!.label! : f.label, archived: f.archived && !unarchives, oldLabel: f.label, patch, unarchives, renames };
  });
  plan.projectFieldCreates.forEach((c, i) => rows.push({ label: c.label, archived: false, unarchives: false, renames: false, createIndex: i }));
  const notes: string[] = [];
  for (let round = 0; round < 10; round++) {
    const groups = new Map<string, Row[]>();
    for (const r of rows) {
      if (r.archived) continue;
      const g = groups.get(norm(r.label)) ?? [];
      g.push(r);
      groups.set(norm(r.label), g);
    }
    let gaveWay = false;
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      const untouched = (r: Row) => !r.unarchives && !r.renames && r.createIndex === undefined;
      const keeper = group.find(untouched) ?? group.find((r) => r.createIndex === undefined && !r.unarchives) ?? group[0];
      for (const r of group) {
        if (r === keeper) continue;
        if (r.unarchives) {
          delete r.patch!.archived;
          delete r.patch!.archivedAt;
          r.archived = true;
          r.unarchives = false;
          notes.push(`${r.label} (stays archived: another project field is already called "${keeper.label}")`);
        } else if (r.renames) {
          notes.push(`${r.oldLabel} (not renamed to "${r.label}": another project field is already called "${keeper.label}")`);
          delete r.patch!.label;
          r.label = r.oldLabel!;
          r.renames = false;
        } else if (r.createIndex !== undefined) {
          const taken = new Set(rows.filter((x) => !x.archived).map((x) => norm(x.label)));
          let n = 2;
          while (taken.has(norm(`${r.label} (${n})`))) n++;
          const label = `${r.label} (${n})`;
          const create = plan.projectFieldCreates[r.createIndex];
          const added = plan.summary.projectFieldsAdded.indexOf(create.label);
          if (added >= 0) plan.summary.projectFieldsAdded[added] = label;
          notes.push(`${label} (added under this name: another project field is already called "${keeper.label}")`);
          create.label = label;
          r.label = label;
        } else {
          continue;
        }
        gaveWay = true;
      }
    }
    if (!gaveWay) break;
  }
  if (notes.length === 0) return;
  // A field left with nothing to update is no longer "updated" (its plain entry goes; the note says what happened).
  const emptied = new Set(rows.filter((r) => r.patch && Object.keys(r.patch).length === 0).flatMap((r) => [r.label, r.oldLabel ?? r.label]));
  plan.projectFieldUpdates = plan.projectFieldUpdates.filter((u) => Object.keys(u.patch).length > 0);
  plan.summary.projectFieldsUpdated = plan.summary.projectFieldsUpdated.filter((entry) => !emptied.has(entry));
  plan.summary.projectFieldsUpdated.push(...notes);
}

/** What an import would change (shown before confirming). */
export async function previewImport(ctx: Ctx, json: unknown, opts: { reason?: ImportReason } = {}): Promise<ImportPlan["summary"]> {
  const file = parseTemplateOrThrow(json);
  return (await planFor(ctx, file, opts.reason ?? "import")).summary;
}

/** Patches go through JSON (Settings): `undefined` ("clear this field") is stored as null and restored on apply. */
function encodePatch<T extends object>(patch: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) out[k] = v === undefined ? null : v;
  return out;
}

function decodePatch<T>(patch: Record<string, unknown>): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) out[k] = v === null ? undefined : v;
  return out as Partial<T>;
}

interface StoredImportPlan extends Omit<ImportPlan, "milestoneUpdates" | "projectFieldUpdates"> {
  milestoneUpdates: { id: string; patch: Record<string, unknown> }[];
  projectFieldUpdates: { id: string; patch: Record<string, unknown> }[];
}

export interface ImportJob extends JobBase<"import"> {
  reason: ImportReason;
  plan: StoredImportPlan;
  /** Revision to set at the end (revision at start + 1). */
  targetRevision: number;
  cursor: { updates: number; archives: number; fieldUpdates: number };
  /**
   * Milestone key → id of the milestone this job created, and project field key → id of the field it created. Saved
   * after every batch: the next batch counts them as done instead of looking for them with a query that may not show
   * them yet (and would create them a second time).
   */
  createdMilestones?: Record<string, string>;
  createdFields?: Record<string, string>;
  /**
   * When this job last created a row. A retry whose query did not show a row yet creates it again: finalizing waits
   * until the query shows every recorded row, so a first copy (created earlier) shows too and goes to the trash.
   */
  lastCreateAt?: Iso;
  /**
   * When a write of this job last failed with an answer that does not rule out that Notion saved it (a 5xx, a timeout,
   * a crash): the time of the failure, not of the call's start (a create can fail 20 s into a call). The retry may then
   * have created a second copy of a row the query did not show yet, so finalizing waits until COPY_GRACE_MS have
   * passed: by then the copy shows in the query and finalizing moves it to the trash.
   */
  failedAt?: Iso;
  /** Calls that waited for that (see COPY_WAIT_LIMIT). */
  copyWaits?: number;
}

/** How long an import waits after a failed write (or its latest create) before it finalizes (longer than Notion's query lag). */
export const COPY_GRACE_MS = 10_000;
/** At most this many calls wait, so a server clock that lags never blocks the job. */
export const COPY_WAIT_LIMIT = 8;
/**
 * Another import that saved its job this recently (or holds a lease) counts as running: a new import, seed or reset is
 * refused meanwhile. Older unfinished imports do not block (Setup offers to resume them).
 */
export const IMPORT_RUNNING_MS = 10 * 60_000;

function planTotal(plan: StoredImportPlan): number {
  return (
    plan.milestoneCreates.length +
    plan.milestoneUpdates.length +
    plan.milestoneArchives.length +
    plan.projectFieldCreates.length +
    plan.projectFieldUpdates.length +
    1
  );
}

/** What a finished import keeps of its record (see ImportTombstone). */
interface ImportResult {
  revision?: number;
  did?: number;
  reason?: ImportReason;
  createdMilestones?: Record<string, string>;
  createdFields?: Record<string, string>;
}
type ImportTombstone = JobTombstone<"import"> & { result?: ImportResult };

/**
 * Other import jobs, read again by page id (the list comes from a query that may be stale): the running ones, and
 * those that finished at or after `finishedSince` (only those can have created rows for the keys this job creates).
 */
async function otherImports(ctx: Ctx, opId: string, finishedSince?: Iso): Promise<(ImportJob | ImportTombstone)[]> {
  const all = await ctx.repo.settings.list(JOB_PREFIX);
  const out: (ImportJob | ImportTombstone)[] = [];
  for (const value of Object.values(all)) {
    const j = value as Partial<ImportTombstone> | null;
    if (!j || typeof j !== "object" || j.kind !== "import" || !j.opId || j.opId === opId) continue;
    if (j.status === "done" && (!finishedSince || !j.finishedAt || j.finishedAt < finishedSince)) continue;
    const fresh = await loadJob<ImportJob | ImportTombstone>(ctx.repo, j.opId);
    if (!fresh || fresh.kind !== "import") continue;
    if (isFinished(fresh) && (!finishedSince || fresh.finishedAt < finishedSince)) continue;
    out.push(fresh);
  }
  return out;
}

/** Key → id records of another import (from its job, or what its tombstone kept). */
function recordsOf(j: ImportJob | ImportTombstone): { milestones: Record<string, string>; fields: Record<string, string> } {
  const r = isFinished(j) ? (j as ImportTombstone).result : (j as ImportJob);
  return { milestones: r?.createdMilestones ?? {}, fields: r?.createdFields ?? {} };
}

/** Other imports still running that saved their job recently or hold a lease (a new import waits for them). */
async function runningImports(ctx: Ctx): Promise<ImportJob[]> {
  const now = Date.parse(ctx.now);
  return (await otherImports(ctx, ctx.opId)).filter(
    (j): j is ImportJob =>
      !isFinished(j) && (now - Date.parse(j.updatedAt) < IMPORT_RUNNING_MS || (!!j.lease && Date.parse(j.lease.until) > now)),
  );
}

/** True when a seed job finished before (its tombstone says so). */
async function seedJobFinished(ctx: Ctx): Promise<boolean> {
  const all = await ctx.repo.settings.list(JOB_PREFIX);
  return Object.values(all).some((v) => {
    const j = v as Partial<JobTombstone<"import">> | null;
    return !!j && typeof j === "object" && j.kind === "import" && j.status === "done" && j.result?.reason === "seed";
  });
}

/**
 * Starts an import job ("replace the template"): validates, plans, and first saves the current template as a
 * History row `template.snapshot` (unless the library is empty). Call continueImport until done.
 *
 * Refused while another import, seed or reset is running (two would create the same milestones), and a seed is
 * refused once the template has milestones, the seed marker exists or a seed job finished (each read again, so a
 * second tab or server instance that still shows "Load the 64 milestones" cannot load them twice). A file whose job
 * could outgrow what Notion stores is refused before anything is written.
 */
export async function startImport(
  ctx: Ctx,
  json: unknown,
  opts: { reason: ImportReason },
): Promise<{ total: number; summary: ImportPlan["summary"] }> {
  const existing = await loadJob<ImportJob>(ctx.repo, ctx.opId);
  if (existing?.kind === "import") return { total: existing.total, summary: existing.plan.summary };

  const reason = opts.reason;
  const file = parseTemplateOrThrow(json);
  const [template, fields] = await Promise.all([getTemplate(ctx.repo), listProjectFields(ctx.repo, { includeArchived: true })]);
  if (reason === "seed") {
    const seeded =
      template.milestones.length > 0 ||
      (await ctx.repo.settings.get(SETTINGS.seedAppliedAt, { fresh: true })) !== undefined ||
      (await seedJobFinished(ctx));
    if (seeded) throw new AppError("VALIDATION", "The 64 milestones are already loaded. Use “Reset template to seed” in Settings instead.");
  }
  const running = await runningImports(ctx);
  if (running.length) {
    throw new AppError(
      "CONFLICT",
      reason === "seed" && running.some((j) => j.reason === "seed")
        ? "The 64 milestones are already being loaded, in another tab or window. Wait for it to finish, or continue it in Setup."
        : "Another template import is still running, in another tab or window. Wait for it to finish, or continue it in Setup (Unfinished tasks).",
      { opId: running[0].opId },
    );
  }

  const plan = await planFor(ctx, file, reason);
  const stored: StoredImportPlan = {
    ...plan,
    milestoneUpdates: plan.milestoneUpdates.map((u) => ({ id: u.id, patch: encodePatch(u.patch) })),
    projectFieldUpdates: plan.projectFieldUpdates.map((u) => ({ id: u.id, patch: encodePatch(u.patch) })),
  };
  const job: ImportJob = {
    ...newJob(ctx, "import", planTotal(stored)),
    reason,
    plan: stored,
    targetRevision: template.revision + 1,
    cursor: { updates: 0, archives: 0, fieldUpdates: 0 },
  };
  // The job grows as it records what it creates: refuse up front a file whose job could not be saved to the end.
  assertJobFits(
    {
      ...job,
      createdMilestones: Object.fromEntries(stored.milestoneCreates.map((c) => [c.data.key, SAMPLE_ID])),
      createdFields: Object.fromEntries(stored.projectFieldCreates.map((f) => [f.key, SAMPLE_ID])),
      lastCreateAt: ctx.now,
      failedAt: ctx.now,
      copyWaits: COPY_WAIT_LIMIT,
      lease: SAMPLE_LEASE,
    } as ImportJob,
    "This template file",
  );
  if (template.milestones.length > 0) {
    const snapshot = exportTemplateFile(template, fields, ctx.now);
    await appendHistory(
      ctx,
      {
        type: EV.templateSnapshot,
        source: "SYSTEM",
        summary: summaryFor(LIBRARY_PREFIX, `Template saved before ${reason === "reset" ? "the reset" : "the import"}`),
        data: { reason, revision: template.revision, file: snapshot },
      },
      { opId: `${ctx.opId}:snapshot` },
    );
  }
  await saveJob(ctx.repo, job, { creates: true });
  return { total: job.total, summary: plan.summary };
}

/** Loads the 64 seed milestones and the default project fields through the importer. */
export function startSeed(ctx: Ctx): Promise<{ total: number; summary: ImportPlan["summary"] }> {
  return startImport(ctx, seedTemplateFile(), { reason: "seed" });
}

/** "Reset template to seed": projects are kept; the current template is saved in History first. */
export function startResetTemplate(ctx: Ctx): Promise<{ total: number; summary: ImportPlan["summary"] }> {
  return startImport(ctx, seedTemplateFile(), { reason: "reset" });
}

/**
 * Applies up to 8 items per call: milestone creates (recorded in the job by key; a key Notion already shows counts as
 * done), updates, archives (never deletes), project-field creates (recorded by key) and updates. The job is saved
 * after every batch, also when a write fails part-way, and before finalizing; what another call recorded meanwhile is
 * kept (see saveRunningJob). Before finalizing, every recorded row is read again (one deleted meanwhile is created
 * again), and the job waits until the query shows them all, or until COPY_GRACE_MS after a failed write (see
 * ImportJob.failedAt). Then saves the remapped flow, revision + 1, moves any second copy a crashed batch may have
 * caused to Notion's trash, sets Settings 'seed.appliedAt' when seeding or resetting, and writes History
 * `template.imported` (or `template.seeded`) last.
 *
 * `driver` identifies the browser run (see claimJob): while another run holds the job, the call only reports
 * RUNNING_ELSEWHERE. Finalizing works from the record Notion has, uses a row the template flow already has for a
 * planned milestone (another call or import finalized first), and discards only copies nothing refers to.
 */
export async function continueImport(ctx: Ctx, opId: string, opts: { driver?: string } = {}): Promise<JobStepResult> {
  const call = beginJobCall(ctx, opts.driver);
  const loaded = await loadJobForContinue<ImportJob>(ctx.repo, opId);
  if (!loaded || loaded.kind !== "import") throw new AppError("NOT_FOUND", "This import was not found. Start it again.");
  const claim = await claimJob(call, loaded);
  if (claim.wait) return claim.wait;
  const job = claim.job;
  const doneResult = () => stepResult(true, job.total, job.total, "Template updated");
  if (isFinished(job)) return doneResult();
  const { plan } = job;
  let budget = BATCH_SIZE;
  let did = 0;
  const createdMilestones: Record<string, string> = { ...(job.createdMilestones ?? {}) };
  const createdFields: Record<string, string> = { ...(job.createdFields ?? {}) };
  const recordedAtStart = { milestones: { ...createdMilestones }, fields: { ...createdFields } };
  // Rows this call created (a copy nothing uses goes to the trash at once, see orphansOf) and recorded rows found deleted.
  const made = { milestones: new Set<string>(), fields: new Set<string>() };
  const gone = { milestones: new Set<string>(), fields: new Set<string>() };
  const save = async (doneCount: number): Promise<SaveOutcome> => {
    const lost: string[] = [];
    job.createdMilestones = createdMilestones;
    job.createdFields = createdFields;
    job.doneCount = doneCount;
    job.updatedAt = ctx.now;
    const { outcome, stored } = await saveRunningJob(call, job, (st) => {
      lost.push(...mergeRecord(createdMilestones, st.createdMilestones, gone.milestones));
      lost.push(...mergeRecord(createdFields, st.createdFields, gone.fields));
      job.cursor = {
        updates: Math.max(job.cursor.updates, st.cursor?.updates ?? 0),
        archives: Math.max(job.cursor.archives, st.cursor?.archives ?? 0),
        fieldUpdates: Math.max(job.cursor.fieldUpdates, st.cursor?.fieldUpdates ?? 0),
      };
      job.lastCreateAt = laterOf(job.lastCreateAt, st.lastCreateAt);
      job.failedAt = laterOf(job.failedAt, st.failedAt);
      job.copyWaits = Math.max(job.copyWaits ?? 0, st.copyWaits ?? 0) || undefined;
    });
    if (outcome === "elsewhere" && stored) job.lease = stored.lease;
    const mine = (ids: Set<string>) => orphansOf(outcome, lost, ids);
    const orphans = { milestones: mine(made.milestones), fields: mine(made.fields) };
    if (orphans.milestones.length || orphans.fields.length) {
      // What Notion records now: this job, or the record another call saved or finished it with.
      const rec =
        outcome === "saved" ? recordsOf(job) : stored ? recordsOf(stored as ImportJob | ImportTombstone) : { milestones: {}, fields: {} };
      const protect = new Set([...Object.values(rec.milestones), ...Object.values(rec.fields)]);
      await discardImportCopies(ctx, job, orphans.milestones, orphans.fields, protect);
    }
    made.milestones.clear();
    made.fields.clear();
    return outcome;
  };
  const stopped = (outcome: SaveOutcome): JobStepResult =>
    outcome === "finished" ? doneResult() : elsewhereResult(job, job.lease!, call.now());

  // Recorded creates first; the query adds the milestones that existed before (and anything a crashed batch created).
  const milestones = await ctx.repo.milestones.list({ includeArchived: true });
  const idByKey = new Map<string, string>();
  for (const m of milestones) if (!idByKey.has(m.key) || !m.archived) idByKey.set(m.key, m.id);
  for (const [key, id] of Object.entries(createdMilestones)) idByKey.set(key, id);
  const createdNow = () => plan.milestoneCreates.filter((c) => idByKey.has(c.data.key)).length;
  const fieldKeys = () => plan.projectFieldCreates.filter((f) => createdFields[f.key]).length;
  let fieldsDone = fieldKeys();

  try {
    // 1. Milestone creates.
    for (const c of plan.milestoneCreates) {
      const id = idByKey.get(c.data.key);
      if (id && !createdMilestones[c.data.key]) createdMilestones[c.data.key] = id;
    }
    const toCreate = plan.milestoneCreates.filter((c) => !idByKey.has(c.data.key));
    for (const c of toCreate.slice(0, budget)) {
      const m = await ctx.repo.milestones.create(c.data as MilestoneInput);
      createdMilestones[c.data.key] = m.id;
      idByKey.set(c.data.key, m.id);
      made.milestones.add(m.id);
      job.lastCreateAt = call.now();
      budget--;
      did++;
    }

    // 2. Milestone updates.
    while (budget > 0 && job.cursor.updates < plan.milestoneUpdates.length) {
      const u = plan.milestoneUpdates[job.cursor.updates];
      await ctx.repo.milestones.update(u.id, decodePatch<Milestone>(u.patch) as Partial<MilestoneInput>);
      job.cursor.updates++;
      budget--;
      did++;
    }

    // 3. Archives (skip ones already archived).
    const archivedNow = new Set(milestones.filter((m) => m.archived).map((m) => m.id));
    while (budget > 0 && job.cursor.archives < plan.milestoneArchives.length) {
      const id = plan.milestoneArchives[job.cursor.archives];
      if (!archivedNow.has(id)) {
        await ctx.repo.milestones.update(id, { archived: true, archivedAt: ctx.now });
        budget--;
        did++;
      }
      job.cursor.archives++;
    }

    // 4. Project fields: creates by key, then updates.
    const pendingFields = plan.projectFieldCreates.filter((f) => !createdFields[f.key]);
    if (budget > 0 && pendingFields.length > 0) {
      const fields = await ctx.repo.projectFields.list({ includeArchived: true });
      const seen = new Map<string, string>();
      for (const f of fields as ProjectField[]) if (!seen.has(f.key)) seen.set(f.key, f.id);
      for (const f of pendingFields) {
        const id = seen.get(f.key);
        if (id) {
          createdFields[f.key] = id;
          continue;
        }
        if (budget <= 0) break;
        const created = await ctx.repo.projectFields.create(f as ProjectFieldInput);
        createdFields[f.key] = created.id;
        made.fields.add(created.id);
        job.lastCreateAt = call.now();
        budget--;
        did++;
      }
    }
    fieldsDone = fieldKeys();
    while (budget > 0 && fieldsDone === plan.projectFieldCreates.length && job.cursor.fieldUpdates < plan.projectFieldUpdates.length) {
      const u = plan.projectFieldUpdates[job.cursor.fieldUpdates];
      await ctx.repo.projectFields.update(u.id, decodePatch<ProjectField>(u.patch) as Partial<ProjectFieldInput>);
      job.cursor.fieldUpdates++;
      budget--;
      did++;
    }
  } catch (e) {
    // Keep what was written before the failure, so the retry neither repeats it nor creates it a second time. Only
    // "busy" (429) is sure to have written nothing; after anything else the write may have landed (dated now: a write
    // can fail late in a call, e.g. after the 20 s timeout).
    if ((e as { code?: unknown } | null)?.code !== "busy") job.failedAt = call.now();
    await save(Math.min(job.total - 1, createdNow() + job.cursor.updates + job.cursor.archives + fieldKeys() + job.cursor.fieldUpdates)).catch(
      () => undefined,
    );
    throw e;
  }

  const createsDone = createdNow();
  const allCreated = createsDone === plan.milestoneCreates.length;
  const finished =
    allCreated &&
    job.cursor.updates >= plan.milestoneUpdates.length &&
    job.cursor.archives >= plan.milestoneArchives.length &&
    fieldsDone >= plan.projectFieldCreates.length &&
    job.cursor.fieldUpdates >= plan.projectFieldUpdates.length;
  const progress = Math.min(job.total - 1, createsDone + job.cursor.updates + job.cursor.archives + fieldsDone + job.cursor.fieldUpdates);
  const notYet = (message = `Updating the template (${progress} of ${job.total})`, retryInMs?: number): JobStepResult => ({
    ...stepResult(false, progress, job.total, message),
    ...(retryInMs ? { retryInMs } : {}),
  });

  if (!finished) {
    const outcome = await save(progress);
    return outcome === "saved" ? notYet() : stopped(outcome);
  }
  const changedRecord =
    !sameRecord(createdMilestones, recordedAtStart.milestones) || !sameRecord(createdFields, recordedAtStart.fields);
  if (did > 0 || changedRecord) {
    // Record what this call wrote before finalizing: if a finalize write fails, the retry must not create it again.
    const outcome = await save(progress);
    if (outcome !== "saved") return stopped(outcome);
  }

  // 5. Every recorded row must still exist (another call may have discarded it, or someone deleted it in Notion):
  // forget one that is gone, so the next call finds the row the query shows for its key or creates it again.
  const fieldsNow = await ctx.repo.projectFields.list({ includeArchived: true });
  const listedM = new Set(milestones.map((m) => m.id));
  const listedF = new Set(fieldsNow.map((f) => f.id));
  const unseenM = Object.entries(createdMilestones).filter(([, id]) => !listedM.has(id));
  const unseenF = Object.entries(createdFields).filter(([, id]) => !listedF.has(id));
  const [readM, readF] = await Promise.all([
    settleAll(unseenM.map(([, id]) => () => ctx.repo.milestones.get(id))),
    settleAll(unseenF.map(([, id]) => () => ctx.repo.projectFields.get(id))),
  ]);
  unseenM.forEach(([key, id], i) => {
    if (readM[i]) return;
    delete createdMilestones[key];
    gone.milestones.add(id);
  });
  unseenF.forEach(([key, id], i) => {
    if (readF[i]) return;
    delete createdFields[key];
    gone.fields.add(id);
  });
  if (gone.milestones.size || gone.fields.size) {
    const outcome = await save(Math.max(0, progress - gone.milestones.size - gone.fields.size));
    return outcome === "saved" ? notYet() : stopped(outcome);
  }

  // 6. Finalize from the record Notion has (when another call saved a different one, the next call goes on from it).
  const sameAsStored = (j: ImportJob) => sameRecord(j.createdMilestones, createdMilestones) && sameRecord(j.createdFields, createdFields);
  const before = await recheckJob<ImportJob>(call, opId, sameAsStored);
  if (before !== "same") return before === "finished" ? doneResult() : before === "changed" ? notYet() : before;
  // A milestone the template flow already uses for a planned key wins over the recorded one: another call (or another
  // import) finalized first, and both then keep the same rows.
  const preFlow = await readFlowFresh(ctx.repo);
  const byId = new Map(milestones.map((m) => [m.id, m]));
  const flowUnseen = Object.keys(preFlow.nodes).filter((id) => !byId.has(id));
  (await settleAll(flowUnseen.map((id) => () => ctx.repo.milestones.get(id)))).forEach((m) => {
    if (m) byId.set(m.id, m);
  });
  let adopted = false;
  const fromFlow = new Set<string>();
  for (const c of plan.milestoneCreates) {
    const key = c.data.key;
    const inFlow = Object.keys(preFlow.nodes)
      .map((id) => byId.get(id))
      .find((m) => !!m && m.key === key && !m.archived && matchesPlannedMilestone(m, c.data as MilestoneInput));
    if (!inFlow) continue;
    fromFlow.add(key);
    if (inFlow.id !== createdMilestones[key]) {
      createdMilestones[key] = inFlow.id;
      adopted = true;
    }
  }
  // Likewise a row an older import (started before this one) recorded for a planned key, exactly as this plan creates
  // it: two imports of the same file that overlapped then keep the same rows, even when this server instance does not
  // see the other's template flow yet.
  const older = (await otherImports(ctx, opId, job.createdAt))
    .filter((o) => o.createdAt < job.createdAt || (o.createdAt === job.createdAt && o.opId < job.opId))
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.opId < b.opId ? -1 : 1));
  if (older.length) {
    const fieldById = new Map(fieldsNow.map((f) => [f.id, f]));
    const fieldFrom = new Set<string>();
    for (const o of older) {
      const r = recordsOf(o);
      for (const c of plan.milestoneCreates) {
        const key = c.data.key;
        const id = r.milestones[key];
        if (!id || fromFlow.has(key) || id === createdMilestones[key]) continue;
        const m = byId.get(id) ?? (await ctx.repo.milestones.get(id));
        if (!m || !matchesPlannedMilestone(m, c.data as MilestoneInput)) continue;
        byId.set(m.id, m);
        createdMilestones[key] = m.id;
        fromFlow.add(key);
        adopted = true;
      }
      for (const f of plan.projectFieldCreates) {
        const id = r.fields[f.key];
        if (!id || fieldFrom.has(f.key) || id === createdFields[f.key]) continue;
        const row = fieldById.get(id) ?? (await ctx.repo.projectFields.get(id));
        if (!row || !matchesPlannedField(row, f as ProjectFieldInput)) continue;
        fieldById.set(row.id, row);
        createdFields[f.key] = row.id;
        fieldFrom.add(f.key);
        adopted = true;
      }
    }
  }
  if (adopted) {
    // No merge here: Notion had exactly this call's record a moment ago, and the adopted rows must replace it.
    job.createdMilestones = createdMilestones;
    job.createdFields = createdFields;
    const { outcome } = await saveRunningJob(call, job);
    if (outcome !== "saved") return stopped(outcome);
  }

  // 7. The flow keyed by the recorded milestone ids, and revision + 1. Read back: when another import wrote its flow
  // over it meanwhile, the next call adopts that one's milestones and writes again.
  const idMap: Record<string, string> = {};
  for (const c of plan.milestoneCreates) idMap[c.tempId || importTempId(c.data.key)] = createdMilestones[c.data.key] ?? idByKey.get(c.data.key)!;
  const flow = remapFlow(plan.flow, idMap);
  // Written once: a call that comes back after waiting (below) keeps the positions someone moved meanwhile.
  if (!sameNodes(preFlow, flow)) await saveTemplateFlow(ctx, flow);
  const postFlow = sameNodes(preFlow, flow) ? preFlow : await readFlowFresh(ctx.repo);
  if (!sameNodes(postFlow, flow)) return notYet();
  const current = await readTemplateRevision(ctx.repo);
  const revision = Math.max(current, job.targetRevision);
  if (revision !== current) await ctx.repo.settings.set(SETTINGS.templateRevision, revision);

  // 8. A retry whose query did not show a row yet created it again: before discarding copies, wait until the query
  // shows every recorded row, so an earlier copy (created before them) shows too. After a failed write, wait out
  // COPY_GRACE_MS (the failed write may have saved a row nothing recorded). The flow above already uses the recorded
  // rows; the waiting calls only finish the job.
  const nowMs = Date.parse(ctx.now);
  const failedRecently = !!job.failedAt && nowMs - Date.parse(job.failedAt) < COPY_GRACE_MS;
  const createdRecently = !!job.lastCreateAt && nowMs - Date.parse(job.lastCreateAt) < COPY_GRACE_MS;
  const hidden = unseenM.length + unseenF.length > 0;
  if ((failedRecently || (createdRecently && hidden)) && (job.copyWaits ?? 0) < COPY_WAIT_LIMIT) {
    job.copyWaits = (job.copyWaits ?? 0) + 1;
    const outcome = await save(progress);
    if (outcome !== "saved") return stopped(outcome);
    if (failedRecently) await jobPause(JOB_LOOKUP.waitMs);
    return notYet("Checking Notion for duplicate rows", failedRecently ? undefined : JOB_LOOKUP.waitMs);
  }

  // 9. Second copies, the seed marker, then History and the tombstone.
  const s = plan.summary;
  const parts = [
    s.added.length ? `${s.added.length} added` : "",
    s.updated.length ? `${s.updated.length} updated` : "",
    s.archived.length ? `${s.archived.length} archived` : "",
    s.edgesAdded || s.edgesRemoved ? `arrows +${s.edgesAdded} −${s.edgesRemoved}` : "",
  ].filter(Boolean);
  const seeded = job.reason === "seed";
  // Every other finalize write comes before the History row, which only the tombstone follows: a failure before the
  // row leaves nothing for the retry to log twice. (Only a failure of the row itself or of the tombstone still can:
  // the check before appending is a query that may not show the row yet.)
  const after = await recheckJob<ImportJob>(call, opId, sameAsStored);
  if (after === "finished") return doneResult();
  if (after !== "same") return after === "changed" ? notYet() : after;
  const kept = new Set([...Object.values(createdMilestones), ...Object.values(createdFields)]);
  const protect = new Set([...kept, ...Object.keys(preFlow.nodes), ...Object.keys(postFlow.nodes)]);
  await discardImportCopies(ctx, job, copiesOf(job, milestones, createdMilestones), fieldCopiesOf(job, fieldsNow, createdFields), protect);
  if (job.reason !== "import") await ctx.repo.settings.set(SETTINGS.seedAppliedAt, ctx.now);
  await appendHistory(
    ctx,
    {
      type: seeded ? EV.templateSeeded : EV.templateImported,
      source: "SYSTEM",
      summary: summaryFor(
        LIBRARY_PREFIX,
        `${seeded ? "Loaded the seed template" : job.reason === "reset" ? "Template reset to the seed" : "Template imported"}${parts.length ? ` (${parts.join(", ")})` : ""}`,
      ),
      data: { reason: job.reason, summary: s, revision },
    },
    { opId: job.opId },
  );
  // The tombstone keeps the record: an import that overlapped this one must not discard these rows (see discardImportCopies).
  const result: ImportResult = { revision, did, reason: job.reason, createdMilestones, createdFields };
  await finishJob(ctx, job, result as Record<string, unknown>);
  return doneResult();
}

/** The template flow as Notion has it now (the Settings row read again by its page id). */
async function readFlowFresh(repo: Repo): Promise<Flow> {
  const flow = await repo.settings.get<Flow>(SETTINGS.templateFlow, { fresh: true });
  if (!flow || typeof flow !== "object") return { nodes: {}, edges: [] };
  return { nodes: { ...(flow.nodes ?? {}) }, edges: [...(flow.edges ?? [])] };
}

/** Same milestones and arrows (positions aside). */
function sameNodes(a: Flow, b: Flow): boolean {
  const ids = (f: Flow) => Object.keys(f.nodes).sort().join(",");
  const edges = (f: Flow) => f.edges.map((e) => `${e.id}:${e.from}>${e.to}:${e.archivedAt ?? ""}`).sort().join(",");
  return ids(a) === ids(b) && edges(a) === edges(b);
}

/** A milestone still exactly as the plan creates it (nobody renamed, re-described, reordered or re-typed it). */
function matchesPlannedMilestone(m: Milestone, planned: MilestoneInput): boolean {
  return (
    !m.archived &&
    m.name === planned.name &&
    m.fieldType === planned.fieldType &&
    (m.description ?? "") === (planned.description ?? "") &&
    stableStringify(m.choices ?? []) === stableStringify(planned.choices ?? []) &&
    stableStringify(m.config ?? {}) === stableStringify(planned.config ?? {}) &&
    m.order === planned.order
  );
}

/** A project field still exactly as the plan creates it. */
function matchesPlannedField(f: ProjectField, planned: ProjectFieldInput): boolean {
  return (
    !f.archived &&
    f.label === planned.label &&
    f.fieldType === planned.fieldType &&
    stableStringify(f.choices ?? []) === stableStringify(planned.choices ?? []) &&
    stableStringify(f.config ?? {}) === stableStringify(planned.config ?? {}) &&
    !!f.showInSummary === !!planned.showInSummary &&
    (f.systemKey ?? null) === (planned.systemKey ?? null) &&
    f.order === planned.order
  );
}

/**
 * Second copies of milestones this import planned (same key, not the recorded row, created since the job started):
 * a retried batch whose query did not show the first copy yet created them.
 */
function copiesOf(job: ImportJob, milestones: Milestone[], recorded: Record<string, string>): string[] {
  const since = new Date(Math.floor(Date.parse(job.createdAt) / 60_000) * 60_000).toISOString(); // Notion: minutes only
  const planned = new Set(job.plan.milestoneCreates.map((c) => c.data.key));
  return milestones.filter((m) => planned.has(m.key) && recorded[m.key] !== m.id && !m.archived && m.createdAt >= since).map((m) => m.id);
}

/** The same for project fields (a field with a key the plan creates did not exist when the job was planned). */
function fieldCopiesOf(job: ImportJob, fields: ProjectField[], recorded: Record<string, string>): string[] {
  const planned = new Set(job.plan.projectFieldCreates.map((f) => f.key));
  return fields.filter((f) => planned.has(f.key) && recorded[f.key] !== f.id && !f.archived).map((f) => f.id);
}

/**
 * Moves second copies of milestones and project fields to Notion's trash, when nothing refers to them: not `protect`
 * (this job's record), not the template flow as Notion has it now, not the record of another import that is still
 * running or finished after this one started, no project's
 * details (fields), and still exactly as this job's plan creates them (each read again by id first). Rows another
 * import created, or that someone changed, therefore stay.
 */
async function discardImportCopies(
  ctx: Ctx,
  job: ImportJob,
  milestoneIds: string[],
  fieldIds: string[],
  protect: ReadonlySet<string>,
): Promise<void> {
  let m = [...new Set(milestoneIds)].filter((id) => !protect.has(id));
  let f = [...new Set(fieldIds)].filter((id) => !protect.has(id));
  if (m.length === 0 && f.length === 0) return;
  const others = new Set(Object.keys((await readFlowFresh(ctx.repo)).nodes));
  for (const j of await otherImports(ctx, job.opId, job.createdAt)) {
    const r = recordsOf(j);
    for (const id of [...Object.values(r.milestones), ...Object.values(r.fields)]) others.add(id);
  }
  m = m.filter((id) => !others.has(id));
  f = f.filter((id) => !others.has(id));
  if (f.length) {
    const used = new Set((await ctx.repo.projects.list({ includeArchived: true })).flatMap((p) => Object.keys(p.details ?? {})));
    f = f.filter((id) => !used.has(id));
  }
  const plannedMilestone = new Map(job.plan.milestoneCreates.map((c) => [c.data.key, c.data as MilestoneInput]));
  const plannedField = new Map(job.plan.projectFieldCreates.map((x) => [x.key, x as ProjectFieldInput]));
  const [nowM, nowF] = await Promise.all([
    settleAll(m.map((id) => () => ctx.repo.milestones.get(id))),
    settleAll(f.map((id) => () => ctx.repo.projectFields.get(id))),
  ]);
  for (const row of nowM) {
    const planned = row ? plannedMilestone.get(row.key) : undefined;
    if (row && planned && matchesPlannedMilestone(row, planned)) await ctx.repo.milestones.discard(row.id);
  }
  for (const row of nowF) {
    const planned = row ? plannedField.get(row.key) : undefined;
    if (row && planned && matchesPlannedField(row, planned)) await ctx.repo.projectFields.discard(row.id);
  }
}
