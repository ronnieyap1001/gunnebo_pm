import "server-only";
/**
 * Milestone Library and Template Flow.
 * Template = milestones (Repo) + Settings 'template.flow' (Flow keyed by milestone id) + Settings 'template.revision'.
 * The revision goes up on every definition or arrow change, add, archive, restore or import; not on moves,
 * auto-layout or library reorder.
 */
import {
  addEdge,
  archiveEdge,
  archiveNodeInFlow,
  flowOrder,
  insertAfterInFlow,
  isActiveEdge,
  restoreBatchInFlow,
} from "@/domain/graph";
import { autoLayout, NODE_HEIGHT, NODE_WIDTH } from "@/domain/layout";
import { defaultPositions } from "@/domain/snapshot";
import { normalizeName, slugify } from "@/domain/slug";
import { choicesEqual, describeChoiceChanges, stableStringify } from "@/domain/syncPlan";
import type { Choice, FieldConfig, FieldType, Flow, FlowEdge, Milestone, Position, Template } from "@/domain/types";
import type { MilestoneInput, Repo } from "@/server/repo/types";
import {
  alreadyLogged,
  appendHistory,
  AppError,
  EV,
  LIBRARY_PREFIX,
  newId,
  notFound,
  requireName,
  SETTINGS,
  summaryFor,
  type Ctx,
} from "./context";
import {
  hasChoices,
  prepareChoices,
  prepareConfig,
  requireFieldType,
  typeLabel,
  withDefaultStates,
  type ChoiceInput,
} from "./definitions";

const EMPTY_FLOW: Flow = { nodes: {}, edges: [] };
export const MAX_DESCRIPTION_LENGTH = 500;

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export async function readTemplateFlow(repo: Repo): Promise<Flow> {
  const flow = await repo.settings.get<Flow>(SETTINGS.templateFlow);
  if (!flow || typeof flow !== "object") return { nodes: {}, edges: [] };
  return { nodes: { ...(flow.nodes ?? {}) }, edges: [...(flow.edges ?? [])] };
}

export async function readTemplateRevision(repo: Repo): Promise<number> {
  const r = await repo.settings.get<number>(SETTINGS.templateRevision);
  return typeof r === "number" && Number.isFinite(r) ? r : 0;
}

/** The template: all milestones (archived included; callers filter), the flow and the revision. */
export async function getTemplate(repo: Repo): Promise<Template> {
  const [milestones, flow, revision] = await Promise.all([
    repo.milestones.list({ includeArchived: true }),
    readTemplateFlow(repo),
    readTemplateRevision(repo),
  ]);
  return { milestones, flow, revision };
}

/** Active milestone ids in template flow order (the "#" shown everywhere). */
export function templateFlowOrder(template: Template): string[] {
  const active = template.milestones.filter((m) => !m.archived);
  const ids = new Set(active.map((m) => m.id));
  return flowOrder(
    active.map((m) => ({ id: m.id, order: m.order, name: m.name })),
    template.flow.edges.filter((e) => isActiveEdge(e) && ids.has(e.from) && ids.has(e.to)),
  );
}

// ---------------------------------------------------------------------------
// Writing helpers
// ---------------------------------------------------------------------------

export async function saveTemplateFlow(ctx: Ctx, flow: Flow): Promise<void> {
  await ctx.repo.settings.set(SETTINGS.templateFlow, flow ?? EMPTY_FLOW);
}

/** Revision + 1; returns the new revision. */
export async function bumpTemplateRevision(ctx: Ctx): Promise<number> {
  const next = (await readTemplateRevision(ctx.repo)) + 1;
  await ctx.repo.settings.set(SETTINGS.templateRevision, next);
  return next;
}

async function requireMilestone(ctx: Ctx, id: string): Promise<Milestone> {
  const m = await ctx.repo.milestones.get(id);
  if (!m) throw notFound("This milestone");
  return m;
}

function lib(text: string): string {
  return summaryFor(LIBRARY_PREFIX, text);
}

