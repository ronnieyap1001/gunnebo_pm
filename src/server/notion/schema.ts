import "server-only";
import type { EventSource, FieldType, NodeFlag, ProjectStatus, State } from "@/domain/types";
import type { PropertyConfig } from "./client";

/**
 * The eight Notion databases, as data. Logical keys (left) never change; Notion names (`name`) are only
 * used when creating the database: afterwards the app reads and writes every property by its id.
 */

/** Bump when databases or properties are added; Setup then adds what is missing. */
export const SCHEMA_VERSION = 1;
/** Version written into the database description marker (`gunnebo-pm:<key>:v1`). */
export const MARKER_VERSION = 1;

export type DbKey = "settings" | "projectFields" | "milestones" | "projects" | "steps" | "history" | "notes" | "files";

/** Creation order: every relation points at a database created earlier. */
export const DB_ORDER: readonly DbKey[] = [
  "settings",
  "projectFields",
  "milestones",
  "projects",
  "steps",
  "history",
  "notes",
  "files",
];

export type SelectColor = "default" | "gray" | "brown" | "orange" | "yellow" | "green" | "blue" | "purple" | "pink" | "red";

export type PropKind =
  | "title"
  | "rich_text"
  | "number"
  | "select"
  | "checkbox"
  | "date"
  | "relation"
  | "url"
  | "files"
  | "created_time";

export interface SelectOptionDef {
  name: string;
  color: SelectColor;
}

export interface PropDef {
  /** Name used when the property is created. Users may rename it in Notion; the app keeps working. */
  name: string;
  type: PropKind;
  /** Short note shown in Notion's property tooltip. The `[gpm:<key>]` marker is appended. */
  hint?: string;
  /** Pre-created select options (with colours). */
  options?: readonly SelectOptionDef[];
  /** Number format. */
  format?: "number" | "percent";
  relation?: { target: DbKey; dual?: { syncedName: string } };
  /** Created by another database's dual relation (never created directly). */
  backOf?: { db: DbKey; prop: string };
}

export interface DbDef {
  key: DbKey;
  title: string;
  description: string;
  props: Readonly<Record<string, PropDef>>;
}

// ---------------------------------------------------------------------------
// Labels shared by the schema and the repositories
// ---------------------------------------------------------------------------

export const FIELD_TYPE_LABELS: Readonly<Record<FieldType, string>> = {
  TEXT: "Text",
  LONG_TEXT: "Long text",
  NUMBER: "Number",
  PERCENT: "Number (%)",
  DATE: "Date",
  DATE_RANGE: "Date range",
  DROPDOWN: "Dropdown",
  MULTIPLE: "Multiple",
  CHECKBOX: "Checkbox",
  LINK: "Link",
  FILE: "File",
};

export const STATE_LABELS: Readonly<Record<State, string>> = {
  NOT_STARTED: "Not started",
  IN_PROGRESS: "In progress",
  WAITING: "Waiting",
  BLOCKED: "Blocked",
  DONE: "Done",
  NOT_APPLICABLE: "Not applicable",
};

export const STATE_CODES: Readonly<Record<State, string>> = {
  NOT_STARTED: "NS",
  IN_PROGRESS: "IP",
  WAITING: "W",
  BLOCKED: "B",
  DONE: "D",
  NOT_APPLICABLE: "NA",
};

export const PROJECT_STATUS_LABELS: Readonly<Record<ProjectStatus, string>> = {
  ACTIVE: "Active",
  ON_HOLD: "On hold",
  CLOSED: "Closed",
};

export const FLAG_LABELS: Readonly<Record<NodeFlag, string>> = { WAITING: "Waiting", BLOCKED: "Blocked" };

export const SOURCE_LABELS: Readonly<Record<EventSource, string>> = { MANUAL: "Manual", EMAIL: "Email", SYSTEM: "System" };

export const SETUP_LABELS = { CREATING: "Creating", READY: "Ready" } as const;

export const KIND_LABELS = { FILE: "File", LINK: "Link" } as const;

/** Event types known when the schema was written (pre-created in History → Type; others are added on first use). */
export const KNOWN_EVENT_TYPES: readonly string[] = [
  "project.created",
  "project.updated",
  "project.code_changed",
  "project.archived",
  "project.restored",
  "project.synced",
  "node.value_changed",
  "node.na_changed",
  "node.flag_changed",
  "node.added",
  "node.updated",
  "node.archived",
  "node.restored",
  "node.definition_synced",
  "node.type_adopted",
  "edge.added",
  "edge.archived",
  "edge.restored",
  "note.added",
  "note.edited",
  "note.archived",
  "attachment.added",
  "attachment.archived",
  "milestone.created",
  "milestone.updated",
  "milestone.archived",
  "milestone.restored",
  "milestone.reordered",
  "template.edge_added",
  "template.edge_archived",
  "template.imported",
  "template.snapshot",
  "project_field.created",
  "project_field.updated",
  "project_field.archived",
  "project_field.restored",
  "system.setup",
];

