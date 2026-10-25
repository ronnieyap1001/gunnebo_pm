import "server-only";
/**
 * Portfolio grid and "My open items". Reads only the Projects data source: every cell is derived from the
 * project's Cells mirror with today's date.
 */
import { cellDisplay, cellState } from "@/domain/cells";
import { daysBetween, ymdFromInstant } from "@/domain/dates";
import { truncate } from "@/domain/format";
import { isDateDrivenReason, STATE_META, worstState, type DerivedState, type StateReason } from "@/domain/state";
import type { Cell, Choice, DayContext, NodeFlag, Project, ProjectField, ProjectStatus, State, StateCode, Template } from "@/domain/types";
import { PROJECT_STATUSES } from "@/domain/types";
import type { Repo } from "@/server/repo/types";
import { templateFlowOrder } from "@/server/services/library";
import { cellFlowOrder, currentOfCells, progressOfCells } from "@/server/services/mirrors";
import { projectFieldsOf, templateOf, type ReadDeps } from "./common";
import { choiceIdsOf } from "./projects";

export interface PortfolioFilters {
  /** Default ['ACTIVE']. */
  status?: ProjectStatus[];
  /** Customer choice ids. */
  customer?: string[];
  /** Project type choice ids. */
  projectType?: string[];
  /** Search on code or name. */
  q?: string;
  /** "+ Waiting" chip (off by default). */
  includeWaiting?: boolean;
  /** "Include date-driven items" chip (off by default): DATE_PLANNED, RANGE_UPCOMING, RANGE_RUNNING. */
  includeDateDriven?: boolean;
}

export interface PortfolioColumn {
  milestoneId: string;
  key: string;
  name: string;
  /** 1-based template flow-order number. */
  seq: number;
}

/** Compact cell: state code, short value (≤ 24 chars), step id, current flag. */
export interface PortfolioCell {
  s: StateCode;
  v: string;
  id: string;
  cur?: true;
}

export interface PortfolioRow {
  projectId: string;
  code: string;
  name: string;
  status: ProjectStatus;
  customer: string | null;
  projectType: string | null;
  progress: { done: number; applicable: number; pct: number };
  /** Aligned with `columns`; null = the project has no step for that milestone (not synced yet). */
  cells: (PortfolioCell | null)[];
  /** Project-only and not-in-template steps: count and worst state. */
  other: { count: number; worst: StateCode | null; stepIds: string[] };
  templateChanged: boolean;
}

export interface OpenItem {
  projectId: string;
  code: string;
  projectName: string;
  stepId: string;
  name: string;
  milestoneKey: string | null;
  state: State;
  stateCode: StateCode;
  reason: StateReason;
  /** Short value text. */
  value: string;
  flag: NodeFlag | null;
  /** stateChangedAt of the step ("in progress for 12d"). */
  since: string | null;
  ageDays: number | null;
  /** Flow-order position in its project (tie-break). */
  seq: number;
}

export interface PortfolioData {
  columns: PortfolioColumn[];
  rows: PortfolioRow[];
  /** Sorted by stateChangedAt ascending (oldest first), then flow order. */
  openItems: OpenItem[];
  /** Items the chips currently hide (for "Include date-driven items (n)" / "+ Waiting (n)"). */
  hidden: { waiting: number; dateDriven: number };
  filters: Required<Pick<PortfolioFilters, "status" | "customer" | "projectType" | "q" | "includeWaiting" | "includeDateDriven">>;
  filterOptions: {
    statuses: { id: ProjectStatus; label: string }[];
    customers: Choice[];
    projectTypes: Choice[];
    customerFieldId: string | null;
    projectTypeFieldId: string | null;
  };
  templateRevision: number;
  today: string;
}

const STATUS_LABEL: Record<ProjectStatus, string> = { ACTIVE: "Active", ON_HOLD: "On hold", CLOSED: "Closed" };
const SHORT_VALUE = 24;

function resolveFilters(f: PortfolioFilters | undefined): PortfolioData["filters"] {
  const status = (f?.status ?? []).filter((s) => (PROJECT_STATUSES as readonly string[]).includes(s));
  return {
    status: status.length ? status : ["ACTIVE"],
    customer: [...new Set(f?.customer ?? [])],
    projectType: [...new Set(f?.projectType ?? [])],
    q: (f?.q ?? "").trim(),
    includeWaiting: f?.includeWaiting === true,
    includeDateDriven: f?.includeDateDriven === true,
  };
}

function choiceLabel(field: ProjectField | undefined, p: Project): string | null {
  if (!field) return null;
  const ids = choiceIdsOf(p.details?.[field.id] ?? null);
  const labels = ids.map((id) => (field.choices ?? []).find((c) => c.id === id)?.label).filter(Boolean) as string[];
  return labels.length ? labels.join(", ") : null;
}

function matchesChoice(field: ProjectField | undefined, p: Project, wanted: string[]): boolean {
  if (wanted.length === 0) return true;
  if (!field) return false;
  const ids = choiceIdsOf(p.details?.[field.id] ?? null);
  return ids.some((id) => wanted.includes(id));
}