function describeOptional(raw: unknown): string {
  if (raw === undefined || raw === null) return "";
  if (typeof raw !== "string") throw new AppError("VALIDATION", "The description must be text.");
  const d = raw.trim();
  if (d.length > MAX_DESCRIPTION_LENGTH) {
    throw new AppError("VALIDATION", `The description is too long (maximum ${MAX_DESCRIPTION_LENGTH} characters).`);
  }
  return d;
}

function edgeIdFactory(): () => string {
  return () => newId();
}

/** Order for a new item placed right after `afterOrder`: halfway to the next order, or +1 at the end. */
export function orderAfter(afterOrder: number, orders: number[]): number {
  const next = orders.filter((o) => o > afterOrder).sort((a, b) => a - b)[0];
  return next === undefined ? afterOrder + 1 : (afterOrder + next) / 2;
}

// ---------------------------------------------------------------------------
// Milestones
// ---------------------------------------------------------------------------

export interface CreateMilestoneInput {
  name: string;
  fieldType: FieldType;
  description?: string;
  choices?: ChoiceInput[];
  config?: FieldConfig;
  /** "Insert after": the new milestone takes over X's outgoing arrows (X -> new -> X's old successors). */
  afterMilestoneId?: string;
  position?: Position;
}

/**
 * Adds a milestone and its template node. Key = slug of the name, unique among all keys incl. archived.
 * Order = halfway after `afterMilestoneId` (else max + 1). The node goes at `position`, or below the lowest node,
 * unconnected; with `afterMilestoneId` it is inserted after that node. Revision + 1. History `milestone.created`.
 */
export async function createMilestone(ctx: Ctx, input: CreateMilestoneInput): Promise<Milestone> {
  const name = requireName(input.name, "The milestone name");
  const fieldType = requireFieldType(input.fieldType);
  const description = describeOptional(input.description);
  const config = prepareConfig(input.config);
  const choices = prepareChoices(input.choices ?? [], { fieldType, existing: [], withStates: true });

  const template = await getTemplate(ctx.repo);
  if (await alreadyLogged(ctx)) {
    // Retried action: return the milestone the first attempt created.
    const same = template.milestones.filter((m) => m.name === name).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    if (same[0]) return same[0];
  }

  const after = input.afterMilestoneId ? template.milestones.find((m) => m.id === input.afterMilestoneId) : undefined;
  if (input.afterMilestoneId && (!after || after.archived)) throw notFound("The milestone to insert after");

  const orders = template.milestones.filter((m) => !m.archived).map((m) => m.order);
  const order = after ? orderAfter(after.order, orders) : (orders.length ? Math.max(...orders) : 0) + 1;
  const key = slugify(name, template.milestones.map((m) => m.key));

  const data: MilestoneInput = { key, name, description, fieldType, choices, config, order, archived: false };
  const milestone = await ctx.repo.milestones.create(data);

  let flow = template.flow;
  const activeIds = new Set(template.milestones.filter((m) => !m.archived).map((m) => m.id));
  if (after) {
    const at = flow.nodes[after.id] ?? { x: 0, y: 0 };
    const pos = input.position ?? { x: at.x + NODE_WIDTH + 40, y: at.y + NODE_HEIGHT + 40 };
    flow = insertAfterInFlow(flow, after.id, milestone.id, pos, ctx.now, edgeIdFactory());
  } else {
    const placed = Object.entries(flow.nodes)
      .filter(([id]) => activeIds.has(id))
      .map(([, p]) => p);
    const pos = input.position ?? defaultPositions([milestone.id], placed)[milestone.id];
    flow = { nodes: { ...flow.nodes, [milestone.id]: { x: pos.x, y: pos.y } }, edges: flow.edges };
  }
  await saveTemplateFlow(ctx, flow);
  const revision = await bumpTemplateRevision(ctx);

  await appendHistory(
    ctx,
    {
      type: EV.milestoneCreated,
      summary: lib(after ? `Added "${name}" after "${after.name}"` : `Added "${name}"`),
      milestoneId: milestone.id,
      milestoneKey: key,
      newDisplay: name,
      data: { milestoneKey: key, name, fieldType, afterMilestoneId: after?.id, revision },
    },
  );
  return milestone;
}

