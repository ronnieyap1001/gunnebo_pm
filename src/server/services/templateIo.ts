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
import type { Iso, Milestone, ProjectField } from "@/domain/types";
import type { MilestoneInput, ProjectFieldInput, Repo } from "@/server/repo/types";
import { appendHistory, AppError, EV, LIBRARY_PREFIX, newId, SETTINGS, summaryFor, type Ctx } from "./context";
import {
  BATCH_SIZE,
  finishJob,
  isFinished,
  JOB_LOOKUP,
  jobPause,
  loadJob,
  loadJobForContinue,
  newJob,
  saveJob,
  stepResult,
  type JobBase,
  type JobStepResult,
} from "./jobs";
import { getTemplate, readTemplateRevision, saveTemplateFlow } from "./library";
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
   * When a write of this job last failed with an answer that does not rule out that Notion saved it (a 5xx, a timeout,
   * a crash). The retry may then have created a second copy of a row the query did not show yet, so finalizing waits
   * until COPY_GRACE_MS have passed: by then the copy shows in the query and finalizing moves it to the trash.
   */
  failedAt?: Iso;
  /** Calls that waited for that (see COPY_WAIT_LIMIT). */
  copyWaits?: number;
}

/** How long an import waits after a failed write before it finalizes (longer than Notion's query lag). */
export const COPY_GRACE_MS = 10_000;
/** At most this many calls wait (each pauses JOB_LOOKUP.waitMs), so a server clock that lags never blocks the job. */
export const COPY_WAIT_LIMIT = 8;

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

/**
 * Starts an import job ("replace the template"): validates, plans, and first saves the current template as a
 * History row `template.snapshot` (unless the library is empty). Call continueImport until done.
 */
export async function startImport(
  ctx: Ctx,
  json: unknown,
  opts: { reason: ImportReason },
): Promise<{ total: number; summary: ImportPlan["summary"] }> {
  const existing = await loadJob<ImportJob>(ctx.repo, ctx.opId);
  if (existing?.kind === "import") return { total: existing.total, summary: existing.plan.summary };

  const reason = opts.reason;
  if (reason === "seed" && (await ctx.repo.settings.get(SETTINGS.seedAppliedAt))) {
    throw new AppError("VALIDATION", "The 64 milestones are already loaded. Use “Reset template to seed” in Settings instead.");
  }
  const file = parseTemplateOrThrow(json);
  const [template, fields] = await Promise.all([getTemplate(ctx.repo), listProjectFields(ctx.repo, { includeArchived: true })]);
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
  await saveJob(ctx.repo, job);
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
 * after every batch, also when a write fails part-way, and before finalizing. After a failed write, finalizing waits
 * until COPY_GRACE_MS have passed (see ImportJob.failedAt). Then saves the remapped flow, revision + 1, moves any second
 * copy a crashed batch may have caused to Notion's trash, sets Settings 'seed.appliedAt' when seeding or resetting, and
 * writes History `template.imported` (or `template.seeded`) last.
 */
export async function continueImport(ctx: Ctx, opId: string): Promise<JobStepResult> {
  const job = await loadJobForContinue<ImportJob>(ctx.repo, opId);
  if (!job || job.kind !== "import") throw new AppError("NOT_FOUND", "This import was not found. Start it again.");
  if (isFinished(job)) return stepResult(true, job.total, job.total, "Template updated");
  const { plan } = job;
  let budget = BATCH_SIZE;
  let did = 0;
  const createdMilestones: Record<string, string> = { ...(job.createdMilestones ?? {}) };
  const createdFields: Record<string, string> = { ...(job.createdFields ?? {}) };
  const recordedAtStart = Object.keys(createdMilestones).length + Object.keys(createdFields).length;
  const save = async (doneCount: number) => {
    job.createdMilestones = createdMilestones;
    job.createdFields = createdFields;
    job.doneCount = doneCount;
    job.updatedAt = ctx.now;
    await saveJob(ctx.repo, job);
  };

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
    // "busy" (429) is sure to have written nothing; after anything else the write may have landed.
    if ((e as { code?: unknown } | null)?.code !== "busy") job.failedAt = ctx.now;
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

  if (!finished) {
    await save(progress);
    return stepResult(false, progress, job.total, `Updating the template (${progress} of ${job.total})`);
  }
  if (did > 0 || Object.keys(createdMilestones).length + Object.keys(createdFields).length !== recordedAtStart) {
    // Record what this call wrote before finalizing: if a finalize write fails, the retry must not create it again.
    await save(progress);
  }
  if (job.failedAt && Date.parse(ctx.now) - Date.parse(job.failedAt) < COPY_GRACE_MS && (job.copyWaits ?? 0) < COPY_WAIT_LIMIT) {
    // A failed write may have created a row the query does not show yet: wait until it does (see failedAt).
    job.copyWaits = (job.copyWaits ?? 0) + 1;
    await saveJob(ctx.repo, job);
    await jobPause(JOB_LOOKUP.waitMs);
    return stepResult(false, progress, job.total, "Checking Notion for duplicate rows");
  }

  // 5. Finalize: flow keyed by the recorded milestone ids, revision, History, second copies, seed marker.
  const idMap: Record<string, string> = {};
  for (const c of plan.milestoneCreates) idMap[c.tempId || importTempId(c.data.key)] = createdMilestones[c.data.key] ?? idByKey.get(c.data.key)!;
  await saveTemplateFlow(ctx, remapFlow(plan.flow, idMap));
  const current = await readTemplateRevision(ctx.repo);
  const revision = Math.max(current, job.targetRevision);
  if (revision !== current) await ctx.repo.settings.set(SETTINGS.templateRevision, revision);

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
  await discardImportCopies(ctx, job, milestones, createdMilestones, createdFields);
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
  await finishJob(ctx, job, { revision, did });
  return stepResult(true, job.total, job.total, "Template updated");
}

/**
 * Second copies of milestones and project fields this import created (same key, not the recorded row, same name and
 * type as planned, created since the job started) go to Notion's trash: a retried batch whose query did not show the
 * first copy yet created them.
 */
async function discardImportCopies(
  ctx: Ctx,
  job: ImportJob,
  milestones: Milestone[],
  createdMilestones: Record<string, string>,
  createdFields: Record<string, string>,
): Promise<void> {
  const { plan } = job;
  const since = new Date(Math.floor(Date.parse(job.createdAt) / 60_000) * 60_000).toISOString(); // Notion: minutes only
  const plannedMilestone = new Map(plan.milestoneCreates.map((c) => [c.data.key, c.data]));
  const milestoneCopies = milestones.filter((m) => {
    const planned = plannedMilestone.get(m.key);
    const keep = createdMilestones[m.key];
    return (
      planned && keep && keep !== m.id && !m.archived && m.name === planned.name && m.fieldType === planned.fieldType && m.createdAt >= since
    );
  });
  const plannedField = new Map(plan.projectFieldCreates.map((f) => [f.key, f]));
  const fieldCopies = plannedField.size
    ? (await ctx.repo.projectFields.list({ includeArchived: true })).filter((f) => {
        const planned = plannedField.get(f.key);
        const keep = createdFields[f.key];
        return planned && keep && keep !== f.id && !f.archived && f.label === planned.label && f.fieldType === planned.fieldType;
      })
    : [];
  for (const m of milestoneCopies) await ctx.repo.milestones.discard(m.id);
  for (const f of fieldCopies) await ctx.repo.projectFields.discard(f.id);
}
