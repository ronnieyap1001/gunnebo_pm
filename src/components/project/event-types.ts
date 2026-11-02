/**
 * Plain-English names for History event types (History view filters, row icons, Excel export). Pure module: used by
 * the browser and by the export route.
 */
export interface EventTypeInfo {
  label: string;
  /** Filter group in the History view. */
  group: "values" | "notes" | "files" | "steps" | "arrows" | "project";
}

export const EVENT_TYPES: Record<string, EventTypeInfo> = {
  "step.value_changed": { label: "Value changed", group: "values" },
  "step.na_changed": { label: "Not applicable", group: "values" },
  "step.flag_changed": { label: "Flag", group: "values" },
  "step.date_confirmed": { label: "Date confirmed", group: "values" },
  "step.added": { label: "Step added", group: "steps" },
  "step.updated": { label: "Step edited", group: "steps" },
  "step.archived": { label: "Step archived", group: "steps" },
  "step.restored": { label: "Step restored", group: "steps" },
  "edge.added": { label: "Arrow added", group: "arrows" },
  "edge.archived": { label: "Arrow removed", group: "arrows" },
  "edge.restored": { label: "Arrow restored", group: "arrows" },
  "note.added": { label: "Note added", group: "notes" },
  "note.edited": { label: "Note edited", group: "notes" },
  "note.archived": { label: "Note deleted", group: "notes" },
  "note.restored": { label: "Note restored", group: "notes" },
  "attachment.added": { label: "File or link added", group: "files" },
  "attachment.archived": { label: "File or link removed", group: "files" },
  "attachment.restored": { label: "File or link restored", group: "files" },
  "project.created": { label: "Project created", group: "project" },
  "project.updated": { label: "Details changed", group: "project" },
  "project.code_changed": { label: "Code changed", group: "project" },
  "project.archived": { label: "Project archived", group: "project" },
  "project.restored": { label: "Project restored", group: "project" },
  "project.synced": { label: "Synced from template", group: "project" },
};

export function eventLabel(type: string): string {
  return EVENT_TYPES[type]?.label ?? type.replace(/[._]/g, " ");
}

/** Filter choices for the History view (one event type each, because the filter matches a type exactly). */
export const HISTORY_TYPE_FILTERS: { value: string; label: string }[] = [
  { value: "step.value_changed", label: "Value changes" },
  { value: "step.na_changed", label: "Not applicable" },
  { value: "step.flag_changed", label: "Flags" },
  { value: "step.date_confirmed", label: "Dates confirmed" },
  { value: "note.added", label: "Notes added" },
  { value: "note.edited", label: "Notes edited" },
  { value: "note.archived", label: "Notes deleted" },
  { value: "attachment.added", label: "Files and links added" },
  { value: "attachment.archived", label: "Files and links removed" },
  { value: "step.added", label: "Steps added" },
  { value: "step.updated", label: "Steps edited" },
  { value: "step.archived", label: "Steps archived" },
  { value: "edge.added", label: "Arrows added" },
  { value: "edge.archived", label: "Arrows removed" },
  { value: "project.updated", label: "Details changed" },
  { value: "project.code_changed", label: "Code changed" },
  { value: "project.synced", label: "Syncs" },
  { value: "project.created", label: "Project created" },
];

export const SOURCE_LABELS: Record<"MANUAL" | "EMAIL" | "SYSTEM", string> = {
  MANUAL: "By hand",
  EMAIL: "From email",
  SYSTEM: "By the app",
};