export interface MilestonePatch {
  name?: string;
  description?: string;
  fieldType?: FieldType;
  /** The full list in display order. Leave a choice out and it is kept, archived; send archived: true to retire. */
  choices?: ChoiceInput[];
  config?: FieldConfig;
}

interface DefSnapshot {
  name: string;
  description: string;
  fieldType: FieldType;
  choices: Choice[];
  config: FieldConfig;
}

function defSnapshot(m: Pick<Milestone, "name" | "description" | "fieldType" | "choices" | "config">): DefSnapshot {
  return {
    name: m.name,
    description: m.description ?? "",
    fieldType: m.fieldType,
    choices: m.choices ?? [],
    config: m.config ?? {},
  };
}

/**
 * Edits a milestone's definition. Choices are validated (unique ids, Dropdown choices need a state, labels
 * non-empty); new choices get slug ids; choices are never removed. Switching to Dropdown gives choices without a
 * state NOT_STARTED. No change = no write. Revision + 1, History `milestone.updated` with old/new.
 */
export async function updateMilestone(ctx: Ctx, id: string, patch: MilestonePatch): Promise<Milestone> {
  const m = await requireMilestone(ctx, id);
  if (m.archived) throw new AppError("VALIDATION", `"${m.name}" is archived. Restore it first.`);

  const before = defSnapshot(m);
  const after: DefSnapshot = { ...before };
  if (patch.name !== undefined) after.name = requireName(patch.name, "The milestone name");
  if (patch.description !== undefined) after.description = describeOptional(patch.description);
  if (patch.fieldType !== undefined) after.fieldType = requireFieldType(patch.fieldType);
  const becameDropdown = after.fieldType === "DROPDOWN" && before.fieldType !== "DROPDOWN";
  if (patch.choices !== undefined) {
    after.choices = prepareChoices(patch.choices, {
      fieldType: after.fieldType,
      existing: before.choices,
      withStates: true,
      defaultMissingState: becameDropdown,
    });
  } else if (becameDropdown) {
    after.choices = withDefaultStates(before.choices);
  }
  if (patch.config !== undefined) after.config = prepareConfig(patch.config);

  const changes = describeDefChanges(before, after);
  if (changes.length === 0) return m;
  if (await alreadyLogged(ctx)) return m;

  const update: Partial<MilestoneInput> = {};
  if (after.name !== before.name) update.name = after.name;
  if (after.description !== before.description) update.description = after.description;
  if (after.fieldType !== before.fieldType) update.fieldType = after.fieldType;
  if (!choicesEqual(after.choices, before.choices)) update.choices = after.choices;
  if (stableStringify(after.config) !== stableStringify(before.config)) update.config = after.config;

  const updated = await ctx.repo.milestones.update(id, update);
  const revision = await bumpTemplateRevision(ctx);
  const onlyRename = Object.keys(update).length === 1 && update.name !== undefined;
  await appendHistory(ctx, {
    type: EV.milestoneUpdated,
    summary: lib(onlyRename ? `Renamed "${before.name}" to "${after.name}"` : `Updated "${after.name}": ${changes.join("; ")}`),
    milestoneId: id,
    milestoneKey: m.key,
    oldDisplay: onlyRename ? before.name : undefined,
    newDisplay: onlyRename ? after.name : undefined,
    data: { milestoneKey: m.key, changes, old: pick(before, update), new: pick(after, update), revision },
  });
  return updated;
}

function pick(def: DefSnapshot, keys: Partial<MilestoneInput>): Partial<DefSnapshot> {
  const out: Partial<DefSnapshot> = {};
  for (const k of Object.keys(keys) as (keyof DefSnapshot)[]) (out as Record<string, unknown>)[k] = def[k];
  return out;
}

