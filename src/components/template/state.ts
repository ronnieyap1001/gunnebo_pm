/**
 * Template Flow editor state as the browser shows it: the server's TemplateView plus optimistic edits
 * (useOptimistic reducer). Pure, so it is cheap to re-apply on top of fresh server data.
 */
import { FIELD_TYPE_META } from "@/domain/fieldTypes";
import { predecessorsOf, successorsOf, wouldCreateCycle } from "@/domain/graph";
import type { Choice, FieldType, FlowEdge, Position } from "@/domain/types";
import type { MilestoneRow, TemplateView } from "@/server/queries";

export interface EditorState {
  /** Active milestones in flow order. */
  rows: MilestoneRow[];
  positions: Record<string, Position>;
  /** Active arrows between active milestones. */
  edges: FlowEdge[];
}

/** What an archive removed, so Undo can put it back on screen at once. */
export interface ArchivedSnapshot {
  row: MilestoneRow;
  index: number;
  position?: Position;
  /** Active arrows that touched the milestone. */
  edges: FlowEdge[];
}

export type EditorOp =
  | { type: "patch"; id: string; patch: Partial<MilestoneRow> }
  | { type: "choices"; ids: string[]; choices: Choice[] }
  | { type: "move"; positions: Record<string, Position> }
  | { type: "addEdge"; edge: FlowEdge }
  | { type: "removeEdges"; ids: string[] }
  | { type: "archive"; id: string; reconnect: boolean }
  | { type: "restore"; snapshot: ArchivedSnapshot; bridgeEdgeIds: string[] };

export function stateFromView(view: TemplateView): EditorState {
  return { rows: view.milestones, positions: view.flow.nodes, edges: view.flow.edges };
}

/** The arrows a "Reconnect neighbours" archive adds (each predecessor → each successor, no loops, no duplicates). */
export function bridgesFor(edges: FlowEdge[], id: string): { from: string; to: string }[] {
  const preds = predecessorsOf(edges, id).filter((p) => p !== id);
  const succs = successorsOf(edges, id).filter((s) => s !== id);
  let rest = edges.filter((e) => e.from !== id && e.to !== id);
  const out: { from: string; to: string }[] = [];
  for (const p of preds) {
    for (const s of succs) {
      if (p === s || rest.some((e) => e.from === p && e.to === s) || wouldCreateCycle(rest, p, s)) continue;
      out.push({ from: p, to: s });
      rest = [...rest, { id: `bridge:${p}>${s}`, from: p, to: s, createdAt: "" }];
    }
  }
  return out;
}

export function editorReducer(s: EditorState, op: EditorOp): EditorState {
  switch (op.type) {
    case "patch":
      return {
        ...s,
        rows: s.rows.map((r) =>
          r.id === op.id
            ? {
                ...r,
                ...op.patch,
                fieldTypeLabel: op.patch.fieldType ? FIELD_TYPE_META[op.patch.fieldType as FieldType].label : r.fieldTypeLabel,
              }
            : r,
        ),
      };
    case "choices": {
      const ids = new Set(op.ids);
      return { ...s, rows: s.rows.map((r) => (ids.has(r.id) ? { ...r, choices: op.choices } : r)) };
    }
    case "move":
      return { ...s, positions: { ...s.positions, ...op.positions } };
    case "addEdge":
      if (s.edges.some((e) => e.from === op.edge.from && e.to === op.edge.to)) return s;
      return { ...s, edges: [...s.edges, op.edge] };
    case "removeEdges": {
      const ids = new Set(op.ids);
      return { ...s, edges: s.edges.filter((e) => !ids.has(e.id)) };
    }
    case "archive": {
      const bridges = op.reconnect ? bridgesFor(s.edges, op.id) : [];
      return {
        ...s,
        rows: s.rows.filter((r) => r.id !== op.id),
        edges: [
          ...s.edges.filter((e) => e.from !== op.id && e.to !== op.id),
          ...bridges.map((b) => ({ id: `bridge:${b.from}>${b.to}`, from: b.from, to: b.to, createdAt: "" })),
        ],
      };
    }
    case "restore": {
      const { row, index, position, edges } = op.snapshot;
      if (s.rows.some((r) => r.id === row.id)) return s;
      const rows = [...s.rows];
      rows.splice(Math.max(0, Math.min(rows.length, index)), 0, row);
      const ids = new Set(rows.map((r) => r.id));
      const bridges = new Set(op.bridgeEdgeIds);
      const preds = edges.filter((e) => e.to === row.id).map((e) => e.from);
      const succs = edges.filter((e) => e.from === row.id).map((e) => e.to);
      for (const p of preds) for (const t of succs) bridges.add(`bridge:${p}>${t}`);
      const kept = s.edges.filter((e) => !bridges.has(e.id));
      const back = edges.filter(
        (e) => ids.has(e.from) && ids.has(e.to) && !kept.some((k) => k.from === e.from && k.to === e.to),
      );
      return {
        rows,
        positions: position ? { ...s.positions, [row.id]: position } : s.positions,
        edges: [...kept, ...back],
      };
    }
  }
}

/** "Dropdown · 5 choices", "Number · pcs", "Date". */
export function typeLineOf(row: Pick<MilestoneRow, "fieldType" | "fieldTypeLabel" | "choices" | "config">): string {
  const meta = FIELD_TYPE_META[row.fieldType];
  const label = row.fieldTypeLabel || meta?.label || row.fieldType;
  if (meta?.hasChoices) {
    const n = row.choices.filter((c) => !c.archived).length;
    return `${label} · ${n === 0 ? "no choices yet" : `${n} choice${n === 1 ? "" : "s"}`}`;
  }
  if (row.fieldType === "NUMBER" && row.config?.unit) return `${label} · ${row.config.unit}`;
  return label;
}