export function buildPortfolio(input: {
  projects: Project[];
  fields: ProjectField[];
  template: Template;
  day: DayContext;
  filters?: PortfolioFilters;
}): PortfolioData {
  const { template, day } = input;
  const filters = resolveFilters(input.filters);
  const customerField = input.fields.find((f) => f.systemKey === "customer");
  const typeField = input.fields.find((f) => f.systemKey === "projectType");

  const order = templateFlowOrder(template);
  const msById = new Map(template.milestones.map((m) => [m.id, m]));
  const columns: PortfolioColumn[] = order.map((id, i) => ({ milestoneId: id, key: msById.get(id)!.key, name: msById.get(id)!.name, seq: i + 1 }));
  const colIndex = new Map(order.map((id, i) => [id, i]));

  const q = filters.q.toLowerCase();
  const projects = input.projects
    .filter((p) => !p.archived && p.setup === "READY")
    .filter((p) => filters.status.includes(p.status))
    .filter((p) => matchesChoice(customerField, p, filters.customer))
    .filter((p) => matchesChoice(typeField, p, filters.projectType))
    .filter((p) => !q || p.code.toLowerCase().includes(q) || p.name.toLowerCase().includes(q))
    .sort((a, b) => a.code.localeCompare(b.code, "en", { numeric: true }));

  const rows: PortfolioRow[] = [];
  const items: (OpenItem & { dateDriven: boolean })[] = [];
  for (const p of projects) {
    const cells: Record<string, Cell> = p.cells ?? {};
    const flowIds = cellFlowOrder(cells, p.flow);
    const seqOf = new Map(flowIds.map((id, i) => [id, i + 1]));
    const states = new Map<string, DerivedState>(flowIds.map((id) => [id, cellState(cells[id], day)]));
    const current = new Set(currentOfCells(cells, p.flow, day, flowIds));
    const rowCells: (PortfolioCell | null)[] = columns.map(() => null);
    const otherIds: string[] = [];
    for (const id of flowIds) {
      const c = cells[id];
      const st = states.get(id)!;
      const col = c.m !== undefined ? colIndex.get(c.m) : undefined;
      if (col !== undefined && rowCells[col] === null) {
        const cell: PortfolioCell = { s: STATE_META[st.state].code, v: truncate(cellDisplay(c, day), SHORT_VALUE), id };
        if (current.has(id)) cell.cur = true;
        rowCells[col] = cell;
      } else {
        otherIds.push(id);
      }
      if (st.state === "IN_PROGRESS" || st.state === "BLOCKED" || st.state === "WAITING") {
        const ageDays = c.c ? Math.max(0, daysBetween(ymdFromInstant(c.c, day.timeZone), day.today)) : null;
        items.push({
          projectId: p.id,
          code: p.code,
          projectName: p.name,
          stepId: id,
          name: c.n,
          milestoneKey: c.k ?? null,
          state: st.state,
          stateCode: STATE_META[st.state].code,
          reason: st.reason,
          value: truncate(cellDisplay(c, day), 40),
          flag: c.f ?? null,
          since: c.c ?? null,
          ageDays,
          seq: seqOf.get(id) ?? 0,
          dateDriven: isDateDrivenReason(st.reason),
        });
      }
    }
    const otherStates = otherIds.map((id) => states.get(id)!.state).filter((s) => s !== "NOT_APPLICABLE");
    const worst = worstState(otherStates.length ? otherStates : otherIds.map((id) => states.get(id)!.state));
    const progress = progressOfCells(cells, day);
    rows.push({
      projectId: p.id,
      code: p.code,
      name: p.name,
      status: p.status,
      customer: choiceLabel(customerField, p),
      projectType: choiceLabel(typeField, p),
      progress: { done: progress.done, applicable: progress.applicable, pct: progress.pct },
      cells: rowCells,
      other: { count: otherIds.length, worst: worst ? STATE_META[worst].code : null, stepIds: otherIds },
      templateChanged: (p.templateRevision ?? 0) < template.revision,
    });
  }

  const hidden = { waiting: 0, dateDriven: 0 };
  const openItems: OpenItem[] = [];
  for (const it of items) {
    if (it.state === "WAITING" && !filters.includeWaiting) {
      hidden.waiting++;
      continue;
    }
    if (it.dateDriven && !filters.includeDateDriven) {
      hidden.dateDriven++;
      continue;
    }
    const { dateDriven: _d, ...item } = it;
    openItems.push(item);
  }
  openItems.sort((a, b) => {
    const sa = a.since ?? "";
    const sb = b.since ?? "";
    if (sa !== sb) return sa < sb ? -1 : 1;
    if (a.seq !== b.seq) return a.seq - b.seq;
    return a.code.localeCompare(b.code);
  });

  return {
    columns,
    rows,
    openItems,
    hidden,
    filters,
    filterOptions: {
      statuses: PROJECT_STATUSES.map((s) => ({ id: s, label: STATUS_LABEL[s] })),
      customers: (customerField?.choices ?? []).filter((c) => !c.archived),
      projectTypes: (typeField?.choices ?? []).filter((c) => !c.archived),
      customerFieldId: customerField?.id ?? null,
      projectTypeFieldId: typeField?.id ?? null,
    },
    templateRevision: template.revision,
    today: day.today,
  };
}

/** Portfolio screen: 1–2 requests (the Projects list) plus the cached template and project fields. */
export async function getPortfolioData(repo: Repo, day: DayContext, filters?: PortfolioFilters, deps?: ReadDeps): Promise<PortfolioData> {
  const [projects, fields, template] = await Promise.all([repo.projects.list(), projectFieldsOf(repo, deps), templateOf(repo, deps)]);
  return buildPortfolio({ projects, fields, template, day, filters });
}