function describeDefChanges(before: DefSnapshot, after: DefSnapshot): string[] {
  const out: string[] = [];
  if (before.name !== after.name) out.push(`name "${before.name}" → "${after.name}"`);
  if (before.description !== after.description) out.push("description");
  if (before.fieldType !== after.fieldType) out.push(`type ${typeLabel(before.fieldType)} → ${typeLabel(after.fieldType)}`);
  if (!choicesEqual(before.choices, after.choices)) out.push(`choices (${describeChoiceChanges(before.choices, after.choices)})`);
  if (stableStringify(before.config) !== stableStringify(after.config)) out.push("settings");
  return out;
}

/**
 * Copies a choice list into another (Copy choices from… / "Also apply to …"). Matches by id, then by label; keeps
 * the target's id for a match, uses the source id when it is free in the target, and mints a new id when the source
 * id collides with an archived (or already used) one in the target. Target choices that don't match are archived.
 */
export function copyChoicesInto(source: Choice[], target: Choice[], targetType: FieldType): Choice[] {
  const withStates = targetType === "DROPDOWN";
  const byId = new Map(target.map((c) => [c.id, c]));
  const taken = new Set(target.map((c) => c.id));
  const used = new Set<string>();
  const out: Choice[] = [];
  for (const sc of source.filter((c) => !c.archived)) {
    let id: string;
    const sameId = byId.get(sc.id);
    const byLabel = target.find((c) => !c.archived && !used.has(c.id) && normalizeName(c.label) === normalizeName(sc.label));
    if (sameId && !sameId.archived && !used.has(sameId.id)) id = sameId.id;
    else if (byLabel) id = byLabel.id;
    else if (!taken.has(sc.id)) id = sc.id;
    else id = slugify(sc.label, taken);
    used.add(id);
    taken.add(id);
    const c: Choice = { id, label: sc.label };
    if (withStates) c.state = sc.state ?? "NOT_STARTED";
    out.push(c);
  }
  for (const tc of target) {
    if (used.has(tc.id)) continue;
    const kept: Choice = { id: tc.id, label: tc.label, archived: true };
    if (tc.state) kept.state = tc.state;
    out.push(kept);
  }
  return out;
}

/** "Also apply to 55–58": copies the source's active choices (labels and states) into each target. Revision + 1 once. */
export async function applyChoicesTo(ctx: Ctx, sourceId: string, targetIds: string[]): Promise<{ updatedIds: string[] }> {
  const source = await requireMilestone(ctx, sourceId);
  if (!hasChoices(source.fieldType)) throw new AppError("VALIDATION", `"${source.name}" has no choices to copy.`);
  const ids = [...new Set(targetIds)].filter((t) => t !== sourceId);
  if (ids.length === 0) return { updatedIds: [] };
  if (ids.length > 50) throw new AppError("VALIDATION", "Pick at most 50 milestones at once.");
  const targets = await Promise.all(ids.map((t) => requireMilestone(ctx, t)));
  for (const t of targets) {
    if (t.archived) throw new AppError("VALIDATION", `"${t.name}" is archived.`);
    if (!hasChoices(t.fieldType)) throw new AppError("VALIDATION", `"${t.name}" is not a Dropdown or Multiple field.`);
  }
  if (await alreadyLogged(ctx)) return { updatedIds: [] };

  const updatedIds: string[] = [];
  const names: string[] = [];
  for (const t of targets) {
    const next = copyChoicesInto(source.choices ?? [], t.choices ?? [], t.fieldType);
    if (choicesEqual(next, t.choices ?? [])) continue;
    await ctx.repo.milestones.update(t.id, { choices: next });
    updatedIds.push(t.id);
    names.push(t.name);
  }
  if (updatedIds.length === 0) return { updatedIds };
  const revision = await bumpTemplateRevision(ctx);
  await appendHistory(ctx, {
    type: EV.milestoneUpdated,
    summary: lib(`Copied the choices of "${source.name}" to ${names.map((n) => `"${n}"`).join(", ")}`),
    milestoneId: source.id,
    milestoneKey: source.key,
    data: { milestoneKey: source.key, sourceId, targetIds: updatedIds, targetNames: names, revision },
  });
  return { updatedIds };
}

