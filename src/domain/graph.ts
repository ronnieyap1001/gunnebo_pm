/**
 * Flow graph algorithms (DESIGN.md 4.4, 4.5 and section 12). Pure: no clocks, no randomness.
 *
 * The *active* graph is the edges without `archivedAt`. Archived edges stay in `flow.edges` so they can be
 * restored and so sync knows which arrows the user removed.
 */
import { STATES, type EdgeArchiveReason, type Flow, type FlowEdge, type Iso, type Position, type State } from "./types";

// ---------------------------------------------------------------------------
// Basics
// ---------------------------------------------------------------------------

export function isActiveEdge(e: FlowEdge): boolean {
  return !e.archivedAt;
}

export function activeEdges(flow: Flow): FlowEdge[] {
  return flow.edges.filter(isActiveEdge);
}

/** Active successors adjacency (deduplicated, in edge order). */
function successorMap(edges: FlowEdge[]): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const e of edges) {
    if (!isActiveEdge(e)) continue;
    const list = m.get(e.from);
    if (!list) m.set(e.from, [e.to]);
    else if (!list.includes(e.to)) list.push(e.to);
  }
  return m;
}

/** True when `from` is reachable from `start` over the active edges (start itself counts). */
export function isReachable(edges: FlowEdge[], start: string, target: string): boolean {
  if (start === target) return true;
  const succ = successorMap(edges);
  const seen = new Set<string>([start]);
  const queue = [start];
  while (queue.length) {
    const n = queue.shift() as string;
    for (const s of succ.get(n) ?? []) {
      if (s === target) return true;
      if (!seen.has(s)) {
        seen.add(s);
        queue.push(s);
      }
    }
  }
  return false;
}

/**
 * Would adding the arrow `from -> to` create a loop? True for a self-loop, or when `from` can already be
 * reached from `to`. Only non-archived edges count.
 */
export function wouldCreateCycle(edges: FlowEdge[], from: string, to: string): boolean {
  if (from === to) return true;
  return isReachable(edges, to, from);
}

/** Active predecessors of a node (deduplicated, in edge order). */
export function predecessorsOf(edges: FlowEdge[], id: string): string[] {
  const out: string[] = [];
  for (const e of edges) if (isActiveEdge(e) && e.to === id && !out.includes(e.from)) out.push(e.from);
  return out;
}

/** Active successors of a node (deduplicated, in edge order). */
export function successorsOf(edges: FlowEdge[], id: string): string[] {
  const out: string[] = [];
  for (const e of edges) if (isActiveEdge(e) && e.from === id && !out.includes(e.to)) out.push(e.to);
  return out;
}

// ---------------------------------------------------------------------------
// Flow order (Kahn)
// ---------------------------------------------------------------------------

interface OrderNode {
  id: string;
  order: number;
  name: string;
}

