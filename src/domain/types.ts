/**
 * Shared domain types. Pure TypeScript: no Next.js, no Notion, no React.
 * Every other layer (domain logic, Notion repositories, services, UI) builds on these.
 */

// ---------------------------------------------------------------------------
// Field types and states
// ---------------------------------------------------------------------------

export const FIELD_TYPES = [
  "TEXT",
  "LONG_TEXT",
  "NUMBER",
  "PERCENT",
  "DATE",
  "DATE_RANGE",
  "DROPDOWN",
  "MULTIPLE",
  "CHECKBOX",
  "LINK",
  "FILE",
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export const STATES = [
  "NOT_STARTED",
  "IN_PROGRESS",
  "WAITING",
  "BLOCKED",
  "DONE",
  "NOT_APPLICABLE",
] as const;
export type State = (typeof STATES)[number];

/** Short codes used in the seed file and compact JSON (cells). */
export type StateCode = "NS" | "IP" | "W" | "B" | "D" | "NA";

export const NODE_FLAGS = ["WAITING", "BLOCKED"] as const;
export type NodeFlag = (typeof NODE_FLAGS)[number];

// ---------------------------------------------------------------------------
// Choices and values
// ---------------------------------------------------------------------------

/**
 * A choice of a Dropdown or Multiple field.
 * - id: slug, unique within its list, never reused, unchanged by renames.
 * - state: required for DROPDOWN choices on milestones and steps; absent for MULTIPLE and project fields.
 * - archived: hidden from new picks; shown as "retired" when still used by a value.
 * Array order is display order.
 */
export interface Choice {
  id: string;
  label: string;
  state?: State;
  archived?: boolean;
}

export interface FieldConfig {
  /** Unit shown after plain numbers, e.g. "pcs". */
  unit?: string;
}

/** Calendar date as 'YYYY-MM-DD'. Never converted to a Date for comparisons. */
export type Ymd = string;

/** ISO-8601 instant in UTC, e.g. '2026-10-24T06:05:00.000Z'. */
export type Iso = string;

export type TextValue = { text: string };
export type NumberValue = { number: number };
export type PercentValue = { percent: number };
export type DateValue = { date: Ymd };
export type DateRangeValue = { start?: Ymd; end?: Ymd };
export type DropdownValue = { choiceId: string };
export type MultipleValue = { choiceIds: string[] };
export type CheckboxValue = { checked: true };
export type LinkValue = { url: string; label?: string };

/**
 * A stored value. `null` means empty. FILE fields never store a value: their state comes from attachments.
 * TEXT and LONG_TEXT share TextValue.
 */
export type Value =
  | TextValue
  | NumberValue
  | PercentValue
  | DateValue
  | DateRangeValue
  | DropdownValue
  | MultipleValue
  | CheckboxValue
  | LinkValue;

/** The definition part shared by milestones, steps and project fields. */
export interface FieldDef {
  fieldType: FieldType;
  choices: Choice[];
  config: FieldConfig;
}

// ---------------------------------------------------------------------------
// Library and template
// ---------------------------------------------------------------------------

export interface Milestone extends FieldDef {
  /** Notion page id. Stable; external processes reference it. */
  id: string;
  /** Fixed slug for automations (e.g. 'customer-po-loi'). Never changed by renames. */
  key: string;
  name: string;
  description: string;
  /** Library order and flow-order tie-break. Fractional values allowed. */
  order: number;
  archived: boolean;
  archivedAt?: Iso;
  archiveBatch?: string;
  createdAt: Iso;
  updatedAt: Iso;
}

export type EdgeArchiveReason = "USER" | "INSERT_AFTER" | "SYNC" | "NODE_ARCHIVED" | "IMPORT";

/** An arrow: `to` comes after `from`. */
export interface FlowEdge {
  id: string;
  from: string;
  to: string;
  createdAt: Iso;
  archivedAt?: Iso;
  archivedReason?: EdgeArchiveReason;
  /** Batch that archived this edge (node archive), so Undo can restore it. */
  batchId?: string;
  /** Batch whose "reconnect neighbours" created this bridge edge, so Undo can remove it again. */
  createdByBatchId?: string;
  /** Project edges only: the template edge this edge was copied from. */
  templateEdgeId?: string;
}

export interface Position {
  x: number;
  y: number;
}

/**
 * Positions and arrows of a flow.
 * Template flow: node keys are milestone ids. Project flow: node keys are step ids.
 * Archived edges stay in the list (with archivedAt) so they can be restored and so sync knows what the user removed.
 */
export interface Flow {
  nodes: Record<string, Position>;
  edges: FlowEdge[];
}

export interface Template {
  milestones: Milestone[];
  flow: Flow;
  /** +1 on every definition or arrow change, add, archive, restore or import. Not on moves or library reorder. */
  revision: number;
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export type SystemFieldKey = "customer" | "projectType";

/** A configurable project detail field (Customer, End user, Site / country, ...). */
export interface ProjectField extends FieldDef {
  id: string;
  key: string;
  label: string;
  order: number;
  /** Shown in the project header and the Projects table. */
  showInSummary: boolean;
  /** Fields the Portfolio filters depend on: may be renamed and have choices edited, never archived. */
  systemKey?: SystemFieldKey;
  archived: boolean;
  archivedAt?: Iso;
}

export const PROJECT_STATUSES = ["ACTIVE", "ON_HOLD", "CLOSED"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

/**
 * Compact per-step summary stored on the project row so the Portfolio can render without reading every step.
 * Enough to re-derive state at read time with today's date.
 */
export interface Cell {
  /** Milestone id (absent for project-only steps). */
  m?: string;
  /** Milestone key. */
  k?: string;
  /** Step name. */
  n: string;
  /** Field type. */
  t: FieldType;
  /** Value, "lite": text values truncated to 60 characters (state only needs emptiness). */
  v: Value | null;
  /** For DROPDOWN / MULTIPLE: only the selected choice(s), so state and label can be derived. */
  ch?: Choice[];
  /** Not applicable. */
  na?: boolean;
  /** Flag. */
  f?: NodeFlag | null;
  /** Active attachment count (FILE type state). */
  fc?: number;
  /** valueSetAt. */
  vs?: Iso;
  /** stateChangedAt. */
  c?: Iso;
  /** Flow-order tie-break. */
  o?: number;
}

export interface Project {
  id: string;
  code: string;
  name: string;
  status: ProjectStatus;
  /** Configurable detail values keyed by ProjectField id. */
  details: Record<string, Value | null>;
  flow: Flow;
  /** Keyed by step id. */
  cells: Record<string, Cell>;
  /** 0-100 mirror of progress at last write. The app recomputes it from cells at read time. */
  progress: number;
  /** Template revision at last sync (or creation). */
  templateRevision: number;
  /** Sync items the user deliberately declined: itemId -> change hash. */
  syncDismissed: Record<string, string>;
  /** CREATING while steps are still being copied (resumable). */
  setup: "CREATING" | "READY";
  archived: boolean;
  archivedAt?: Iso;
  createdAt: Iso;
  updatedAt: Iso;
}

/** A project's own copy of a milestone (or a project-only step), plus its current value. */
export interface Step extends FieldDef {
  id: string;
  projectId: string;
  /** Library milestone this step was copied from; undefined for project-only steps. */
  milestoneId?: string;
  milestoneKey?: string;
  name: string;
  description: string;
  value: Value | null;
  notApplicable: boolean;
  flag: NodeFlag | null;
  order: number;
  valueSetAt?: Iso;
  stateChangedAt?: Iso;
  lastChangedAt?: Iso;
  /** Optimistic concurrency counter, +1 on every value, flag, N/A or definition write. */
  rev: number;
  archived: boolean;
  archivedAt?: Iso;
  archiveBatch?: string;
  createdAt: Iso;
  updatedAt: Iso;
}

// ---------------------------------------------------------------------------
// Notes, attachments, history
// ---------------------------------------------------------------------------

export interface Note {
  id: string;
  projectId: string;
  stepId?: string;
  body: string;
  author: string;
  archived: boolean;
  createdAt: Iso;
  editedAt?: Iso;
}

export type AttachmentKind = "FILE" | "LINK";

export interface Attachment {
  id: string;
  projectId: string;
  stepId?: string;
  kind: AttachmentKind;
  name: string;
  /** LINK: the URL. FILE: undefined (download through /api/files/[id]). */
  url?: string;
  size?: number;
  contentType?: string;
  archived: boolean;
  createdAt: Iso;
}

export const EVENT_SOURCES = ["MANUAL", "EMAIL", "SYSTEM"] as const;
export type EventSource = (typeof EVENT_SOURCES)[number];

/** A display snapshot of a value at the time of an event, so history stays readable after renames. */
export interface ValueSnapshot {
  raw: Value | null;
  display: string;
  state: State;
}

/** One row of the append-only change log. */
export interface HistoryEvent {
  id: string;
  projectId?: string;
  stepId?: string;
  milestoneId?: string;
  milestoneKey?: string;
  /** e.g. 'step.value_changed', 'note.added', 'project.created', 'milestone.updated'. */
  type: string;
  source: EventSource;
  actor: string;
  /** One-line human summary, e.g. "C0822 · Customer PO / LOI: Awaiting → Full PO". */
  summary: string;
  oldDisplay?: string;
  newDisplay?: string;
  /** Structured payload: { old?: ValueSnapshot, new?: ValueSnapshot, stepName?, ... }. */
  data?: Record<string, unknown>;
  correlationId?: string;
  externalRef?: string;
  occurredAt: Iso;
  recordedAt: Iso;
}

// ---------------------------------------------------------------------------
// Request context passed into domain functions
// ---------------------------------------------------------------------------

export interface DayContext {
  /** Today in the configured timezone, 'YYYY-MM-DD'. */
  today: Ymd;
  /** Configured IANA timezone, e.g. 'Asia/Singapore'. */
  timeZone: string;
}