/**
 * Library reorder: a fractional order between the new neighbours. Never touches arrows; no revision bump.
 * `effective` is false when the arrows already decide the order (the UI says "Arrows decide the order").
 */
export async function reorderMilestone(
  ctx: Ctx,
  id: string,
  where: { beforeId?: string; afterId?: string },
): Promise<{ milestone: Milestone; effective: boolean }> {
  const template = await getTemplate(ctx.repo);
  const m = template.milestones.find((x) => x.id === id);
  if (!m) throw notFound("This milestone");
  if (m.archived) throw new AppError("VALIDATION", `"${m.name}" is archived.`);
  const others = template.milestones.filter((x) => !x.archived && x.id !== id).sort((a, b) => a.order - b.order);
  let order: number;
  if (where.afterId) {
    const i = others.findIndex((x) => x.id === where.afterId);
    if (i < 0) throw notFound("The milestone to place after");
    const next = others[i + 1];
    order = next ? (others[i].order + next.order) / 2 : others[i].order + 1;
  } else if (where.beforeId) {
    const i = others.findIndex((x) => x.id === where.beforeId);
    if (i < 0) throw notFound("The milestone to place before");
    const prev = others[i - 1];
    order = prev ? (prev.order + others[i].order) / 2 : others[i].order - 1;
  } else {
    throw new AppError("VALIDATION", "Say where the milestone goes.");
  }
  if (order === m.order) return { milestone: m, effective: false };

  const before = templateFlowOrder(template);
  const reordered: Template = { ...template, milestones: template.milestones.map((x) => (x.id === id ? { ...x, order } : x)) };
  const effective = templateFlowOrder(reordered).join("|") !== before.join("|");
  if (await alreadyLogged(ctx)) return { milestone: m, effective };

  const updated = await ctx.repo.milestones.update(id, { order });
  await appendHistory(ctx, {
    type: EV.milestoneReordered,
    summary: lib(`Moved "${m.name}" in the list`),
    milestoneId: id,
    milestoneKey: m.key,
    data: { milestoneKey: m.key, oldOrder: m.order, newOrder: order, effective },
  });
  return { milestone: updated, effective };
}

/**
 * Archives a milestone and its template node: every arrow touching it is archived with the batch id and, with
 * `reconnect` (default), each predecessor is bridged to each successor (bridges are recorded in the batch so Undo
 * removes them). Revision + 1. History `milestone.archived`.
 */
export async function archiveMilestone(
  ctx: Ctx,
  id: string,
  opts: { reconnect?: boolean } = {},
): Promise<{ batchId: string; archivedEdgeIds: string[]; bridgeEdgeIds: string[] }> {
  const template = await getTemplate(ctx.repo);
  const m = template.milestones.find((x) => x.id === id);
  if (!m) throw notFound("This milestone");
  if (m.archived) return { batchId: m.archiveBatch ?? "", archivedEdgeIds: [], bridgeEdgeIds: [] };

  const batchId = newId();
  const result = archiveNodeInFlow(template.flow, id, {
    batchId,
    now: ctx.now,
    reconnect: opts.reconnect !== false,
    idFactory: edgeIdFactory(),
  });
  await ctx.repo.milestones.update(id, { archived: true, archivedAt: ctx.now, archiveBatch: batchId });
  await saveTemplateFlow(ctx, result.flow);
  const revision = await bumpTemplateRevision(ctx);
  await appendHistory(ctx, {
    type: EV.milestoneArchived,
    summary: lib(`Archived "${m.name}"`),
    milestoneId: id,
    milestoneKey: m.key,
    data: {
      milestoneKey: m.key,
      batchId,
      reconnect: opts.reconnect !== false,
      archivedEdgeIds: result.archivedEdgeIds,
      bridgeEdgeIds: result.bridgeEdgeIds,
      revision,
    },
  });
  return { batchId, archivedEdgeIds: result.archivedEdgeIds, bridgeEdgeIds: result.bridgeEdgeIds };
}

/**
 * Undo an archive: un-archives the batch's milestones, removes the bridges the batch created and restores the
 * batch's arrows whose two ends are active and that don't create a loop. Revision + 1.
 */
