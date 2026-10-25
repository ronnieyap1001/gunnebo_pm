import "server-only";
/**
 * Sync from template. previewSync plans from fresh state (pure planSync); startSync re-plans and applies the
 * selection (applySync) into a job; continueSync writes the job in batches and finalizes with ONE History row.
 * Values are never changed except by a lossless type conversion.
 */
import { createHash } from "node:crypto";
import { convertValue } from "@/domain/convertValue";
import { findActivePair, isActiveEdge, wouldCreateCycle } from "@/domain/graph";
import { remapFlow } from "@/domain/snapshot";
import {
  applySync,
  changeHashOf,
  dismissKeyOf,
  planSync,
  stableStringify,
  type SyncApplyResult,
  type SyncItem,
  type SyncProjectInput,
} from "@/domain/syncPlan";
import type { Choice, Flow, FlowEdge, Position, Project, Step, Template, ValueSnapshot } from "@/domain/types";
import type { Repo, StepInput, StoredStep } from "@/server/repo/types";
import { appendHistory, AppError, EV, newId, summaryFor, type Ctx } from "./context";
import { hasChoices } from "./definitions";
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
import { attachmentCounts, buildCells, currentMirror, progressOfCells, stepMirrorsOf, stepState, valueSnapshot } from "./mirrors";
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
  /** Steps whose patch is already written (besides lastOp === opId). */
  patchedStepIds?: string[];
  /** Rev of each patched step when the plan was made: a step changed since then gets a re-based patch. */
  baseRevs?: Record<string, number>;
  /** Hash of the project flow the plan was made from, and what the plan changes in it. */
  baseFlowHash?: string;
  flowDelta?: FlowDelta;
  /** Steps the ticked items change (History relates the row to them), with their value snapshot before the sync. */
  itemStepIds?: string[];
  before?: Record<string, ValueSnapshot>;
}

/** What a sync changes in the project flow: nodes it adds, and arrows it adds or changes (by id). */
export interface FlowDelta {
  nodes: Record<string, Position>;
  edges: { before?: FlowEdge; after: FlowEdge }[];
}

export function flowHash(flow: Flow): string {
  return createHash("sha256").update(stableStringify(flow ?? { nodes: {}, edges: [] })).digest("hex");
}

export function flowDeltaOf(base: Flow, planned: Flow): FlowDelta {
  const nodes: Record<string, Position> = {};
  for (const [id, p] of Object.entries(planned.nodes)) if (!base.nodes[id]) nodes[id] = { x: p.x, y: p.y };
  const baseById = new Map(base.edges.map((e) => [e.id, e]));
  const edges: FlowDelta["edges"] = [];
  for (const e of planned.edges) {
    const b = baseById.get(e.id);
    if (!b) edges.push({ after: e });
    else if (stableStringify(b) !== stableStringify(e)) edges.push({ before: b, after: e });
  }
  return { nodes, edges };
}

/**
 * Applies a sync's flow changes onto the project flow as it is now (the user may have moved nodes or drawn and
 * removed arrows while the job ran). An arrow the user changed meanwhile is left as the user made it; additions and
 * restores are re-checked for duplicates and loops. Applying the delta twice changes nothing.
 */
export function applyFlowDelta(current: Flow, delta: FlowDelta, idMap: Record<string, string>): Flow {
  const map = (id: string) => (Object.prototype.hasOwnProperty.call(idMap, id) ? idMap[id] : id);
  const remap = (e: FlowEdge): FlowEdge => ({ ...e, from: map(e.from), to: map(e.to) });
  const nodes: Record<string, Position> = { ...current.nodes };
  for (const [id, p] of Object.entries(delta.nodes)) if (!nodes[map(id)]) nodes[map(id)] = { x: p.x, y: p.y };
  let edges: FlowEdge[] = [...current.edges];
  const changes = delta.edges.map((d) => ({ before: d.before ? remap(d.before) : undefined, after: remap(d.after) }));
  // Removals first, so an addition that depends on them is not refused as a loop (same order as applySync).
  const ordered = [...changes.filter((c) => !isActiveEdge(c.after)), ...changes.filter((c) => isActiveEdge(c.after))];
  for (const { before, after } of ordered) {
    const i = edges.findIndex((e) => e.id === after.id);
    const cur = i >= 0 ? edges[i] : undefined;
    if (cur && stableStringify(cur) === stableStringify(after)) continue; // already applied
    if (before ? !cur || stableStringify(cur) !== stableStringify(before) : !!cur) continue; // changed by the user meanwhile
    const activates = isActiveEdge(after) && (!cur || !isActiveEdge(cur));
    if (activates) {
      if (!(after.from in nodes) || !(after.to in nodes)) continue;
      const others = edges.filter((e) => e !== cur);
      if (findActivePair(others, after.from, after.to) || wouldCreateCycle(others, after.from, after.to)) continue;
    }
    edges = cur ? edges.map((e) => (e === cur ? after : e)) : [...edges, after];
  }
  return { nodes, edges };
}

/** The current choices the planned list doesn't know (added by a newer sync) are kept as they are. */
function keepAllChoices(planned: Choice[], current: Choice[]): Choice[] {
  const ids = new Set(planned.map((c) => c.id));
  return [...planned, ...(current ?? []).filter((c) => !ids.has(c.id))];
}

/**
 * A planned patch re-based on a step that changed after the plan was made: the planned value is dropped (values are
 * never overwritten), a type change converts the current value losslessly or waits (the step keeps its type), and no
 * current choice is removed.
 */
