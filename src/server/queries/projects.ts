import "server-only";
/**
 * Read models for the Projects table and the project page (Flow / List / History tabs, side panel).
 * State is derived here with the request's DayContext; nothing derived is trusted from storage.
 */
import { cellState } from "@/domain/cells";
import { FIELD_TYPE_META } from "@/domain/fieldTypes";
import { formatValue } from "@/domain/format";
import { computeProgress, currentNodeIds, flowOrder, isActiveEdge, predecessorsOf, successorsOf } from "@/domain/graph";
import type {
  Attachment,
  Choice,
  DayContext,
  FieldConfig,
  FieldType,
  FlowEdge,
  NodeFlag,
  Note,
  Position,
  Project,
  ProjectField,
  ProjectStatus,
  State,
  SystemFieldKey,
  Template,
  Value,
} from "@/domain/types";
import { isEmptyValue } from "@/domain/values";
import type { Repo, StoredStep } from "@/server/repo/types";
import { attachmentCounts, cellFlowOrder, currentOfCells, defOf, progressOfCells, stepState, type ProgressInfo } from "@/server/services/mirrors";
import { PROJECT_CLOSED_KEY } from "@/server/services/steps";
import { PROJECT_STATUS_LABELS, referencedStepIds, stepCopies, withKnownSteps } from "@/server/services/projects";
import { decoratePlan } from "@/server/services/sync";
import {
  attachmentDTO,
  byCreatedDesc,
  noteDTO,
  projectFieldsOf,
  stateDTO,
  templateOf,
  type AttachmentDTO,
  type NoteDTO,
  type ReadDeps,
  type StateDTO,
} from "./common";

// ---------------------------------------------------------------------------
// Detail values
// ---------------------------------------------------------------------------

export interface DetailDTO {
  fieldId: string;
  key: string;
  label: string;
  fieldType: FieldType;
  choices: Choice[];
  config: FieldConfig;
  systemKey: SystemFieldKey | null;
  showInSummary: boolean;
  archived: boolean;
  value: Value | null;
  display: string;
  empty: boolean;
}

/** Active fields in order (plus archived fields that still hold a value). */
export function buildDetails(fields: ProjectField[], details: Record<string, Value | null>): DetailDTO[] {
  return [...fields]
    .sort((a, b) => a.order - b.order || a.key.localeCompare(b.key))
    .filter((f) => !f.archived || (details?.[f.id] ?? null) !== null)
    .map((f) => {
      const value = details?.[f.id] ?? null;
      const def = { fieldType: f.fieldType, choices: f.choices ?? [], config: f.config ?? {} };
      return {
        fieldId: f.id,
        key: f.key,
        label: f.label,
        fieldType: f.fieldType,
        choices: f.choices ?? [],
        config: f.config ?? {},
        systemKey: f.systemKey ?? null,
        showInSummary: f.showInSummary,
        archived: f.archived,
        value,
        display: formatValue(def, value, { short: false }),
        empty: value === null || isEmptyValue(f.fieldType, value),
      };
    });
}

/** Ids of the selected choices of a Dropdown or Multiple value. */
export function choiceIdsOf(v: Value | null | undefined): string[] {
  if (!v || typeof v !== "object") return [];
  if ("choiceId" in v) return [v.choiceId];
  if ("choiceIds" in v && Array.isArray(v.choiceIds)) return v.choiceIds;
  return [];
}

// ---------------------------------------------------------------------------
// Projects table
// ---------------------------------------------------------------------------

export interface ProjectListRow {
  id: string;
  code: string;
  name: string;
  status: ProjectStatus;
  statusLabel: string;
  setup: "CREATING" | "READY";
  archived: boolean;
  /** Summary fields (showInSummary) with a value, in field order. */
  summary: { fieldId: string; label: string; display: string }[];
  customer: string | null;
  projectType: string | null;
  progress: { done: number; applicable: number; pct: number };
  currentNames: string[];
  firstCurrent: string | null;
  /** Fast path: last synced to an older template revision (exact counts are on the project page). */
  templateChanged: boolean;
  createdAt: string;
  updatedAt: string;
}

