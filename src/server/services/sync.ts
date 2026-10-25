import "server-only";
/**
 * Sync from template. previewSync plans from fresh state (pure planSync); startSync re-plans and applies the
 * selection (applySync) into a job; continueSync writes the job in batches and finalizes with ONE History row.
 * Values are never changed except by a lossless type conversion.
 */
import { remapFlow } from "@/domain/snapshot";
import {
  applySync,
  changeHashOf,
  dismissKeyOf,
  planSync,
  type SyncApplyResult,
  type SyncItem,
  type SyncProjectInput,
} from "@/domain/syncPlan";
import type { Project, Step, Template } from "@/domain/types";
import type { Repo, StepInput, StoredStep } from "@/server/repo/types";
import { appendHistory, AppError, EV, newId, summaryFor, type Ctx } from "./context";
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
import { attachmentCounts, buildCells, currentMirror, progressOfCells, stepMirrorsOf, stepState } from "./mirrors";
import { requireProject, settleAll, stepKeyOf } from "./projects";

export interface SyncPreviewItem extends SyncItem {
  /** Declined earlier for exactly this change (Project.syncDismissed); shown unticked and not counted as pending. */
  dismissed: boolean;
}

export interface SyncPreview {
  projectId: string;
  items: SyncPreviewItem[];
  warnings: string[];
  templateRevision: number;
  /** The revision the project was last synced to. */
  projectRevision: number;
  /** Selectable items not declined before ("n template changes pending"). */
  pendingCount: number;
}

export function isDismissedItem(itemId: string, dismissed: Record<string, string>): boolean {
  return dismissed?.[dismissKeyOf(itemId)] === changeHashOf(itemId) || Object.prototype.hasOwnProperty.call(dismissed ?? {}, itemId);
}

export function syncInputOf(project: Project, steps: Step[], counts: Record<string, number>): SyncProjectInput {
  return { steps, flow: project.flow, dismissed: project.syncDismissed ?? {}, attachmentCounts: counts };
}

/** Plan + dismissed flags + pending count (pure; shared by previewSync and the project page query). */
export function decoratePlan(
  template: Template,
  project: Project,
  steps: Step[],
  counts: Record<string, number>,
  day: Ctx["day"],
): SyncPreview {
  const plan = planSync(template, syncInputOf(project, steps, counts), day);
  const dismissed = project.syncDismissed ?? {};
  const items = plan.items.map((i) => ({ ...i, dismissed: isDismissedItem(i.id, dismissed) }));
  return {
    projectId: project.id,
    items,
    warnings: plan.warnings,
    templateRevision: template.revision,
    projectRevision: project.templateRevision,
    pendingCount: items.filter((i) => i.selectable && !i.dismissed).length,
  };
}

async function loadInput(repo: Repo, projectId: string) {
  const [project, steps, attachments, template] = await Promise.all([
    requireProject(repo, projectId),
    repo.steps.listByProject(projectId, { includeArchived: true }),
    repo.attachments.listByProject(projectId),
    getTemplate(repo),
  ]);
  return { project, steps, counts: attachmentCounts(attachments), template };
}

/** The sync plan for a project, from fresh state, with the template revision. */
export async function previewSync(ctx: Ctx, projectId: string): Promise<SyncPreview> {
  const { project, steps, counts, template } = await loadInput(ctx.repo, projectId);
  return decoratePlan(template, project, steps, counts, ctx.day);
}

export interface SyncJob extends JobBase<"sync"> {
  projectId: string;
  result: SyncApplyResult;
  /** Unticked items: '<kind>:<key>' -> change hash, merged into Project.syncDismissed at the end. */
  unselected: Record<string, string>;
  templateRevision: number;
}

export interface StartSyncInput {
  projectId: string;
  selectedIds: string[];
  /** Store unticked items as declined (default true). "Sync all active" passes false. */
  dismissUnselected?: boolean;
}

/**
 * Re-plans from fresh state and applies the selection (STALE_PLAN when a selected item is no longer in the plan;
 * the UI reopens the preview). Stores job `job:<opId>`; call continueSync until done.
 */
