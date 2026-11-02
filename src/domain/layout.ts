/**
 * Auto-layout (left to right) with dagre, optionally wrapped into rows so a long chain (the 64-step seed) fits
 * the screen. Positions are the top-left corners of the node cards, as React Flow expects, and the layout's
 * bounding box starts at (0, 0). Deterministic for the same input.
 */
import dagre from "@dagrejs/dagre";
import type { FlowEdge, Position } from "./types";

export const NODE_WIDTH = 184;
export const NODE_HEIGHT = 56;

export const DEFAULT_NODESEP = 24;
export const DEFAULT_RANKSEP = 40;
export const DEFAULT_VIEWPORT_WIDTH = 1600;
export const WRAP_ROW_GAP = 80;

/** Ranks per row for the wrapped layout: max(4, floor(viewportWidth / (0.55 * (NODE_WIDTH + ranksep)))). */
export function ranksPerRow(viewportWidth: number = DEFAULT_VIEWPORT_WIDTH, ranksep: number = DEFAULT_RANKSEP): number {
  return Math.max(4, Math.floor(viewportWidth / (0.55 * (NODE_WIDTH + ranksep))));
}

export function autoLayout(
  nodeIds: string[],
  edges: FlowEdge[],
  opts?: { wrap?: boolean; viewportWidth?: number; ranksep?: number; nodesep?: number },
): Record<string, Position> {
  const ids = [...new Set(nodeIds)];
  if (ids.length === 0) return {};
  const ranksep = opts?.ranksep ?? DEFAULT_RANKSEP;
  const nodesep = opts?.nodesep ?? DEFAULT_NODESEP;

  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "LR", nodesep, ranksep, marginx: 0, marginy: 0 });
  g.setDefaultEdgeLabel(() => ({}));
  const set = new Set(ids);
  for (const id of ids) g.setNode(id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  for (const e of edges) {
    if (e.archivedAt || e.from === e.to || !set.has(e.from) || !set.has(e.to)) continue;
    g.setEdge(e.from, e.to);
  }
  dagre.layout(g);

  // Top-left corners straight from dagre (which reports centres).
  const raw: Record<string, Position> = {};
  for (const id of ids) {
    const n = g.node(id) as { x: number; y: number };
    raw[id] = { x: n.x - NODE_WIDTH / 2, y: n.y - NODE_HEIGHT / 2 };
  }

  if (!opts?.wrap) return normalise(raw);

  // Rank index = position of the node's column among the distinct columns (all nodes of a rank share x in LR).
  const columns = [...new Set(ids.map((id) => round(raw[id].x)))].sort((a, b) => a - b);
  const rankOf = new Map<string, number>(ids.map((id) => [id, columns.indexOf(round(raw[id].x))]));
  const perRow = ranksPerRow(opts.viewportWidth ?? DEFAULT_VIEWPORT_WIDTH, ranksep);
  const step = NODE_WIDTH + ranksep;

  const rowCount = Math.ceil(columns.length / perRow);
  const rowMinY: number[] = Array(rowCount).fill(Infinity);
  const rowMaxY: number[] = Array(rowCount).fill(-Infinity);
  for (const id of ids) {
    const row = Math.floor(rankOf.get(id)! / perRow);
    rowMinY[row] = Math.min(rowMinY[row], raw[id].y);
    rowMaxY[row] = Math.max(rowMaxY[row], raw[id].y + NODE_HEIGHT);
  }
  const rowTop: number[] = [];
  let y = 0;
  for (let r = 0; r < rowCount; r++) {
    rowTop.push(y);
    if (rowMinY[r] !== Infinity) y += rowMaxY[r] - rowMinY[r] + WRAP_ROW_GAP;
  }

  const out: Record<string, Position> = {};
  for (const id of ids) {
    const rank = rankOf.get(id)!;
    const row = Math.floor(rank / perRow);
    out[id] = { x: (rank % perRow) * step, y: rowTop[row] + (raw[id].y - rowMinY[row]) };
  }
  return normalise(out);
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

function normalise(pos: Record<string, Position>): Record<string, Position> {
  const vals = Object.values(pos);
  const minX = Math.min(...vals.map((p) => p.x));
  const minY = Math.min(...vals.map((p) => p.y));
  const out: Record<string, Position> = {};
  for (const [id, p] of Object.entries(pos)) out[id] = { x: round(p.x - minX), y: round(p.y - minY) };
  return out;
}