export async function restoreBatch(
  ctx: Ctx,
  batchId: string,
): Promise<{ restoredIds: string[]; restoredEdgeIds: string[]; skippedEdgeIds: string[] }> {
  if (!batchId) throw new AppError("VALIDATION", "Nothing to restore.");
  const template = await getTemplate(ctx.repo);
  const batch = template.milestones.filter((m) => m.archived && m.archiveBatch === batchId);
  if (batch.length === 0) return { restoredIds: [], restoredEdgeIds: [], skippedEdgeIds: [] };

  const activeIds = new Set(template.milestones.filter((m) => !m.archived).map((m) => m.id));
  for (const m of batch) activeIds.add(m.id);
  const result = restoreBatchInFlow(template.flow, batchId, activeIds, ctx.now);

  for (const m of batch) {
    await ctx.repo.milestones.update(m.id, { archived: false, archivedAt: undefined, archiveBatch: undefined });
  }
  await saveTemplateFlow(ctx, ensureNodes(result.flow, batch.map((m) => m.id)));
  const revision = await bumpTemplateRevision(ctx);
  const names = batch.map((m) => `"${m.name}"`).join(", ");
  await appendHistory(ctx, {
    type: EV.milestoneRestored,
    summary: lib(
      `Restored ${names}${result.skippedEdgeIds.length ? ` (${result.skippedEdgeIds.length} arrow${result.skippedEdgeIds.length === 1 ? "" : "s"} skipped)` : ""}`,
    ),
    milestoneId: batch.length === 1 ? batch[0].id : undefined,
    milestoneKey: batch.length === 1 ? batch[0].key : undefined,
    data: {
      batchId,
      milestoneIds: batch.map((m) => m.id),
      restoredEdgeIds: result.restoredEdgeIds,
      skippedEdgeIds: result.skippedEdgeIds,
      removedBridgeIds: result.removedBridgeIds,
      revision,
    },
  });
  return { restoredIds: batch.map((m) => m.id), restoredEdgeIds: result.restoredEdgeIds, skippedEdgeIds: result.skippedEdgeIds };
}

/** Restore from the Archive page: the milestone's batch when it has one; otherwise just the milestone (no arrows). */
export async function restoreMilestone(ctx: Ctx, id: string): Promise<{ restoredIds: string[]; skippedEdgeIds: string[] }> {
  const m = await requireMilestone(ctx, id);
  if (!m.archived) return { restoredIds: [], skippedEdgeIds: [] };
  if (m.archiveBatch) {
    const r = await restoreBatch(ctx, m.archiveBatch);
    return { restoredIds: r.restoredIds, skippedEdgeIds: r.skippedEdgeIds };
  }
  const flow = await readTemplateFlow(ctx.repo);
  await ctx.repo.milestones.update(id, { archived: false, archivedAt: undefined, archiveBatch: undefined });
  await saveTemplateFlow(ctx, ensureNodes(flow, [id]));
  const revision = await bumpTemplateRevision(ctx);
  await appendHistory(ctx, {
    type: EV.milestoneRestored,
    summary: lib(`Restored "${m.name}"`),
    milestoneId: id,
    milestoneKey: m.key,
    data: { milestoneKey: m.key, milestoneIds: [id], revision },
  });
  return { restoredIds: [id], skippedEdgeIds: [] };
}

/** Gives restored nodes a position when the flow lost it (placed below everything). */
function ensureNodes(flow: Flow, ids: string[]): Flow {
  const missing = ids.filter((id) => !flow.nodes[id]);
  if (missing.length === 0) return flow;
  return { nodes: { ...flow.nodes, ...defaultPositions(missing, Object.values(flow.nodes)) }, edges: flow.edges };
}

// ---------------------------------------------------------------------------
// Template flow
// ---------------------------------------------------------------------------

