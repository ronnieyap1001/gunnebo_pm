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
  loadJob,
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
  return plan;
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
}

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
 * Applies up to 8 items per call: milestone creates (idempotent by key), updates, archives (never deletes),
 * project-field creates (by key) and updates. Then saves the remapped flow, revision + 1, History
 * `template.imported` (or `template.seeded`), Settings 'seed.appliedAt' when seeding or resetting.
 */
export async function continueImport(ctx: Ctx, opId: string): Promise<JobStepResult> {
  const job = await loadJob<ImportJob>(ctx.repo, opId);
  if (!job || job.kind !== "import") throw new AppError("NOT_FOUND", "This import was not found. Start it again.");
  if (isFinished(job)) return stepResult(true, job.total, job.total, "Template updated");
  const { plan } = job;
  let budget = BATCH_SIZE;
  let did = 0;

  // 1. Milestone creates, idempotent by key.
  const milestones = await ctx.repo.milestones.list({ includeArchived: true });
  const idByKey = new Map<string, string>();
  for (const m of milestones) if (!idByKey.has(m.key) || !m.archived) idByKey.set(m.key, m.id);
  const toCreate = plan.milestoneCreates.filter((c) => !idByKey.has(c.data.key));
  for (const c of toCreate.slice(0, budget)) {
    const m = await ctx.repo.milestones.create(c.data as MilestoneInput);
    idByKey.set(m.key, m.id);
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
  let fieldsDone = 0;
  if (budget > 0 && plan.projectFieldCreates.length > 0) {
    const fields = await ctx.repo.projectFields.list({ includeArchived: true });
    const keys = new Set(fields.map((f: ProjectField) => f.key));
    for (const f of plan.projectFieldCreates) {
      if (keys.has(f.key)) {
        fieldsDone++;
        continue;
      }
      if (budget <= 0) break;
      await ctx.repo.projectFields.create(f as ProjectFieldInput);
      keys.add(f.key);
      fieldsDone++;
      budget--;
      did++;
    }
  }
  while (budget > 0 && fieldsDone === plan.projectFieldCreates.length && job.cursor.fieldUpdates < plan.projectFieldUpdates.length) {
    const u = plan.projectFieldUpdates[job.cursor.fieldUpdates];
    await ctx.repo.projectFields.update(u.id, decodePatch<ProjectField>(u.patch) as Partial<ProjectFieldInput>);
    job.cursor.fieldUpdates++;
    budget--;
    did++;
  }

  const createsDone = plan.milestoneCreates.filter((c) => idByKey.has(c.data.key)).length;
  const allCreated = createsDone === plan.milestoneCreates.length;
  const finished =
    allCreated &&
    job.cursor.updates >= plan.milestoneUpdates.length &&
    job.cursor.archives >= plan.milestoneArchives.length &&
    fieldsDone >= plan.projectFieldCreates.length &&
    job.cursor.fieldUpdates >= plan.projectFieldUpdates.length;
  const progress = Math.min(job.total - 1, createsDone + job.cursor.updates + job.cursor.archives + fieldsDone + job.cursor.fieldUpdates);

  if (!finished) {
    job.doneCount = progress;
    job.updatedAt = ctx.now;
    await saveJob(ctx.repo, job);
    return stepResult(false, progress, job.total, `Updating the template (${progress} of ${job.total})`);
  }

  // 5. Finalize: flow keyed by milestone ids, revision, History, seed marker.
  const idMap: Record<string, string> = {};
  for (const c of plan.milestoneCreates) idMap[c.tempId || importTempId(c.data.key)] = idByKey.get(c.data.key)!;
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
  if (job.reason !== "import") await ctx.repo.settings.set(SETTINGS.seedAppliedAt, ctx.now);
  await finishJob(ctx, job, { revision, did });
  return stepResult(true, job.total, job.total, "Template updated");
}
