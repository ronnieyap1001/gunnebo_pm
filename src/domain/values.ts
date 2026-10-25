/**
 * Value schemas (for stored values) and normalisation (for user input).
 * A stored value is `null` when empty; FILE fields never store a value.
 */
import { z } from "zod";
import { isValidYmd } from "./dates";
import type {
  Choice,
  CheckboxValue,
  DateRangeValue,
  DateValue,
  DropdownValue,
  FieldDef,
  FieldType,
  LinkValue,
  MultipleValue,
  NumberValue,
  PercentValue,
  TextValue,
  Value,
} from "./types";

/** Maximum length of a text value, a link label and a URL. */
export const MAX_TEXT_LENGTH = 50_000;
export const MAX_LINK_LABEL_LENGTH = 500;
export const MAX_URL_LENGTH = 2_000;

/** True for an absolute http:// or https:// URL with a host. */
export function isHttpUrl(text: string): boolean {
  if (typeof text !== "string" || /\s/.test(text) || text.length > MAX_URL_LENGTH) return false;
  try {
    const url = new URL(text);
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname.length > 0;
  } catch {
    return false;
  }
}

/**
 * Reads what someone typed in a percent box: "45", "12.5", "12,5", "80 %". Rounds to a whole percent.
 * Empty means 0. Returns null for anything that is not a number from 0 to 100.
 */
export function parsePercentInput(text: string): number | null {
  if (!text.trim()) return 0;
  const t = text.trim().replace(/\s*%$/, "").replace(",", ".");
  if (!/^\d+(\.\d*)?$|^\.\d+$/.test(t)) return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n > 100) return null;
  return Math.round(n);
}

const ymdSchema = z.string().refine(isValidYmd, { message: "must be a valid date (YYYY-MM-DD)" });

const textSchema = z.strictObject({ text: z.string() });
const numberSchema = z.strictObject({ number: z.number() });
const percentSchema = z.strictObject({ percent: z.number().int().min(0).max(100) });
const dateSchema = z.strictObject({ date: ymdSchema });
const dateRangeSchema = z
  .strictObject({ start: ymdSchema.optional(), end: ymdSchema.optional() })
  .refine((v) => !v.start || !v.end || v.start <= v.end, { message: "start must be on or before end" });
const dropdownSchema = z.strictObject({ choiceId: z.string().min(1) });
const multipleSchema = z.strictObject({ choiceIds: z.array(z.string().min(1)) });
const checkboxSchema = z.strictObject({ checked: z.literal(true) });
const linkSchema = z.strictObject({
  url: z.string().refine(isHttpUrl, { message: "must be an http:// or https:// address" }),
  label: z.string().optional(),
});

const SCHEMAS: Record<FieldType, z.ZodType<Value> | null> = {
  TEXT: textSchema as z.ZodType<Value>,
  LONG_TEXT: textSchema as z.ZodType<Value>,
  NUMBER: numberSchema as z.ZodType<Value>,
  PERCENT: percentSchema as z.ZodType<Value>,
  DATE: dateSchema as z.ZodType<Value>,
  DATE_RANGE: dateRangeSchema as z.ZodType<Value>,
  DROPDOWN: dropdownSchema as z.ZodType<Value>,
  MULTIPLE: multipleSchema as z.ZodType<Value>,
  CHECKBOX: checkboxSchema as z.ZodType<Value>,
  LINK: linkSchema as z.ZodType<Value>,
  FILE: null,
};

/** The zod schema of a stored (non-null) value of this type. FILE has none (it never stores a value). */
export function valueSchema(t: FieldType): z.ZodType<Value> | null {
  return SCHEMAS[t];
}

/** True when a stored value has the right shape for its type. `null` (empty) is always valid. */
export function isValidValue(t: FieldType, v: Value | null): boolean {
  if (v === null) return true;
  const schema = SCHEMAS[t];
  if (!schema) return true; // FILE: any stored value is ignored
  return schema.safeParse(v).success;
}