/** Saves dragged node positions. No history, no revision. Unknown ids are ignored. */
export async function moveTemplateNodes(ctx: Ctx, positions: Record<string, Position>): Promise<void> {
  const flow = await readTemplateFlow(ctx.repo);
  let changed = false;
  const nodes = { ...flow.nodes };
  for (const [id, p] of Object.entries(positions ?? {})) {
    if (!(id in nodes) || !isPosition(p)) continue;
    if (nodes[id].x === p.x && nodes[id].y === p.y) continue;
    nodes[id] = { x: p.x, y: p.y };
    changed = true;
  }
  if (changed) await saveTemplateFlow(ctx, { nodes, edges: flow.edges });
}

export function isPosition(p: unknown): p is Position {
  return (
    !!p &&
    typeof p === "object" &&
    Number.isFinite((p as Position).x) &&
    Number.isFinite((p as Position).y) &&
    Math.abs((p as Position).x) < 1e7 &&
    Math.abs((p as Position).y) < 1e7
  );
}

/** Draws an arrow `from -> to` between active milestones. AppError CYCLE / DUPLICATE. Revision + 1. */
export async function addTemplateEdge(ctx: Ctx, from: string, to: string): Promise<FlowEdge> {
  const template = await getTemplate(ctx.repo);
  const a = template.milestones.find((m) => m.id === from && !m.archived);
  const b = template.milestones.find((m) => m.id === to && !m.archived);
  if (!a || !b) throw notFound("One end of the arrow");
  const flow = ensureNodes(template.flow, [from, to]);
  const existing = flow.edges.find((e) => isActiveEdge(e) && e.from === from && e.to === to);
  if (existing && (await alreadyLogged(ctx))) return existing;
  const r = addEdge(flow, from, to, ctx.now, edgeIdFactory());
  if (!r.ok) throw edgeError(r.reason);
  await saveTemplateFlow(ctx, r.flow);
  const revision = await bumpTemplateRevision(ctx);
  await appendHistory(ctx, {
    type: EV.templateEdgeAdded,
    summary: lib(`Arrow "${a.name}" → "${b.name}" added`),
    data: { edgeId: r.edge.id, from, to, fromName: a.name, toName: b.name, revision },
  });
  return r.edge;
}

export function edgeError(reason: "SELF" | "DUPLICATE" | "CYCLE" | "MISSING_NODE"): AppError {
  switch (reason) {
    case "SELF":
    case "CYCLE":
      return new AppError("CYCLE", "That arrow would create a loop.");
    case "DUPLICATE":
      return new AppError("DUPLICATE", "That arrow already exists.");
    default:
      return new AppError("VALIDATION", "Both ends of an arrow must be on the chart.");
  }
}

/** Deletes (archives) a template arrow, reason USER. Revision + 1. */
export async function archiveTemplateEdge(ctx: Ctx, edgeId: string): Promise<void> {
  const template = await getTemplate(ctx.repo);
  const edge = template.flow.edges.find((e) => e.id === edgeId);
  if (!edge) throw notFound("This arrow");
  if (!isActiveEdge(edge)) return;
  const flow = archiveEdge(template.flow, edgeId, ctx.now, "USER");
  await saveTemplateFlow(ctx, flow);
  const revision = await bumpTemplateRevision(ctx);
  const name = (id: string) => template.milestones.find((m) => m.id === id)?.name ?? "?";
  await appendHistory(ctx, {
    type: EV.templateEdgeArchived,
    summary: lib(`Arrow "${name(edge.from)}" → "${name(edge.to)}" removed`),
    data: { edgeId, from: edge.from, to: edge.to, fromName: name(edge.from), toName: name(edge.to), revision },
  });
}

/** Auto-layout of the active template nodes (left to right, optionally wrapped). No history, no revision. */
export async function layoutTemplate(ctx: Ctx, opts: { wrap?: boolean; viewportWidth?: number } = {}): Promise<Flow> {
  const template = await getTemplate(ctx.repo);
  const ids = templateFlowOrder(template);
  const positions = autoLayout(ids, template.flow.edges, { wrap: opts.wrap, viewportWidth: opts.viewportWidth });
  const flow: Flow = { nodes: { ...template.flow.nodes, ...positions }, edges: template.flow.edges };
  await saveTemplateFlow(ctx, flow);
  return flow;
}