/** Reverse lookup for a label table; also accepts the enum name itself. */
export function fromLabel<K extends string>(table: Readonly<Record<K, string>>, label: string | null | undefined): K | undefined {
  if (!label) return undefined;
  const norm = label.trim().toLowerCase();
  for (const [k, v] of Object.entries(table) as [K, string][]) {
    if (v.toLowerCase() === norm || k.toLowerCase() === norm) return k;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Database definitions
// ---------------------------------------------------------------------------

const fieldTypeOptions: SelectOptionDef[] = [
  { name: "Text", color: "default" },
  { name: "Long text", color: "default" },
  { name: "Number", color: "brown" },
  { name: "Number (%)", color: "brown" },
  { name: "Date", color: "orange" },
  { name: "Date range", color: "orange" },
  { name: "Dropdown", color: "purple" },
  { name: "Multiple", color: "purple" },
  { name: "Checkbox", color: "green" },
  { name: "Link", color: "blue" },
  { name: "File", color: "blue" },
];

const stateOptions: SelectOptionDef[] = [
  { name: "Not started", color: "gray" },
  { name: "In progress", color: "blue" },
  { name: "Waiting", color: "yellow" },
  { name: "Blocked", color: "red" },
  { name: "Done", color: "green" },
  { name: "Not applicable", color: "default" },
];

const JSON_HINT = "App data (JSON). Do not edit.";
const MIRROR_HINT = "Copy for browsing in Notion; the app rewrites it.";

const archivedProps = {
  archived: { name: "Archived", type: "checkbox" },
  archivedAt: { name: "Archived at", type: "date" },
} as const satisfies Record<string, PropDef>;

export const SCHEMA: Readonly<Record<DbKey, DbDef>> = {
  settings: {
    key: "settings",
    title: "Settings",
    description: "App settings and template data for Gunnebo PM.",
    props: {
      key: { name: "Key", type: "title" },
      value: { name: "Value", type: "rich_text", hint: JSON_HINT },
    },
  },
  projectFields: {
    key: "projectFields",
    title: "Project fields",
    description: "The configurable detail fields of a project (Customer, Site, …).",
    props: {
      label: { name: "Label", type: "title" },
      key: { name: "Key", type: "rich_text", hint: "Fixed key; never changes." },
      fieldType: { name: "Field type", type: "select", options: fieldTypeOptions },
      choices: { name: "Choices", type: "rich_text", hint: JSON_HINT },
      config: { name: "Config", type: "rich_text", hint: JSON_HINT },
      order: { name: "Order", type: "number" },
      showInSummary: { name: "Show in summary", type: "checkbox" },
      systemKey: { name: "System key", type: "rich_text" },
      ...archivedProps,
    },
  },
  milestones: {
    key: "milestones",
    title: "Milestones",
    description: "The milestone library. Change milestones in the app.",
    props: {
      name: { name: "Name", type: "title" },
      key: { name: "Key", type: "rich_text", hint: "Fixed key for automations; never changes." },
      fieldType: { name: "Field type", type: "select", options: fieldTypeOptions },
      choices: { name: "Choices", type: "rich_text", hint: JSON_HINT },
      choicesReadable: { name: "Choices (readable)", type: "rich_text", hint: MIRROR_HINT },
      config: { name: "Config", type: "rich_text", hint: JSON_HINT },
      description: { name: "Description", type: "rich_text" },
      order: { name: "Order", type: "number" },
      ...archivedProps,
      archiveBatch: { name: "Archive batch", type: "rich_text" },
    },
  },
  projects: {
    key: "projects",
    title: "Projects",
    description: "One row per project. Change values in the app; Notion is a view.",
    props: {
      code: { name: "Code", type: "title" },
      name: { name: "Name", type: "rich_text" },
      status: {
        name: "Status",
        type: "select",
        options: [
          { name: "Active", color: "blue" },
          { name: "On hold", color: "yellow" },
          { name: "Closed", color: "gray" },
        ],
      },
      customer: { name: "Customer", type: "select", hint: MIRROR_HINT },
      projectType: { name: "Project type", type: "select", hint: MIRROR_HINT },
      summary: { name: "Summary", type: "rich_text", hint: MIRROR_HINT },
      details: { name: "Details", type: "rich_text", hint: JSON_HINT },
      flow: { name: "Flow", type: "rich_text", hint: JSON_HINT },
      cells: { name: "Cells", type: "rich_text", hint: JSON_HINT },
      progress: { name: "Progress", type: "number", format: "percent", hint: MIRROR_HINT },
      current: { name: "Current", type: "rich_text", hint: MIRROR_HINT },
      templateRevision: { name: "Template revision", type: "number" },
      syncDismissed: { name: "Sync dismissed", type: "rich_text", hint: JSON_HINT },
      setup: {
        name: "Setup",
        type: "select",
        options: [
          { name: "Creating", color: "yellow" },
          { name: "Ready", color: "green" },
        ],
      },
      ...archivedProps,
      steps: { name: "Steps", type: "relation", backOf: { db: "steps", prop: "project" } },
    },
  },
  steps: {
    key: "steps",
    title: "Steps",
    description: "Project steps (one per milestone per project). Change values in the app; Notion is a view.",
    props: {
      name: { name: "Name", type: "title" },
      project: { name: "Project", type: "relation", relation: { target: "projects", dual: { syncedName: "Steps" } } },
      milestone: { name: "Milestone", type: "relation", relation: { target: "milestones" } },
      milestoneKey: { name: "Milestone key", type: "rich_text" },
      fieldType: { name: "Field type", type: "select", options: fieldTypeOptions },
      choices: { name: "Choices", type: "rich_text", hint: JSON_HINT },
      config: { name: "Config", type: "rich_text", hint: JSON_HINT },
      description: { name: "Description", type: "rich_text" },
      valueData: { name: "Value data", type: "rich_text", hint: JSON_HINT },
      value: { name: "Value", type: "rich_text", hint: MIRROR_HINT },
      date: { name: "Date", type: "date", hint: MIRROR_HINT },
      state: { name: "State", type: "select", options: stateOptions, hint: MIRROR_HINT },
      notApplicable: { name: "Not applicable", type: "checkbox" },
      flag: {
        name: "Flag",
        type: "select",
        options: [
          { name: "Waiting", color: "yellow" },
          { name: "Blocked", color: "red" },
        ],
      },
      order: { name: "Order", type: "number" },
      valueSetAt: { name: "Value set at", type: "date" },
      stateChangedAt: { name: "State changed at", type: "date" },
      lastChangedAt: { name: "Last changed at", type: "date" },
      rev: { name: "Rev", type: "number" },
      ...archivedProps,
      archiveBatch: { name: "Archive batch", type: "rich_text" },
      stepKey: { name: "Step key", type: "rich_text", hint: "Unique per project; keeps creation batches from duplicating." },
      lastOp: { name: "Last op", type: "rich_text" },
    },
  },
  history: {
    key: "history",
    title: "History",
    description: "Append-only change log. Rows carry a hash so edits can be detected (tamper-evident, not tamper-proof).",
    props: {
      summary: { name: "Summary", type: "title" },
      project: { name: "Project", type: "relation", relation: { target: "projects" } },
      step: { name: "Step", type: "relation", relation: { target: "steps" } },
      relatedSteps: {
        name: "Related steps",
        type: "relation",
        relation: { target: "steps" },
        hint: "Other steps a bulk change touched (data.stepIds).",
      },
      milestone: { name: "Milestone", type: "relation", relation: { target: "milestones" } },
      milestoneKey: { name: "Milestone key", type: "rich_text" },
      type: { name: "Type", type: "select", options: KNOWN_EVENT_TYPES.map((name) => ({ name, color: "default" as const })) },
      source: {
        name: "Source",
        type: "select",
        options: [
          { name: "Manual", color: "blue" },
          { name: "Email", color: "purple" },
          { name: "System", color: "gray" },
        ],
      },
      actor: { name: "Actor", type: "rich_text" },
      oldValue: { name: "Old value", type: "rich_text" },
      newValue: { name: "New value", type: "rich_text" },
      data: { name: "Data", type: "rich_text", hint: JSON_HINT },
      correlation: { name: "Correlation", type: "rich_text" },
      externalRef: { name: "External ref", type: "rich_text" },
      occurredAt: { name: "Occurred at", type: "date" },
      occurredAtExact: {
        name: "Occurred at (exact)",
        type: "rich_text",
        hint: "Exact time (ISO, UTC); Occurred at is the calendar copy.",
      },
      seq: { name: "Seq", type: "number", hint: "Ordering key (epoch ms × 1000 + counter)." },
      opId: { name: "Op id", type: "rich_text" },
      hash: { name: "Hash", type: "rich_text", hint: "sha256 of the row content." },
      recorded: { name: "Recorded", type: "created_time" },
    },
  },
  notes: {
    key: "notes",
    title: "Notes",
    description: "Notes on projects and steps.",
    props: {
      title: { name: "Title", type: "title", hint: "First line of the note." },
      body: { name: "Body", type: "rich_text" },
      project: { name: "Project", type: "relation", relation: { target: "projects" } },
      step: { name: "Step", type: "relation", relation: { target: "steps" } },
      author: { name: "Author", type: "rich_text" },
      archived: { name: "Archived", type: "checkbox" },
      createdAt: { name: "Created at", type: "date" },
      editedAt: { name: "Edited at", type: "date" },
    },
  },
  files: {
    key: "files",
    title: "Files & links",
    description: "Files (up to 4 MB) and links attached to projects and steps.",
    props: {
      name: { name: "Name", type: "title" },
      project: { name: "Project", type: "relation", relation: { target: "projects" } },
      step: { name: "Step", type: "relation", relation: { target: "steps" } },
      kind: {
        name: "Kind",
        type: "select",
        options: [
          { name: "File", color: "blue" },
          { name: "Link", color: "purple" },
        ],
      },
      link: { name: "Link", type: "url" },
      file: { name: "File", type: "files" },
      size: { name: "Size", type: "number" },
      contentType: { name: "Content type", type: "rich_text" },
      ...archivedProps,
      createdAt: { name: "Created at", type: "date" },
    },
  },
};

// ---------------------------------------------------------------------------
// Markers
// ---------------------------------------------------------------------------

export function dbMarker(key: DbKey): string {
  return `gunnebo-pm:${key}:v${MARKER_VERSION}`;
}

const DB_MARKER_RE = /gunnebo-pm:([A-Za-z]+):v(\d+)/;

/** The logical database key in a database description, if it carries a marker. */
export function parseDbMarker(description: string): DbKey | null {
  const m = DB_MARKER_RE.exec(description);
  if (!m) return null;
  const key = m[1] as DbKey;
  return key in SCHEMA ? key : null;
}

export function propMarker(key: string): string {
  return `[gpm:${key}]`;
}

const PROP_MARKER_RE = /\[gpm:([A-Za-z]+)\]/;

export function parsePropMarker(description: string | null | undefined): string | null {
  if (!description) return null;
  const m = PROP_MARKER_RE.exec(description);
  return m ? m[1] : null;
}

export function dbDescription(key: DbKey): string {
  return `${SCHEMA[key].description} (${dbMarker(key)})`;
}

/** Property definition for databases.create / dataSources.update. `dsId` resolves relation targets. */
export function propertyConfig(propKey: string, def: PropDef, dsId: (db: DbKey) => string): PropertyConfig {
  const description = def.hint ? `${def.hint} ${propMarker(propKey)}` : propMarker(propKey);
  switch (def.type) {
    case "title":
      return { type: "title", title: {}, description };
    case "rich_text":
      return { type: "rich_text", rich_text: {}, description };
    case "number":
      return { type: "number", number: { format: def.format ?? "number" }, description };
    case "select":
      return {
        type: "select",
        select: { options: (def.options ?? []).map((o) => ({ name: o.name, color: o.color })) },
        description,
      };
    case "checkbox":
      return { type: "checkbox", checkbox: {}, description };
    case "date":
      return { type: "date", date: {}, description };
    case "url":
      return { type: "url", url: {}, description };
    case "files":
      return { type: "files", files: {}, description };
    case "created_time":
      return { type: "created_time", created_time: {}, description };
    case "relation": {
      if (!def.relation) throw new Error(`propertyConfig: ${propKey} has no relation target`);
      const data_source_id = dsId(def.relation.target);
      if (def.relation.dual) {
        return {
          type: "relation",
          relation: {
            data_source_id,
            type: "dual_property",
            dual_property: { synced_property_name: def.relation.dual.syncedName },
          },
          description,
        };
      }
      return { type: "relation", relation: { data_source_id, type: "single_property", single_property: {} }, description };
    }
  }
}

/** Select option names may not contain commas (Notion rejects them) and are kept to 100 characters. */
export function sanitizeSelectName(s: string | null | undefined): string | null {
  if (!s) return null;
  const clean = s.replace(/\s*,\s*/g, " · ").replace(/\s+/g, " ").trim();
  if (!clean) return null;
  if (clean.length <= 100) return clean;
  let end = 99;
  const c = clean.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end -= 1;
  return `${clean.slice(0, end)}…`;
}

/** Display title for a database key (also accepts a title). */
export function dbKeyFrom(nameOrKey: string): DbKey | undefined {
  if (nameOrKey in SCHEMA) return nameOrKey as DbKey;
  const norm = nameOrKey.trim().toLowerCase();
  return DB_ORDER.find((k) => SCHEMA[k].title.toLowerCase() === norm);
}