/** True when the value counts as empty for its type (null, blank text, nothing selected, unticked, empty range). */
export function isEmptyValue(t: FieldType, v: Value | null): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v !== "object") return true;
  switch (t) {
    case "TEXT":
    case "LONG_TEXT": {
      const text = (v as Partial<TextValue>).text;
      return typeof text !== "string" || text.trim() === "";
    }
    case "NUMBER":
      return typeof (v as Partial<NumberValue>).number !== "number";
    case "PERCENT":
      return typeof (v as Partial<PercentValue>).percent !== "number";
    case "DATE":
      return !(v as Partial<DateValue>).date;
    case "DATE_RANGE": {
      const r = v as DateRangeValue;
      return !r.start && !r.end;
    }
    case "DROPDOWN":
      return !(v as Partial<DropdownValue>).choiceId;
    case "MULTIPLE": {
      const ids = (v as Partial<MultipleValue>).choiceIds;
      return !Array.isArray(ids) || ids.length === 0;
    }
    case "CHECKBOX":
      return (v as Partial<CheckboxValue>).checked !== true;
    case "LINK": {
      const url = (v as Partial<LinkValue>).url;
      return typeof url !== "string" || url.trim() === "";
    }
    case "FILE":
      return true;
  }
}

// ---------------------------------------------------------------------------
// Normalising user input
// ---------------------------------------------------------------------------

export type NormalizeResult = { ok: true; value: Value | null } | { ok: false; error: string };

const ok = (value: Value | null): NormalizeResult => ({ ok: true, value });
const fail = (error: string): NormalizeResult => ({ ok: false, error });

function isRecord(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}

/** Unwraps `{key: x}` to `x`; leaves anything else alone. */
function unwrap(raw: unknown, key: string): unknown {
  return isRecord(raw) && key in raw ? raw[key] : raw;
}

function isBlank(raw: unknown): boolean {
  return raw === null || raw === undefined || (typeof raw === "string" && raw.trim() === "");
}

function normalizeText(raw: unknown): NormalizeResult {
  const text = unwrap(raw, "text");
  if (isBlank(text)) return ok(null);
  if (typeof text !== "string") return fail("Enter some text.");
  const trimmed = text.trim();
  if (trimmed.length > MAX_TEXT_LENGTH) {
    return fail("The text is too long (maximum 50,000 characters).");
  }
  return ok({ text: trimmed });
}

function toNumber(raw: unknown): number | null {
  if (typeof raw === "number") return raw;
  if (typeof raw === "string") {
    const cleaned = raw.trim().replace(/[\s,]/g, "").replace(/%$/, "");
    if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(cleaned)) return null;
    return Number(cleaned);
  }
  return null;
}

function normalizeNumber(raw: unknown): NormalizeResult {
  const input = unwrap(raw, "number");
  if (isBlank(input)) return ok(null);
  const n = toNumber(input);
  if (n === null || !Number.isFinite(n)) return fail("Enter a number, for example 24 or 3.5.");
  return ok({ number: n === 0 ? 0 : n }); // no -0
}

function normalizePercent(raw: unknown): NormalizeResult {
  const input = unwrap(raw, "percent");
  if (isBlank(input)) return ok(null);
  const n = toNumber(input);
  if (n === null || !Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > 100) {
    return fail("Enter a whole number from 0 to 100.");
  }
  return ok({ percent: n === 0 ? 0 : n });
}

function normalizeYmdInput(raw: unknown): { ok: true; ymd?: string } | { ok: false } {
  if (isBlank(raw)) return { ok: true };
  if (typeof raw !== "string") return { ok: false };
  const s = raw.trim();
  return isValidYmd(s) ? { ok: true, ymd: s } : { ok: false };
}

function normalizeDate(raw: unknown): NormalizeResult {
  const r = normalizeYmdInput(unwrap(raw, "date"));
  if (!r.ok) return fail("Enter a valid date.");
  return ok(r.ymd ? { date: r.ymd } : null);
}

