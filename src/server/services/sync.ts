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
  type JobStepResult,
  type SaveOutcome,
} from "./jobs";
import { getTemplate } from "./library";
import { attachmentCounts, buildCells, currentMirror, progressOfCells, stepMirrorsOf, stepState, valueSnapshot } from "./mirrors";
import {
  countsTrustingRecentCells,
  discardUnusedCopies,
  referencedStepIds,
  requireProject,
  settleAll,
  stepCopies,
  stepKeyOf,
  untouched,
  withKnownSteps,
} from "./projects";

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
  const [project, listed, attachments, notes, template] = await Promise.all([
    requireProject(repo, projectId),
    repo.steps.listByProject(projectId, { includeArchived: true }),
    repo.attachments.listByProject(projectId),
    repo.notes.listByProject(projectId),
    getTemplate(repo),
  ]);
  // A step created moments ago may not be in the query yet: without it the plan would add its milestone again.
  // Untouched second copies of a step (a retried create) are left out, as on the project page.
  const known = await withKnownSteps(repo, project, listed);
  const { leaveOut } = stepCopies(project, known, referencedStepIds(project, attachments, notes));
  const steps = known.filter((s) => !leaveOut.has(s.id));
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
  /**
   * tempId → id of the step created for a new milestone, saved after every batch (a lagging query must not make the
   * next batch create it a second time).
   */
  createdStepIds?: Record<string, string>;
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
  // The job grows as it records the steps it adds and patches: refuse up front a sync that could not be saved to the end.
  assertJobFits(
    {
      ...job,
      createdStepIds: Object.fromEntries(result.newSteps.map((d) => [d.tempId, SAMPLE_ID])),
      patchedStepIds: result.stepPatches.map(() => SAMPLE_ID),
      lease: SAMPLE_LEASE,
    } as SyncJob,
    "This sync",
  );
  await saveJob(ctx.repo, job, { creates: true });
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
 * Creates new steps (≤ 8 per call; their ids are recorded in the job, stepKey finds what a crashed batch created
 * before it could record it), applies step patches (≤ 8 per call, skipped when lastOp === opId), then finalizes:
 * remapped flow, cells rebuilt from fresh steps, templateRevision, unticked items merged into syncDismissed, second
 * copies moved to Notion's trash, ONE History row `project.synced`, job cleared. The job is saved after every
 * batch. Steps a lagging query does not show yet are read by id.
 *
 * `driver` identifies the browser run (see claimJob): while another run holds the job, the call only reports
 * RUNNING_ELSEWHERE. Finalizing works from the record Notion has; a new step already in the project's flow (another
 * call finalized first) or one someone added a value, file, link or note to is kept instead of the recorded copy,
 * and a copy is only discarded when nothing uses it.
 */
