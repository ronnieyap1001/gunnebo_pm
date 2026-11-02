import { FIELD_TYPES, type FieldType } from "./types";

export interface FieldTypeMeta {
  /** Label shown in the UI and used in Notion's "Field type" select. */
  label: string;
  /** Dropdown and Multiple have a choice list. */
  hasChoices: boolean;
  /** Dropdown choices carry a state tag; Multiple choices do not. */
  choicesHaveState: boolean;
}

export const FIELD_TYPE_META: Record<FieldType, FieldTypeMeta> = {
  TEXT: { label: "Text", hasChoices: false, choicesHaveState: false },
  LONG_TEXT: { label: "Long text", hasChoices: false, choicesHaveState: false },
  NUMBER: { label: "Number", hasChoices: false, choicesHaveState: false },
  PERCENT: { label: "Number (%)", hasChoices: false, choicesHaveState: false },
  DATE: { label: "Date", hasChoices: false, choicesHaveState: false },
  DATE_RANGE: { label: "Date range", hasChoices: false, choicesHaveState: false },
  DROPDOWN: { label: "Dropdown", hasChoices: true, choicesHaveState: true },
  MULTIPLE: { label: "Multiple", hasChoices: true, choicesHaveState: false },
  CHECKBOX: { label: "Checkbox", hasChoices: false, choicesHaveState: false },
  LINK: { label: "Link", hasChoices: false, choicesHaveState: false },
  FILE: { label: "File", hasChoices: false, choicesHaveState: false },
};

/** Extra spellings accepted when reading labels (e.g. from the brief or a hand-edited Notion select). */
const LABEL_ALIASES: Record<string, FieldType> = {
  "dropdown (single)": "DROPDOWN",
  "single select": "DROPDOWN",
  select: "DROPDOWN",
  "multiple (multi-select)": "MULTIPLE",
  "multi-select": "MULTIPLE",
  multiselect: "MULTIPLE",
  "link (url)": "LINK",
  url: "LINK",
  percent: "PERCENT",
  percentage: "PERCENT",
  "number %": "PERCENT",
  "long-text": "LONG_TEXT",
};

function norm(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

const BY_LABEL = new Map<string, FieldType>();
for (const t of FIELD_TYPES) {
  BY_LABEL.set(norm(FIELD_TYPE_META[t].label), t);
  BY_LABEL.set(norm(t), t); // the enum name itself, e.g. 'DATE_RANGE'
  BY_LABEL.set(norm(t.replace(/_/g, " ")), t); // 'date range', 'long text'
}
for (const [alias, t] of Object.entries(LABEL_ALIASES)) BY_LABEL.set(alias, t);

/** The field type for a label ('Number (%)' -> 'PERCENT'), case- and space-insensitive. Undefined when unknown. */
export function fieldTypeFromLabel(label: string): FieldType | undefined {
  if (typeof label !== "string") return undefined;
  return BY_LABEL.get(norm(label));
}

export function isFieldType(value: unknown): value is FieldType {
  return typeof value === "string" && (FIELD_TYPES as readonly string[]).includes(value);
}