function normalizeDateRange(raw: unknown): NormalizeResult {
  if (isBlank(raw)) return ok(null);
  if (!isRecord(raw)) return fail("Enter a start date, an end date, or both.");
  const start = normalizeYmdInput(raw.start);
  if (!start.ok) return fail("The start date is not a valid date.");
  const end = normalizeYmdInput(raw.end);
  if (!end.ok) return fail("The end date is not a valid date.");
  if (!start.ymd && !end.ymd) return ok(null);
  if (start.ymd && end.ymd && start.ymd > end.ymd) return fail("The start date must be on or before the end date.");
  const value: DateRangeValue = {};
  if (start.ymd) value.start = start.ymd;
  if (end.ymd) value.end = end.ymd;
  return ok(value);
}

function normalizeDropdown(raw: unknown, choices: Choice[]): NormalizeResult {
  const id = unwrap(raw, "choiceId");
  if (isBlank(id)) return ok(null);
  if (typeof id !== "string") return fail("Pick one of the choices.");
  if (!choices.some((c) => c.id === id)) return fail("That choice is not in this list. Pick another one.");
  return ok({ choiceId: id });
}

function normalizeMultiple(raw: unknown, choices: Choice[]): NormalizeResult {
  const ids = unwrap(raw, "choiceIds");
  if (ids === null || ids === undefined) return ok(null);
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) return fail("Pick from the choices.");
  const wanted = new Set(ids as string[]);
  const unknown = [...wanted].filter((id) => !choices.some((c) => c.id === id));
  if (unknown.length > 0) {
    return fail(
      unknown.length === 1
        ? "One of the selected choices is not in this list."
        : `${unknown.length} of the selected choices are not in this list.`,
    );
  }
  const ordered = choices.filter((c) => wanted.has(c.id)).map((c) => c.id);
  return ok(ordered.length === 0 ? null : { choiceIds: ordered });
}

function normalizeCheckbox(raw: unknown): NormalizeResult {
  const checked = unwrap(raw, "checked");
  if (checked === true || checked === "true") return ok({ checked: true });
  if (checked === false || checked === "false" || isBlank(checked)) return ok(null);
  return fail("Tick or untick the box.");
}

function normalizeLink(raw: unknown): NormalizeResult {
  let url: unknown = raw;
  let label: unknown;
  if (isRecord(raw)) {
    url = raw.url;
    label = raw.label;
  }
  if (isBlank(url)) return ok(null);
  if (typeof url !== "string") return fail("Enter a web address starting with http:// or https://.");
  const trimmed = url.trim();
  if (trimmed.length > MAX_URL_LENGTH) return fail("The web address is too long.");
  if (!isHttpUrl(trimmed)) return fail("Enter a web address starting with http:// or https://.");
  const value: LinkValue = { url: trimmed };
  if (label !== undefined && label !== null) {
    if (typeof label !== "string") return fail("The link label must be text.");
    const l = label.trim();
    if (l.length > MAX_LINK_LABEL_LENGTH) {
      return fail(`The link label is too long (maximum ${MAX_LINK_LABEL_LENGTH} characters).`);
    }
    if (l) value.label = l;
  }
  return ok(value);
}

/**
 * Validates and normalises user input for a field. Accepts either the stored shape (e.g. `{choiceId}`) or the bare
 * input (e.g. a string id, a number, a boolean). Empty input gives `{ok: true, value: null}`.
 */
export function normalizeValue(def: FieldDef, raw: unknown): NormalizeResult {
  switch (def.fieldType) {
    case "TEXT":
    case "LONG_TEXT":
      return normalizeText(raw);
    case "NUMBER":
      return normalizeNumber(raw);
    case "PERCENT":
      return normalizePercent(raw);
    case "DATE":
      return normalizeDate(raw);
    case "DATE_RANGE":
      return normalizeDateRange(raw);
    case "DROPDOWN":
      return normalizeDropdown(raw, def.choices ?? []);
    case "MULTIPLE":
      return normalizeMultiple(raw, def.choices ?? []);
    case "CHECKBOX":
      return normalizeCheckbox(raw);
    case "LINK":
      return normalizeLink(raw);
    case "FILE":
      return ok(null);
    default:
      return fail("This field has an unknown type.");
  }
}