export function rebasePatch(s: Step, planned: Partial<Step>): Partial<Step> {
  const out: Partial<Step> = { ...planned };
  delete out.value;
  if (out.choices) out.choices = keepAllChoices(out.choices, s.choices ?? []);
  const to = out.fieldType;
  if (to !== undefined && to !== s.fieldType) {
    const choices = out.choices ?? s.choices ?? [];
    const conv = convertValue(s.fieldType, to, s.value ?? null, hasChoices(to) ? choices : undefined);
    if (conv.ok) {
      if (stableStringify(conv.value) !== stableStringify(s.value ?? null)) out.value = conv.value;
    } else {
      delete out.fieldType;
    }
  }
  return out;
}

function snapshotChanged(a: ValueSnapshot | undefined, b: ValueSnapshot): boolean {
  return !a || a.state !== b.state || a.display !== b.display || stableStringify(a.raw) !== stableStringify(b.raw);
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
  const chosen = new Set(selected);
  const items = planSync(template, syncInput, ctx.day).items;
  if (input.dismissUnselected !== false) {
    for (const item of items) {
      if (item.selectable && !chosen.has(item.id)) unselected[dismissKeyOf(item.id)] = changeHashOf(item.id);
    }
  }
  const result = applied.result;
  const total = result.newSteps.length + result.stepPatches.length + 1;
  const stepById = new Map(steps.map((s) => [s.id, s]));
  const baseRevs: Record<string, number> = {};
  for (const p of result.stepPatches) {
    const s = stepById.get(p.stepId);
    if (s) baseRevs[s.id] = s.rev;
  }
  const itemStepIds = [...new Set(items.filter((i) => chosen.has(i.id) && i.stepId).map((i) => i.stepId as string))];
  const before: Record<string, ValueSnapshot> = {};
  for (const id of itemStepIds) {
    const s = stepById.get(id);
    if (s) before[id] = valueSnapshot(s, s.value, counts[id] ?? 0, ctx.day);
  }
  const job: SyncJob = {
    ...newJob(ctx, "sync", total),
    projectId: project.id,
    result,
    unselected,
    templateRevision: template.revision,
    baseRevs,
    baseFlowHash: flowHash(project.flow),
    flowDelta: flowDeltaOf(project.flow, result.flow),
    itemStepIds,
    before,
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
  const applied = new Set(job.patchedStepIds ?? []);
  const isPatched = (stepId: string) => applied.has(stepId) || byId.get(stepId)?.lastOp === job.opId;
  const doneSoFar = () =>
    result.newSteps.filter((d) => byKey.has(stepKeyOf(projectId, d.tempId))).length +
    result.stepPatches.filter((p) => isPatched(p.stepId)).length;
  if (toCreate.length > createBatch.length) {
    return { ...stepResult(false, doneSoFar(), total, `Adding milestones (${doneSoFar()} of ${total})`), projectId };
  }

  // 2. Step patches.
  const attachments = await ctx.repo.attachments.listByProject(projectId);
  const counts = attachmentCounts(attachments);
  const pending = result.stepPatches.filter((p) => byId.has(p.stepId) && !isPatched(p.stepId));
  const patchBatch = pending.slice(0, budget);
  const patched = await settleAll(
    patchBatch.map((p) => () => {
      const s = byId.get(p.stepId)!;
      const base = job.baseRevs?.[s.id];
      // The step changed after the plan (a value entered, another sync): never write the planned value over it.
      const changedSince = base !== undefined && s.rev !== base;
      const planned = changedSince ? rebasePatch(s, p.patch) : p.patch;
      const count = counts[s.id] ?? 0;
      if (changedSince && job.before && s.id in job.before) job.before[s.id] = valueSnapshot(s, s.value, count, ctx.day);
      const patch: Partial<StepInput> = { ...(planned as Partial<StepInput>), rev: s.rev + 1, lastOp: job.opId };
      if (stepState(s, count, ctx.day).state !== stepState({ ...s, ...patch } as Step, count, ctx.day).state) {
        patch.stateChangedAt = ctx.now;
      }
      patch.mirrors = stepMirrorsOf({ ...s, ...patch } as Step, count, ctx.day);
      return ctx.repo.steps.update(s.id, patch);
    }),
  );
  for (const s of patched) {
    byId.set(s.id, s);
    applied.add(s.id);
  }
  if (patched.length > 0) {
    // Remember what was patched, so a later user edit of such a step (new lastOp) never gets the patch again,
    // also when the finalize below is interrupted and resumed.
    job.patchedStepIds = [...applied];
    job.doneCount = doneSoFar();
    job.updatedAt = ctx.now;
    await saveJob(ctx.repo, job);
  }
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
  // The planned flow as is when the project flow is still the one the plan was made from; otherwise only the plan's
  // changes, applied onto the flow as it is now (positions moved and arrows drawn meanwhile are kept).
  const flow =
    !job.flowDelta || !job.baseFlowHash || flowHash(project.flow) === job.baseFlowHash
      ? remapFlow(result.flow, idMap)
      : applyFlowDelta(project.flow, job.flowDelta, idMap);
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
    // One row for the whole sync; it relates to every step an applied item changed or added (each step's history
    // shows it), with old/new snapshots for the steps whose value, display or colour changed.
    const addedStepIds = Object.values(idMap);
    const itemStepIds = (job.itemStepIds ?? []).filter((id) => byId.has(id));
    const detail = itemStepIds.flatMap((id) => {
      const s = byId.get(id)!;
      const neu = valueSnapshot(s, s.value, counts[id] ?? 0, ctx.day);
      const old = job.before?.[id];
      return snapshotChanged(old, neu) ? [{ stepId: id, stepName: s.name, milestoneKey: s.milestoneKey, old, new: neu }] : [];
    });
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
          addedStepIds,
          stepIds: [...new Set([...itemStepIds, ...addedStepIds])],
          steps: detail,
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