function compareNodes(a: OrderNode, b: OrderNode): number {
  if (a.order !== b.order) return a.order < b.order ? -1 : 1;
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

/**
 * Topological order of the given nodes over the active edges between them. Among the nodes that are ready,
 * the one with the lowest (order, name, id) goes first, so parallel branches interleave by library order.
 * Nodes left over because of a cycle (should be impossible) are appended by the same key.
 */
export function flowOrder(nodes: { id: string; order: number; name: string }[], edges: FlowEdge[]): string[] {
  const byId = new Map<string, OrderNode>();
  for (const n of nodes) if (!byId.has(n.id)) byId.set(n.id, n);

  const indeg = new Map<string, number>();
  const succ = new Map<string, string[]>();
  for (const id of byId.keys()) {
    indeg.set(id, 0);
    succ.set(id, []);
  }
  const seenPairs = new Set<string>();
  for (const e of edges) {
    if (!isActiveEdge(e) || !byId.has(e.from) || !byId.has(e.to) || e.from === e.to) continue;
    const key = `${e.from}\u0000${e.to}`;
    if (seenPairs.has(key)) continue;
    seenPairs.add(key);
    succ.get(e.from)!.push(e.to);
    indeg.set(e.to, indeg.get(e.to)! + 1);
  }

  const ready: OrderNode[] = [];
  const pushReady = (n: OrderNode) => {
    // Sorted insert; n is small (<= 1000), so a linear scan is fine.
    let i = ready.length;
    while (i > 0 && compareNodes(ready[i - 1], n) > 0) i--;
    ready.splice(i, 0, n);
  };
  for (const n of byId.values()) if (indeg.get(n.id) === 0) pushReady(n);

  const out: string[] = [];
  const done = new Set<string>();
  while (ready.length) {
    const n = ready.shift() as OrderNode;
    out.push(n.id);
    done.add(n.id);
    for (const s of succ.get(n.id)!) {
      const d = indeg.get(s)! - 1;
      indeg.set(s, d);
      if (d === 0) pushReady(byId.get(s)!);
    }
  }
  if (out.length < byId.size) {
    const rest = [...byId.values()].filter((n) => !done.has(n.id)).sort(compareNodes);
    for (const n of rest) out.push(n.id);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Current milestones and progress
// ---------------------------------------------------------------------------

function isOpen(s: State): boolean {
  return s !== "DONE" && s !== "NOT_APPLICABLE";
}

/**
 * The "current" milestones: open nodes whose active predecessors are all cleared, where
 * cleared(n) = DONE, or N/A with all of its own predecessors cleared (N/A nodes are see-through).
 * Only edges between the given nodes count. A node without a state is treated as NOT_STARTED.
 * Returns ids in the order of `nodeIds`.
 */
export function currentNodeIds(nodeIds: string[], states: Record<string, State>, edges: FlowEdge[]): string[] {
  const set = new Set(nodeIds);
  const preds = new Map<string, string[]>();
  for (const id of set) preds.set(id, []);
  for (const e of edges) {
    if (!isActiveEdge(e) || !set.has(e.from) || !set.has(e.to) || e.from === e.to) continue;
    const list = preds.get(e.to)!;
    if (!list.includes(e.from)) list.push(e.from);
  }
  const stateOf = (id: string): State => states[id] ?? "NOT_STARTED";

  const memo = new Map<string, boolean>();
  const visiting = new Set<string>();
  const cleared = (id: string): boolean => {
    const known = memo.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return false; // cycle guard
    visiting.add(id);
    const s = stateOf(id);
    let result: boolean;
    if (s === "DONE") result = true;
    else if (s === "NOT_APPLICABLE") result = preds.get(id)!.every(cleared);
    else result = false;
    visiting.delete(id);
    memo.set(id, result);
    return result;
  };

  const out: string[] = [];
  const emitted = new Set<string>();
  for (const id of nodeIds) {
    if (emitted.has(id)) continue;
    if (isOpen(stateOf(id)) && preds.get(id)!.every(cleared)) {
      out.push(id);
      emitted.add(id);
    }
  }
  return out;
}

/** Progress over the given (active) nodes: done / applicable, where applicable excludes N/A. */
export function computeProgress(states: State[]): {
  done: number;
  applicable: number;
  pct: number;
  counts: Record<State, number>;
} {
  const counts = Object.fromEntries(STATES.map((s) => [s, 0])) as Record<State, number>;
  for (const s of states) counts[s] = (counts[s] ?? 0) + 1;
  const done = counts.DONE;
  const applicable = states.length - counts.NOT_APPLICABLE;
  const pct = applicable === 0 ? 0 : Math.floor((100 * done) / applicable);
  return { done, applicable, pct, counts };
}

// ---------------------------------------------------------------------------
// Edge edits
// ---------------------------------------------------------------------------

export type EdgeResult =
  | { ok: true; flow: Flow; edge: FlowEdge }
  | { ok: false; reason: "SELF" | "DUPLICATE" | "CYCLE" | "MISSING_NODE" };

/** Archive reasons that mean "the user removed this arrow on purpose". */
export const USER_REMOVED_REASONS: readonly EdgeArchiveReason[] = ["USER", "INSERT_AFTER"];

export function isUserRemoved(e: FlowEdge): boolean {
  return !!e.archivedAt && !!e.archivedReason && USER_REMOVED_REASONS.includes(e.archivedReason);
}

/** An un-archived copy of an edge (keeps id, templateEdgeId and createdAt). */
function unarchived(e: FlowEdge): FlowEdge {
  const copy: FlowEdge = { ...e };
  delete copy.archivedAt;
  delete copy.archivedReason;
  delete copy.batchId;
  return copy;
}

/** The archived edge to restore for a pair: one carrying a templateEdgeId first, otherwise the first one. */
export function findArchivedPair(edges: FlowEdge[], from: string, to: string): FlowEdge | undefined {
  const same = edges.filter((e) => !isActiveEdge(e) && e.from === from && e.to === to);
  return same.find((e) => e.templateEdgeId) ?? same[0];
}

export function findActivePair(edges: FlowEdge[], from: string, to: string): FlowEdge | undefined {
  return edges.find((e) => isActiveEdge(e) && e.from === from && e.to === to);
}

/**
 * Add the arrow `from -> to`. Both ends must be nodes of the flow (the caller checks they are not archived).
 * Refuses self-loops, duplicates and loops. An archived edge with the same pair is restored instead (same id,
 * same templateEdgeId).
 */
export function addEdge(flow: Flow, from: string, to: string, now: Iso, idFactory: () => string): EdgeResult {
  if (from === to) return { ok: false, reason: "SELF" };
  if (!(from in flow.nodes) || !(to in flow.nodes)) return { ok: false, reason: "MISSING_NODE" };
  if (findActivePair(flow.edges, from, to)) return { ok: false, reason: "DUPLICATE" };
  if (wouldCreateCycle(flow.edges, from, to)) return { ok: false, reason: "CYCLE" };

  const archived = findArchivedPair(flow.edges, from, to);
  if (archived) {
    const restored = unarchived(archived);
    delete restored.createdByBatchId; // a deliberate add is no longer a bridge of some batch
    return {
      ok: true,
      edge: restored,
      flow: { nodes: flow.nodes, edges: flow.edges.map((e) => (e === archived ? restored : e)) },
    };
  }
  const edge: FlowEdge = { id: idFactory(), from, to, createdAt: now };
  return { ok: true, edge, flow: { nodes: flow.nodes, edges: [...flow.edges, edge] } };
}

/** Archive one edge. Unknown or already archived edges leave the flow unchanged. */
export function archiveEdge(flow: Flow, edgeId: string, now: Iso, reason: EdgeArchiveReason): Flow {
  const target = flow.edges.find((e) => e.id === edgeId);
  if (!target || !isActiveEdge(target)) return flow;
  return {
    nodes: flow.nodes,
    edges: flow.edges.map((e) => (e === target ? { ...e, archivedAt: now, archivedReason: reason } : e)),
  };
}

// ---------------------------------------------------------------------------
// Archive a node / restore a batch / insert after
// ---------------------------------------------------------------------------

/**
 * Archive every active edge touching `nodeId` (reason NODE_ARCHIVED, stamped with the batch id). With
 * `reconnect`, bridge each predecessor p to each successor s when p -> s is missing and acyclic. Bridges are
 * marked `createdByBatchId = batchId` so restoring the batch removes them again.
 *
 * A bridge restores an archived p -> s edge when that edge was archived by the system (sync, a node archive,
 * import). An arrow the user removed on purpose (USER, INSERT_AFTER) is left archived and a new bridge edge is
 * added instead, so Undo returns that arrow to exactly its old "removed by you" state.
 * The node's position is kept so a restore puts it back where it was.
 */
export function archiveNodeInFlow(
  flow: Flow,
  nodeId: string,
  opts: { batchId: string; now: Iso; reconnect: boolean; idFactory: () => string },
): { flow: Flow; archivedEdgeIds: string[]; bridgeEdgeIds: string[] } {
  const preds = predecessorsOf(flow.edges, nodeId).filter((p) => p !== nodeId);
  const succs = successorsOf(flow.edges, nodeId).filter((s) => s !== nodeId);

  const archivedEdgeIds: string[] = [];
  let edges: FlowEdge[] = flow.edges.map((e) => {
    if (isActiveEdge(e) && (e.from === nodeId || e.to === nodeId)) {
      archivedEdgeIds.push(e.id);
      return { ...e, archivedAt: opts.now, archivedReason: "NODE_ARCHIVED" as const, batchId: opts.batchId };
    }
    return e;
  });

  const bridgeEdgeIds: string[] = [];
  if (opts.reconnect) {
    for (const p of preds) {
      for (const s of succs) {
        if (p === s) continue;
        if (findActivePair(edges, p, s)) continue;
        if (wouldCreateCycle(edges, p, s)) continue;
        const archived = edges.filter((e) => !isActiveEdge(e) && e.from === p && e.to === s);
        const restorable = archived.some(isUserRemoved)
          ? undefined
          : (archived.find((e) => e.templateEdgeId) ?? archived[0]);
        if (restorable) {
          const bridge: FlowEdge = { ...unarchived(restorable), createdByBatchId: opts.batchId };
          edges = edges.map((e) => (e === restorable ? bridge : e));
          bridgeEdgeIds.push(bridge.id);
        } else {
          const bridge: FlowEdge = {
            id: opts.idFactory(),
            from: p,
            to: s,
            createdAt: opts.now,
            createdByBatchId: opts.batchId,
          };
          edges = [...edges, bridge];
          bridgeEdgeIds.push(bridge.id);
        }
      }
    }
  }
  return { flow: { nodes: flow.nodes, edges }, archivedEdgeIds, bridgeEdgeIds };
}

/**
 * Undo a node archive: first archive the bridges that batch created (reason NODE_ARCHIVED, createdByBatchId
 * cleared), then un-archive the batch's edges whose two ends are active and that don't create a loop or a
 * duplicate. Archive followed by restore gives the identical active edge set.
 */
export function restoreBatchInFlow(
  flow: Flow,
  batchId: string,
  activeNodeIds: Set<string>,
  now: Iso,
): { flow: Flow; restoredEdgeIds: string[]; skippedEdgeIds: string[]; removedBridgeIds: string[] } {
  const removedBridgeIds: string[] = [];
  let edges: FlowEdge[] = flow.edges.map((e) => {
    if (e.createdByBatchId !== batchId) return e;
    const copy: FlowEdge = { ...e };
    delete copy.createdByBatchId;
    if (isActiveEdge(e)) {
      removedBridgeIds.push(e.id);
      copy.archivedAt = now;
      copy.archivedReason = "NODE_ARCHIVED";
      delete copy.batchId;
    }
    return copy;
  });

  const restoredEdgeIds: string[] = [];
  const skippedEdgeIds: string[] = [];
  for (const candidate of edges.filter((e) => !isActiveEdge(e) && e.batchId === batchId)) {
    const ok =
      activeNodeIds.has(candidate.from) &&
      activeNodeIds.has(candidate.to) &&
      !findActivePair(edges, candidate.from, candidate.to) &&
      !wouldCreateCycle(edges, candidate.from, candidate.to);
    if (!ok) {
      skippedEdgeIds.push(candidate.id);
      continue;
    }
    const restored = unarchived(candidate);
    edges = edges.map((e) => (e === candidate ? restored : e));
    restoredEdgeIds.push(candidate.id);
  }
  return { flow: { nodes: flow.nodes, edges }, restoredEdgeIds, skippedEdgeIds, removedBridgeIds };
}

/**
 * "Insert after X": archive each active X -> s edge (reason INSERT_AFTER) and add N -> s, then add X -> N.
 * Sets the new node's position. Arrows that would be refused (loops, duplicates) are skipped.
 */
export function insertAfterInFlow(
  flow: Flow,
  afterId: string,
  newId: string,
  position: Position,
  now: Iso,
  idFactory: () => string,
): Flow {
  const succs = successorsOf(flow.edges, afterId).filter((s) => s !== newId);
  let next: Flow = { nodes: { ...flow.nodes, [newId]: { x: position.x, y: position.y } }, edges: flow.edges };
  for (const s of succs) {
    const e = findActivePair(next.edges, afterId, s);
    if (e) next = archiveEdge(next, e.id, now, "INSERT_AFTER");
  }
  for (const s of succs) {
    const r = addEdge(next, newId, s, now, idFactory);
    if (r.ok) next = r.flow;
  }
  const r = addEdge(next, afterId, newId, now, idFactory);
  if (r.ok) next = r.flow;
  return next;
}