export async function startSync(ctx: Ctx, input: StartSyncInput): Promise<{ total: number }> {
  const existing = await loadJob<SyncJob>(ctx.repo, ctx.opId);
  if (existing?.kind === "sync") return { total: existing.total };

  const { project, steps, counts, template } = await loadInput(ctx.repo, input.projectId);
  if (project.archived) throw new AppError("VALIDATION", `${project.code} is archived. Restore it first.`);
  if (project.setup !== "READY") throw new AppError("BUSY", "This project is still being set up. Try again in a moment.");
  const syncInput = syncInputOf(project, steps, counts);
  const selected = [...new Set(input.selectedIds ?? [])];
  const applied = applySync(template, syncInput, selected, ctx.day, ctx.now, newId);
  if (!applied.ok) {
    throw new AppError("STALE_PLAN", "The template or the project changed since the preview was opened. Review the changes again.", {
      missingIds: applied.missingIds,
    });
  }
  const unselected: Record<string, string> = {};
  if (input.dismissUnselected !== false) {
    const chosen = new Set(selected);
    for (const item of planSync(template, syncInput, ctx.day).items) {
      if (item.selectable && !chosen.has(item.id)) unselected[dismissKeyOf(item.id)] = changeHashOf(item.id);
    }
  }
  const result = applied.result;
  const total = result.newSteps.length + result.stepPatches.length + 1;
  const job: SyncJob = {
    ...newJob(ctx, "sync", total),
    projectId: project.id,
    result,
    unselected,
    templateRevision: template.revision,
  };
  await saveJob(ctx.repo, job);
  return { total };
}

/** "Sync all active projects": the default-ticked items only, nothing stored as declined. */
export async function startSyncDefaults(ctx: Ctx, projectId: string): Promise<{ total: number; itemCount: number }> {
  const preview = await previewSync(ctx, projectId);
  const ids = preview.items.filter((i) => i.selectable && i.defaultChecked).map((i) => i.id);
  const { total } = await startSync(ctx, { projectId, selectedIds: ids, dismissUnselected: false });
  return { total, itemCount: ids.length };
}

export interface SyncProgress extends JobStepResult {
  projectId: string;
  /** Item ids applied (when done). */
  appliedItemIds?: string[];
}

/**
 * Creates new steps (≤ 8 per call, idempotent by stepKey), applies step patches (≤ 8 per call, skipped when
 * lastOp === opId), then finalizes: remapped flow, cells rebuilt from fresh steps, templateRevision, unticked items
 * merged into syncDismissed, ONE History row `project.synced`, job cleared.
 */