export function buildProjectListRow(p: Project, fields: ProjectField[], template: Template, day: DayContext): ProjectListRow {
  const cells = p.cells ?? {};
  const progress = progressOfCells(cells, day);
  const current = currentOfCells(cells, p.flow, day);
  const details = buildDetails(fields, p.details ?? {});
  const sys = (k: SystemFieldKey) => details.find((d) => d.systemKey === k && !d.empty)?.display ?? null;
  return {
    id: p.id,
    code: p.code,
    name: p.name,
    status: p.status,
    statusLabel: PROJECT_STATUS_LABELS[p.status] ?? p.status,
    setup: p.setup,
    archived: p.archived,
    summary: details
      .filter((d) => d.showInSummary && !d.empty && !d.archived && d.fieldType !== "LONG_TEXT")
      .map((d) => ({ fieldId: d.fieldId, label: d.label, display: d.display })),
    customer: sys("customer"),
    projectType: sys("projectType"),
    progress: { done: progress.done, applicable: progress.applicable, pct: progress.pct },
    currentNames: current.map((id) => cells[id]?.n ?? ""),
    firstCurrent: current.length ? (cells[current[0]]?.n ?? null) : null,
    templateChanged: p.setup === "READY" && (p.templateRevision ?? 0) < template.revision,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

/** Projects table (non-archived by default), sorted by code. Reads only the Projects data source. */
export async function getProjectsList(
  repo: Repo,
  day: DayContext,
  opts: { includeArchived?: boolean } = {},
  deps?: ReadDeps,
): Promise<ProjectListRow[]> {
  const [projects, fields, template] = await Promise.all([
    repo.projects.list({ includeArchived: opts.includeArchived }),
    projectFieldsOf(repo, deps),
    templateOf(repo, deps),
  ]);
  return projects
    .map((p) => buildProjectListRow(p, fields, template, day))
    .sort((a, b) => a.code.localeCompare(b.code, "en", { numeric: true }));
}

// ---------------------------------------------------------------------------
// Project page
// ---------------------------------------------------------------------------

export interface StepDTO extends StateDTO {
  id: string;
  milestoneId: string | null;
  milestoneKey: string | null;
  name: string;
  description: string;
  fieldType: FieldType;
  fieldTypeLabel: string;
  choices: Choice[];
  config: FieldConfig;
  value: Value | null;
  notApplicable: boolean;
  flag: NodeFlag | null;
  order: number;
  /** 1-based flow-order number in this project. */
  seq: number;
  rev: number;
  /** Full value text (side panel, List view). */
  display: string;
  /** Compact value line (node card, tooltips). */
  shortDisplay: string;
  isCurrent: boolean;
  projectOnly: boolean;
  /** Template-derived, but the milestone is archived or gone from the template. */
  notInTemplate: boolean;
  /** Template-derived and the template now uses another field type (kept because the value can't convert). */
  typeDiffers: boolean;
  valueSetAt: string | null;
  stateChangedAt: string | null;
  lastChangedAt: string | null;
  noteCount: number;
  latestNote: NoteDTO | null;
  attachmentCount: number;
  /** Active arrows of the project. */
  predecessors: string[];
  successors: string[];
}

export interface ProjectPageData {
  project: {
    id: string;
    code: string;
    name: string;
    status: ProjectStatus;
    statusLabel: string;
    setup: "CREATING" | "READY";
    archived: boolean;
    archivedAt: string | null;
    templateRevision: number;
    createdAt: string;
    updatedAt: string;
  };
  details: DetailDTO[];
  /** Active fields for the edit form. */
  detailFields: ProjectField[];
  /** Active steps in flow order. */
  steps: StepDTO[];
  archivedSteps: { id: string; name: string; archivedAt: string | null; archiveBatch: string | null }[];
  /** Positions of active steps and the active arrows between them. */
  flow: { nodes: Record<string, Position>; edges: FlowEdge[] };
  /** Active notes, newest first (project-level notes have stepId null). */
  notes: NoteDTO[];
  /** Active attachments, newest first. */
  attachments: AttachmentDTO[];
  progress: ProgressInfo;
  currentIds: string[];
  sync: { pendingCount: number; templateRevision: number; projectRevision: number; templateChanged: boolean };
  /** "Project closed" has a date on or before today and the status is not Closed. */
  suggestClose: boolean;
  /** Changes whenever the project or the template changes (client store refresh). */
  version: string;
  today: string;
}

/** Pure part of getProjectPageData (unit-testable without a repo). */
export function buildProjectPage(input: {
  project: Project;
  steps: StoredStep[];
  notes: Note[];
  attachments: Attachment[];
  fields: ProjectField[];
  template: Template;
  day: DayContext;
}): ProjectPageData {
  const { project: p, steps: allSteps, fields, template, day } = input;
  const counts = attachmentCounts(input.attachments);
  const steps = allSteps.filter((s) => !s.archived);
  const ids = new Set(steps.map((s) => s.id));
  const edges = (p.flow?.edges ?? []).filter((e) => isActiveEdge(e) && ids.has(e.from) && ids.has(e.to));
  const order = flowOrder(
    steps.map((s) => ({ id: s.id, order: s.order, name: s.name })),
    edges,
  );
  const byId = new Map(steps.map((s) => [s.id, s]));
  const derived = new Map(steps.map((s) => [s.id, stepState(s, counts[s.id] ?? 0, day)]));
  const states: Record<string, State> = {};
  for (const [id, d] of derived) states[id] = d.state;
  const current = currentNodeIds(order, states, edges);
  const currentSet = new Set(current);
  const msById = new Map(template.milestones.map((m) => [m.id, m]));

  const notes = input.notes.filter((n) => !n.archived).sort(byCreatedDesc);
  const notesByStep = new Map<string, typeof notes>();
  for (const n of notes) if (n.stepId) notesByStep.set(n.stepId, [...(notesByStep.get(n.stepId) ?? []), n]);

  const stepDTOs: StepDTO[] = order.map((id, i) => {
    const s = byId.get(id)!;
    const count = counts[s.id] ?? 0;
    const def = defOf(s);
    const m = s.milestoneId ? msById.get(s.milestoneId) : undefined;
    const sn = notesByStep.get(s.id) ?? [];
    return {
      ...stateDTO(derived.get(s.id)!),
      id: s.id,
      milestoneId: s.milestoneId ?? null,
      milestoneKey: s.milestoneKey ?? null,
      name: s.name,
      description: s.description ?? "",
      fieldType: s.fieldType,
      fieldTypeLabel: FIELD_TYPE_META[s.fieldType]?.label ?? s.fieldType,
      choices: s.choices ?? [],
      config: s.config ?? {},
      value: s.value ?? null,
      notApplicable: s.notApplicable,
      flag: s.flag ?? null,
      order: s.order,
      seq: i + 1,
      rev: s.rev,
      display: formatValue(def, s.value ?? null, { attachmentCount: count, today: day.today }),
      shortDisplay: formatValue(def, s.value ?? null, { attachmentCount: count, today: day.today, short: true }),
      isCurrent: currentSet.has(s.id),
      projectOnly: !s.milestoneId,
      notInTemplate: !!s.milestoneId && (!m || m.archived),
      typeDiffers: !!m && !m.archived && m.fieldType !== s.fieldType,
      valueSetAt: s.valueSetAt ?? null,
      stateChangedAt: s.stateChangedAt ?? null,
      lastChangedAt: s.lastChangedAt ?? null,
      noteCount: sn.length,
      latestNote: sn[0] ? noteDTO(sn[0]) : null,
      attachmentCount: count,
      predecessors: predecessorsOf(edges, s.id),
      successors: successorsOf(edges, s.id),
    };
  });

  const nodes: Record<string, Position> = {};
  for (const id of ids) if (p.flow?.nodes?.[id]) nodes[id] = p.flow.nodes[id];
  const preview = decoratePlan(template, p, allSteps, counts, day);
  const closed = steps.find((s) => s.milestoneKey === PROJECT_CLOSED_KEY && s.fieldType === "DATE");
  const closedDate = closed?.value && "date" in closed.value ? closed.value.date : undefined;

  return {
    project: {
      id: p.id,
      code: p.code,
      name: p.name,
      status: p.status,
      statusLabel: PROJECT_STATUS_LABELS[p.status] ?? p.status,
      setup: p.setup,
      archived: p.archived,
      archivedAt: p.archivedAt ?? null,
      templateRevision: p.templateRevision ?? 0,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    },
    details: buildDetails(fields, p.details ?? {}),
    detailFields: fields.filter((f) => !f.archived).sort((a, b) => a.order - b.order),
    steps: stepDTOs,
    archivedSteps: allSteps
      .filter((s) => s.archived)
      .map((s) => ({ id: s.id, name: s.name, archivedAt: s.archivedAt ?? null, archiveBatch: s.archiveBatch ?? null })),
    flow: { nodes, edges },
    notes: notes.map(noteDTO),
    attachments: input.attachments.filter((a) => !a.archived).sort(byCreatedDesc).map(attachmentDTO),
    progress: computeProgress(order.map((id) => states[id])),
    currentIds: current,
    sync: {
      pendingCount: p.setup === "READY" ? preview.pendingCount : 0,
      templateRevision: template.revision,
      projectRevision: p.templateRevision ?? 0,
      templateChanged: p.setup === "READY" && (p.templateRevision ?? 0) < template.revision,
    },
    suggestClose: !!closedDate && closedDate <= day.today && p.status !== "CLOSED" && !closed?.notApplicable,
    version: `${p.updatedAt}|${template.revision}`,
    today: day.today,
  };
}

/** Everything the project page needs, in 4 parallel reads (+ cached template and fields). Null when not found. */
export async function getProjectPageData(repo: Repo, day: DayContext, id: string, deps?: ReadDeps): Promise<ProjectPageData | null> {
  const project = await repo.projects.get(id);
  if (!project) return null;
  const [listed, notes, attachments, fields, template] = await Promise.all([
    repo.steps.listByProject(id, { includeArchived: true }),
    repo.notes.listByProject(id),
    repo.attachments.listByProject(id),
    projectFieldsOf(repo, deps),
    templateOf(repo, deps),
  ]);
  // Notion's query can lag a few seconds behind a write: read a just-added step by id so it shows straight away.
  const known = await withKnownSteps(repo, project, listed);
  // An untouched second copy of a step (a create retried while the query did not show the first one) is not shown:
  // the project keeps one copy, and reconcile moves the other to Notion's trash.
  const { leaveOut } = stepCopies(project, known, referencedStepIds(project, attachments, notes));
  const steps = known.filter((s) => !leaveOut.has(s.id));
  return buildProjectPage({ project, steps, notes, attachments, fields, template, day });
}

export interface CellDetails extends StateDTO {
  projectId: string;
  stepId: string;
  name: string;
  display: string;
  lastChangedAt: string | null;
  stateChangedAt: string | null;
  latestNote: NoteDTO | null;
}

/** Lazy Portfolio tooltip details (latest note, last changed) for one step. */
export async function getCellDetails(repo: Repo, day: DayContext, stepId: string): Promise<CellDetails | null> {
  const step = await repo.steps.get(stepId);
  if (!step) return null;
  const [notes, project] = await Promise.all([repo.notes.listByProject(step.projectId), repo.projects.get(step.projectId)]);
  const count = project?.cells?.[step.id]?.fc ?? 0;
  const latest = notes.filter((n) => n.stepId === step.id && !n.archived).sort(byCreatedDesc)[0];
  return {
    ...stateDTO(stepState(step, count, day)),
    projectId: step.projectId,
    stepId: step.id,
    name: step.name,
    display: formatValue(defOf(step), step.value ?? null, { attachmentCount: count, today: day.today }),
    lastChangedAt: step.lastChangedAt ?? null,
    stateChangedAt: step.stateChangedAt ?? null,
    latestNote: latest ? noteDTO(latest) : null,
  };
}

/** State of every cell of a project row (shared with the Portfolio). */
export function cellStatesInFlowOrder(p: Project, day: DayContext): { id: string; state: State }[] {
  const cells = p.cells ?? {};
  return cellFlowOrder(cells, p.flow).map((id) => ({ id, state: cellState(cells[id], day).state }));
}
