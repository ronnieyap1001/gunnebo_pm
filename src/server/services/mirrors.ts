import "server-only";
/**
 * Project mirrors: the compact Cells JSON, Progress and Current milestones stored on (or derived from) the project
 * row. Pure helpers plus the one write helper that replaces a single cell after a step write.
 */
import { buildCell, cellState } from "@/domain/cells";
import { formatValue } from "@/domain/format";
import { computeProgress, currentNodeIds, flowOrder } from "@/domain/graph";
import { deriveState, type DerivedState } from "@/domain/state";
import { stableStringify } from "@/domain/syncPlan";
import type {
  Attachment,
  Cell,
  DayContext,
  FieldDef,
  Flow,
  Project,
  ProjectField,
  State,
  Step,
  Value,
  ValueSnapshot,
} from "@/domain/types";
import type { ProjectInput, ProjectMirrors as RepoProjectMirrors, StepMirrors } from "@/server/repo/types";
import type { Ctx } from "./context";

export function defOf(s: Pick<Step, "fieldType" | "choices" | "config">): FieldDef {
  return { fieldType: s.fieldType, choices: s.choices ?? [], config: s.config ?? {} };
}

/** Active attachments (files and links) per step id. */
export function attachmentCounts(attachments: Attachment[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const a of attachments) {
    if (a.archived || !a.stepId) continue;
    out[a.stepId] = (out[a.stepId] ?? 0) + 1;
  }
  return out;
}

export function stepState(
  step: Pick<Step, "fieldType" | "choices" | "config" | "value" | "notApplicable" | "flag" | "valueSetAt">,
  attachmentCount: number,
  day: DayContext,
): DerivedState {
  return deriveState(
    defOf(step),
    {
      value: step.value ?? null,
      notApplicable: step.notApplicable,
      flag: step.flag,
      valueSetAt: step.valueSetAt,
      attachmentCount,
    },
    day,
  );
}

/** {raw, display, state} of a value at the time of an event (history stays readable after renames). */
export function valueSnapshot(
  step: Pick<Step, "fieldType" | "choices" | "config" | "notApplicable" | "flag" | "valueSetAt">,
  value: Value | null,
  attachmentCount: number,
  day: DayContext,
): ValueSnapshot {
  const def = defOf(step);
  return {
    raw: value ?? null,
    display: formatValue(def, value ?? null, { attachmentCount }),
    state: stepState({ ...step, value }, attachmentCount, day).state,
  };
}

/** Cells for every active step. */
export function buildCells(steps: Step[], counts: Record<string, number>): Record<string, Cell> {
  const cells: Record<string, Cell> = {};
  for (const s of steps) {
    if (s.archived) continue;
    cells[s.id] = buildCell(s, counts[s.id] ?? 0);
  }
  return cells;
}

export function cellStates(cells: Record<string, Cell>, day: DayContext): Record<string, DerivedState> {
  const out: Record<string, DerivedState> = {};
  for (const [id, c] of Object.entries(cells)) out[id] = cellState(c, day);
  return out;
}

export interface ProgressInfo {
  done: number;
  applicable: number;
  pct: number;
  counts: Record<State, number>;
}

export function progressOfCells(cells: Record<string, Cell>, day: DayContext): ProgressInfo {
  return computeProgress(Object.values(cells).map((c) => cellState(c, day).state));
}

/** Step ids in flow order (Kahn over the project's active arrows, tie-break order, name, id). */
export function cellFlowOrder(cells: Record<string, Cell>, flow: Flow): string[] {
  return flowOrder(
    Object.entries(cells).map(([id, c]) => ({ id, order: c.o ?? 0, name: c.n })),
    flow.edges,
  );
}

/** Current milestones (open steps whose predecessors are cleared), in flow order. */
export function currentOfCells(cells: Record<string, Cell>, flow: Flow, day: DayContext, order?: string[]): string[] {
  const ids = order ?? cellFlowOrder(cells, flow);
  const states: Record<string, State> = {};
  for (const id of ids) if (cells[id]) states[id] = cellState(cells[id], day).state;
  return currentNodeIds(ids, states, flow.edges);
}

export function cellsEqual(a: Record<string, Cell>, b: Record<string, Cell>): boolean {
  return stableStringify(a ?? {}) === stableStringify(b ?? {});
}

export interface CellsProgress {
  progress: number;
  cells: Record<string, Cell>;
}

/**
 * Replaces one step's cell on the project (read-modify-write) and refreshes Progress. `project` should be fresh.
 * Writes only when the cell or progress changed. Pass `remove: true` for an archived step.
 */
export async function writeCell(
  ctx: Ctx,
  project: Project,
  step: Step,
  attachmentCount: number,
  opts: { remove?: boolean } = {},
): Promise<CellsProgress> {
  const cells: Record<string, Cell> = { ...(project.cells ?? {}) };
  if (opts.remove || step.archived) delete cells[step.id];
  else cells[step.id] = buildCell(step, attachmentCount);
  return writeMirrors(ctx, project, cells);
}

/** Writes cells (and the progress derived from them) when they differ from what the project has. */
export async function writeMirrors(
  ctx: Ctx,
  project: Project,
  cells: Record<string, Cell>,
  extra: Partial<ProjectInput> = {},
): Promise<CellsProgress> {
  const progress = progressOfCells(cells, ctx.day).pct;
  const changed = !cellsEqual(cells, project.cells ?? {}) || progress !== project.progress || Object.keys(extra).length > 0;
  if (changed) {
    const flow = extra.flow ?? project.flow;
    await ctx.repo.projects.update(project.id, {
      ...extra,
      cells,
      progress,
      mirrors: { ...(extra.mirrors ?? {}), current: currentMirror(cells, flow, ctx.day) },
    });
  }
  return { progress, cells };
}

/** Readable "Current" mirror for Notion: names of the current milestones. */
export function currentMirror(cells: Record<string, Cell>, flow: Flow, day: DayContext): string {
  const ids = currentOfCells(cells, flow, day);
  const names = ids.map((id) => cells[id]?.n).filter(Boolean) as string[];
  const text = names.join(", ");
  return text.length > 1900 ? `${text.slice(0, 1899)}…` : text;
}

/** Readable state/value mirrors written next to a step (Notion views only; the app re-derives). */
export function stepMirrorsOf(
  step: Pick<Step, "fieldType" | "choices" | "config" | "value" | "notApplicable" | "flag" | "valueSetAt">,
  attachmentCount: number,
  day: DayContext,
): StepMirrors {
  return {
    state: stepState(step, attachmentCount, day).state,
    display: formatValue(defOf(step), step.value ?? null, { attachmentCount }),
  };
}

/** Customer / Project type select mirrors and the summary line, from the detail values. */
export function projectDetailMirrors(fields: ProjectField[], details: Record<string, Value | null>): RepoProjectMirrors {
  const show = (f: ProjectField | undefined): string | null => {
    if (!f) return null;
    const v = details?.[f.id] ?? null;
    if (v === null) return null;
    const text = formatValue({ fieldType: f.fieldType, choices: f.choices ?? [], config: f.config ?? {} }, v, { short: true });
    return text === "—" ? null : text;
  };
  const active = fields.filter((f) => !f.archived).sort((a, b) => a.order - b.order);
  const summary = active
    .filter((f) => f.showInSummary && f.fieldType !== "LONG_TEXT")
    .map(show)
    .filter((x): x is string => !!x)
    .join(" · ");
  return {
    customer: show(fields.find((f) => f.systemKey === "customer")),
    projectType: show(fields.find((f) => f.systemKey === "projectType")),
    summary,
  };
}