export async function continueSync(ctx: Ctx, opId: string, opts: { driver?: string } = {}): Promise<SyncProgress> {
  const call = beginJobCall(ctx, opts.driver);
  const loaded = await loadJobForContinue<SyncJob>(ctx.repo, opId);
  if (!loaded || loaded.kind !== "sync") throw new AppError("NOT_FOUND", "This sync was not found. Open the preview again.");
  const claim = await claimJob(call, loaded);
  if (claim.wait) return { ...claim.wait, projectId: loaded.projectId ?? "" };
  const job = claim.job;
  const finished = (): SyncProgress => ({ ...stepResult(true, job.total, job.total, "Sync finished"), projectId: job.projectId ?? "" });
  if (isFinished(job)) return finished();
  const projectId = job.projectId;
  const { result } = job;
  const total = job.total;
  const created: Record<string, string> = { ...(job.createdStepIds ?? {}) };

  const all = await ctx.repo.steps.listByProject(projectId, { includeArchived: true });
  const byId = new Map(all.map((s) => [s.id, s]));
  const firstByKey = new Map<string, StoredStep>();
  for (const s of all) if (!firstByKey.has(s.stepKey)) firstByKey.set(s.stepKey, s);
  let dirty = false;
  for (const d of result.newSteps) {
    if (created[d.tempId]) continue;
    const s = firstByKey.get(stepKeyOf(projectId, d.tempId));
    if (s) {
      created[d.tempId] = s.id;
      dirty = true;
    }
  }
  // Steps this job created or patches that the query does not show yet: read them by id.
  const unseen = [...new Set([...Object.values(created), ...result.stepPatches.map((p) => p.stepId)])].filter((id) => !byId.has(id));
  const read = await settleAll(unseen.map((id) => () => ctx.repo.steps.get(id)));
  read.forEach((s) => {
    if (s && s.projectId === projectId) byId.set(s.id, s);
  });
  const gone = new Set<string>();
  for (const [tempId, id] of Object.entries(created)) {
    if (byId.has(id)) continue;
    // A recorded step is gone (deleted in Notion meanwhile): forget it, so it is created again.
    delete created[tempId];
    gone.add(id);
    dirty = true;
  }
  let budget = BATCH_SIZE;

  // 1. New steps.
  const toCreate = result.newSteps.filter((d) => !created[d.tempId]);
  const createBatch = toCreate.slice(0, budget);
  const made = await settleSome(
    createBatch.map((d) => () => {
      const { tempId, ...rest } = d;
      const input: StepInput = { ...rest, projectId, stepKey: stepKeyOf(projectId, tempId), lastOp: job.opId };
      return ctx.repo.steps.create(input);
    }),
  );
  const madeHere = new Set<string>();
  made.results.forEach((s, i) => {
    if (!s) return;
    created[createBatch[i].tempId] = s.id;
    byId.set(s.id, s);
    madeHere.add(s.id);
    dirty = true;
  });
  const error = made.error;
  budget -= createBatch.length;
  const applied = new Set(job.patchedStepIds ?? []);
  const isPatched = (stepId: string) => applied.has(stepId) || byId.get(stepId)?.lastOp === job.opId;
  const doneSoFar = () =>
    result.newSteps.filter((d) => created[d.tempId]).length + result.stepPatches.filter((p) => isPatched(p.stepId)).length;
  const createsLeft = toCreate.length > createBatch.length;
  const saveProgress = async (): Promise<SaveOutcome> => {
    // Remember what was created and patched, so a later batch never creates a step twice and a later user edit of
    // a patched step (new lastOp) never gets the patch again, also when the finalize below is interrupted and resumed.
    // What another call recorded meanwhile is kept (see saveRunningJob); a copy of ours nothing uses goes to the trash
    // (see orphansOf).
    const lost: string[] = [];
    job.createdStepIds = created;
    job.patchedStepIds = [...applied];
    job.doneCount = doneSoFar();
    job.updatedAt = ctx.now;
    const { outcome, stored } = await saveRunningJob(call, job, (st) => {
      lost.push(...mergeRecord(created, st.createdStepIds, gone));
      for (const id of st.patchedStepIds ?? []) applied.add(id);
      job.patchedStepIds = [...applied];
      job.doneCount = doneSoFar();
    });
    if (outcome === "elsewhere" && stored) job.lease = stored.lease;
    const orphans = orphansOf(outcome, lost, madeHere);
    if (orphans.length) {
      const keep = new Set(Object.values(outcome === "saved" ? created : (stored?.createdStepIds ?? {})));
      await discardUnusedCopies(ctx, projectId, orphans, keep);
    }
    madeHere.clear();
    return outcome;
  };
  const stopped = (outcome: SaveOutcome): SyncProgress =>
    outcome === "finished" ? finished() : { ...elsewhereResult(job, job.lease!, call.now()), projectId };
  if (error || createsLeft) {
    if (dirty) {
      const outcome = await saveProgress();
      if (outcome !== "saved" && !error) return stopped(outcome);
    }
    if (error) throw error;
    return { ...stepResult(false, doneSoFar(), total, `Adding milestones (${doneSoFar()} of ${total})`), projectId };
  }

  // 2. Step patches.
  const attachments = await ctx.repo.attachments.listByProject(projectId);
  const counts = attachmentCounts(attachments);
  const pending = result.stepPatches.filter((p) => byId.has(p.stepId) && !isPatched(p.stepId));
  const patchBatch = pending.slice(0, budget);
  const patched = await settleSome(
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
  for (const s of patched.results) {
    if (!s) continue;
    byId.set(s.id, s);
    applied.add(s.id);
    dirty = true;
  }
  if (dirty) {
    const outcome = await saveProgress();
    if (outcome !== "saved" && !patched.error) return stopped(outcome);
  }
  if (patched.error) throw patched.error;
  if (pending.length > patchBatch.length) {
    return { ...stepResult(false, doneSoFar(), total, `Updating milestones (${doneSoFar()} of ${total})`), projectId };
  }

  // 3. Finalize, from the record Notion has (when another call saved a different one, the next call goes on from it).
  const progressNow = (): SyncProgress => ({
    ...stepResult(false, doneSoFar(), total, `Updating milestones (${doneSoFar()} of ${total})`),
    projectId,
  });
  const sameAsStored = (j: SyncJob) => sameRecord(j.createdStepIds, created);
  const before = await recheckJob<SyncJob>(call, opId, sameAsStored);
  if (before !== "same") return before === "finished" ? finished() : before === "changed" ? progressNow() : { ...before, projectId };
  // A save keeps the new steps another call of this job recorded (see saveProgress), which this call has not read yet
  // (the query may not show them): read them by id. One that is gone meanwhile is not finalized with; the next call
  // forgets it and creates it again.
  const taken = [...new Set(Object.values(created))].filter((id) => !byId.has(id));
  (await settleAll(taken.map((id) => () => ctx.repo.steps.get(id)))).forEach((s) => {
    if (s && s.projectId === projectId) byId.set(s.id, s);
  });
  if (taken.some((id) => !byId.has(id))) return progressNow();
  const project = await requireProject(ctx.repo, projectId);
  const notes = await ctx.repo.notes.listByProject(projectId);
  // Every step of the project: what the query showed, what this job created or patched, and (read by id) steps the
  // cells or the flow know that the query does not show yet.
  const known = await withKnownSteps(ctx.repo, project, [...byId.values()], Object.keys(project.flow?.nodes ?? {}));
  const referenced = referencedStepIds(project, attachments, notes);
  const idMap = keptNewSteps(projectId, result.newSteps, created, known, project, referenced);
  // The planned flow as is when the project flow is still the one the plan was made from; otherwise only the plan's
  // changes, applied onto the flow as it is now (positions moved and arrows drawn meanwhile are kept).
  const flow =
    !job.flowDelta || !job.baseFlowHash || flowHash(project.flow) === job.baseFlowHash
      ? remapFlow(result.flow, idMap)
      : applyFlowDelta(project.flow, job.flowDelta, idMap);
  // Not the second copies of a new step: they stay out of the cells (and go to the trash below when nothing uses them).
  const newKeys = new Set(result.newSteps.map((d) => stepKeyOf(projectId, d.tempId)));
  const kept = new Set(Object.values(idMap));
  const copies = known.filter((s) => newKeys.has(s.stepKey) && !kept.has(s.id) && untouched(s, referenced) && !s.archived);
  const copyIds = new Set(copies.map((s) => s.id));
  const steps: StoredStep[] = known.filter((s) => !copyIds.has(s.id));
  const cells = buildCells(steps, countsTrustingRecentCells(ctx, project, attachments));
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
  // Second copies go first: the History row is the last write before the tombstone (see continueImport).
  const after = await recheckJob<SyncJob>(call, opId, sameAsStored);
  if (after === "finished") return finished();
  if (after !== "same") return after === "changed" ? progressNow() : { ...after, projectId };
  await discardUnusedCopies(ctx, projectId, [...copyIds], kept);

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

/**
 * tempId → the step the project keeps for each new step of a sync: the copy already in the project's flow (another
 * call of this job finalized first), else a copy someone changed or added a file, link or note to while the recorded
 * one is untouched (their work stays in the flow), else the recorded copy (also when someone archived it meanwhile).
 */
export function keptNewSteps(
  projectId: string,
  newSteps: { tempId: string }[],
  created: Record<string, string>,
  known: StoredStep[],
  project: Project,
  referenced: ReadonlySet<string>,
): Record<string, string> {
  const inFlow = (id: string) => Object.prototype.hasOwnProperty.call(project.flow?.nodes ?? {}, id);
  const knownIds = new Set(known.map((s) => s.id));
  const byKey = new Map<string, StoredStep[]>();
  for (const s of known) {
    if (s.archived) continue;
    const group = byKey.get(s.stepKey) ?? [];
    group.push(s);
    byKey.set(s.stepKey, group);
  }
  const idMap: Record<string, string> = {};
  for (const d of newSteps) {
    const group = byKey.get(stepKeyOf(projectId, d.tempId)) ?? [];
    const recorded = group.find((s) => s.id === created[d.tempId]);
    const placed = group.find((s) => inFlow(s.id));
    const recordedUntouched = !!recorded && untouched(recorded, referenced);
    const touched = recordedUntouched ? group.find((s) => s !== recorded && !untouched(s, referenced)) : undefined;
    const keep = placed ?? touched ?? recorded;
    if (keep) idMap[d.tempId] = keep.id;
    else if (knownIds.has(created[d.tempId])) idMap[d.tempId] = created[d.tempId];
  }
  return idMap;
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
