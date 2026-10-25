/**
 * Display text for values: node value lines, tooltips, list cells, Excel and history snapshots.
 */
import { formatYmd } from "./dates";
import { FIELD_TYPES } from "./types";
import type {
  Choice,
  DateRangeValue,
  DateValue,
  DropdownValue,
  FieldDef,
  LinkValue,
  MultipleValue,
  NumberValue,
  PercentValue,
  TextValue,
  Value,
  Ymd,
} from "./types";
import { isEmptyValue, isValidValue } from "./values";

export const EMPTY_DISPLAY = "—";
export const INVALID_DISPLAY = "Invalid value";
export const UNKNOWN_CHOICE_DISPLAY = "Unknown choice";
const SHORT_TEXT_LENGTH = 40;
const SHORT_MULTIPLE_COUNT = 2;

export interface FormatOptions {
  /** FILE fields: number of active attachments (files and links). */
  attachmentCount?: number;
  /** Compact form for node cards, Portfolio cells and the "My open items" list. */
  short?: boolean;
  /** When given, future dates show as 'Plan 12 Nov 2026'. */
  today?: Ymd;
}

const numberFormat = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 6, useGrouping: true });

/** '1,234.5', no rounding to integers. */
export function formatNumber(n: number): string {
  return numberFormat.format(n);
}

/** Truncates to `max` characters (not splitting surrogate pairs) and adds '…' when cut. */
export function truncate(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return chars.slice(0, max).join("").trimEnd() + "…";
}

function choiceLabel(choice: Choice | undefined, markRetired: boolean): string {
  if (!choice) return UNKNOWN_CHOICE_DISPLAY;
  return choice.archived && markRetired ? `${choice.label} (retired)` : choice.label;
}

/** The host name of a URL without a leading 'www.'; the URL itself if it cannot be parsed. */
export function linkHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, "");
  } catch {
    return url;
  }
}

export function formatValue(def: FieldDef, value: Value | null, opts: FormatOptions = {}): string {
  const t = def.fieldType;
  const short = opts.short === true;

  if (t === "FILE") {
    const n = Math.max(0, Math.floor(opts.attachmentCount ?? 0));
    if (n === 0) return EMPTY_DISPLAY;
    return n === 1 ? "1 file" : `${n} files`;
  }
  if (value === null || value === undefined) return EMPTY_DISPLAY;
  if (!(FIELD_TYPES as readonly string[]).includes(t)) return INVALID_DISPLAY; // unknown type: can't read the value
  if (!isValidValue(t, value)) return INVALID_DISPLAY;
  if (isEmptyValue(t, value)) return EMPTY_DISPLAY;

  const choices = def.choices ?? [];
  switch (t) {
    case "DROPDOWN": {
      const id = (value as DropdownValue).choiceId;
      return choiceLabel(
        choices.find((c) => c.id === id),
        true,
      );
    }
    case "MULTIPLE": {
      const labels = (value as MultipleValue).choiceIds.map((id) =>
        choiceLabel(
          choices.find((c) => c.id === id),
          !short,
        ),
      );
      if (short && labels.length > SHORT_MULTIPLE_COUNT) {
        return `${labels.slice(0, SHORT_MULTIPLE_COUNT).join(", ")} +${labels.length - SHORT_MULTIPLE_COUNT}`;
      }
      return labels.join(", ");
    }
    case "DATE": {
      const date = (value as DateValue).date;
      const text = formatYmd(date);
      return opts.today && date > opts.today ? `Plan ${text}` : text;
    }
    case "DATE_RANGE": {
      const { start, end } = value as DateRangeValue;
      if (start && end) return `${formatYmd(start)} → ${formatYmd(end)}`;
      if (start) return `From ${formatYmd(start)}`;
      return `Until ${formatYmd(end as string)}`;
    }
    case "PERCENT":
      return `${(value as PercentValue).percent} %`;
    case "NUMBER": {
      const unit = def.config?.unit?.trim();
      const n = formatNumber((value as NumberValue).number);
      return unit ? `${n} ${unit}` : n;
    }
    case "TEXT":
    case "LONG_TEXT": {
      const text = (value as TextValue).text.trim();
      return short ? truncate(text.replace(/\s+/g, " "), SHORT_TEXT_LENGTH) : text;
    }
    case "CHECKBOX":
      return "Yes";
    case "LINK": {
      const { url, label } = value as LinkValue;
      const l = label?.trim();
      if (l) return short ? truncate(l, SHORT_TEXT_LENGTH) : l;
      return linkHost(url);
    }
  }
}