export async function continueSync(ctx: Ctx, opId: string): Promise<SyncProgress> {
  const job = await loadJob<SyncJob>(ctx.repo, opId);
  if (!job || job.kind !== "sync") throw new AppError("NOT_FOUND", "This sync was not found. Open the preview again.");
  if (isFinished(job)) {
    return { ...stepResult(true, job.total, job.total, "Sync finished"), projectId: job.projectId ?? "" };
  }
  const projectId = job.projectId;
  const { result } = job;
  const total = job.total;

  const all = await ctx.repo.steps.listByProject(projectId, { includeArchived: true });
  const byKey = new Map(all.map((s) => [s.stepKey, s]));
  const byId = new Map(all.map((s) => [s.id, s]));
  let budget = BATCH_SIZE;

  // 1. New steps.
  const toCreate = result.newSteps.filter((d) => !byKey.has(stepKeyOf(projectId, d.tempId)));
  const createBatch = toCreate.slice(0, budget);
  const created = await settleAll(
    createBatch.map((d) => () => {
      const { tempId, ...rest } = d;
      const input: StepInput = { ...rest, projectId, stepKey: stepKeyOf(projectId, tempId), lastOp: job.opId };
      return ctx.repo.steps.create(input);
    }),
  );
  for (const s of created) {
    byKey.set(s.stepKey, s);
    byId.set(s.id, s);
  }
  budget -= createBatch.length;
  const doneSoFar = () =>
    result.newSteps.filter((d) => byKey.has(stepKeyOf(projectId, d.tempId))).length +
    result.stepPatches.filter((p) => byId.get(p.stepId)?.lastOp === job.opId).length;
  if (toCreate.length > createBatch.length) {
    return { ...stepResult(false, doneSoFar(), total, `Adding milestones (${doneSoFar()} of ${total})`), projectId };
  }

  // 2. Step patches.
  const attachments = await ctx.repo.attachments.listByProject(projectId);
  const counts = attachmentCounts(attachments);
  const pending = result.stepPatches.filter((p) => {
    const s = byId.get(p.stepId);
    return s && s.lastOp !== job.opId;
  });
  const patchBatch = pending.slice(0, budget);
  const patched = await settleAll(
    patchBatch.map((p) => () => {
      const s = byId.get(p.stepId)!;
      const patch: Partial<StepInput> = { ...(p.patch as Partial<StepInput>), rev: s.rev + 1, lastOp: job.opId };
      const count = counts[s.id] ?? 0;
      if (stepState(s, count, ctx.day).state !== stepState({ ...s, ...patch } as Step, count, ctx.day).state) {
        patch.stateChangedAt = ctx.now;
      }
      patch.mirrors = stepMirrorsOf({ ...s, ...patch } as Step, count, ctx.day);
      return ctx.repo.steps.update(s.id, patch);
    }),
  );
  for (const s of patched) byId.set(s.id, s);
  if (pending.length > patchBatch.length) {
    return { ...stepResult(false, doneSoFar(), total, `Updating milestones (${doneSoFar()} of ${total})`), projectId };
  }

  // 3. Finalize.
  const project = await requireProject(ctx.repo, projectId);
  const idMap: Record<string, string> = {};
  for (const d of result.newSteps) {
    const s = byKey.get(stepKeyOf(projectId, d.tempId));
    if (s) idMap[d.tempId] = s.id;
  }
  const flow = remapFlow(result.flow, idMap);
  const steps: StoredStep[] = [...byId.values()];
  const cells = buildCells(steps, counts);
  const progress = progressOfCells(cells, ctx.day).pct;
  const dismissed = { ...(project.syncDismissed ?? {}) };
  for (const id of result.appliedItemIds) delete dismissed[dismissKeyOf(id)];
  Object.assign(dismissed, job.unselected);
  await ctx.repo.projects.update(projectId, {
    flow,
    cells,
    progress,
    templateRevision: Math.max(project.templateRevision ?? 0, job.templateRevision),
    syncDismissed: dismissed,
    mirrors: { current: currentMirror(cells, flow, ctx.day) },
  });

  const n = result.appliedItemIds.length;
  const declined = Object.keys(job.unselected);
  if (n > 0 || declined.length > 0) {
    await appendHistory(
      ctx,
      {
        type: EV.projectSynced,
        source: "SYSTEM",
        summary: summaryFor(project.code, `Synced from template (${n} change${n === 1 ? "" : "s"})`),
        projectId,
        data: {
          summary: result.summary,
          appliedItemIds: result.appliedItemIds,
          declinedItemKeys: declined,
          templateRevision: job.templateRevision,
          addedStepIds: Object.values(idMap),
        },
      },
      { opId: job.opId },
    );
  }
  await finishJob(ctx, job, { projectId, appliedItemIds: result.appliedItemIds });
  return { ...stepResult(true, total, total, "Sync finished"), projectId, appliedItemIds: result.appliedItemIds };
}

export interface SyncTarget {
  projectId: string;
  code: string;
  name: string;
  /** Fast path: the project was last synced to an older revision. */
  templateChanged: boolean;
}

/** Active, ready projects for "Sync all active projects" (the browser then drives each one). */
export async function listSyncTargets(repo: Repo): Promise<SyncTarget[]> {
  const [projects, template] = await Promise.all([repo.projects.list(), getTemplate(repo)]);
  return projects
    .filter((p) => !p.archived && p.status === "ACTIVE" && p.setup === "READY")
    .sort((a, b) => a.code.localeCompare(b.code))
    .map((p) => ({ projectId: p.id, code: p.code, name: p.name, templateChanged: (p.templateRevision ?? 0) < template.revision }));
}
