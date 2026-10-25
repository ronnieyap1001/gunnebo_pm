/**
 * Lossless value conversions between field types (DESIGN.md section 12, "Lossless type conversions").
 * Used by sync (template type changes), project-only step edits and project-field retypes.
 */
import { FIELD_TYPE_META } from "./fieldTypes";
import type {
  Choice,
  DateValue,
  DropdownValue,
  FieldType,
  MultipleValue,
  NumberValue,
  PercentValue,
  TextValue,
  Value,
} from "./types";
import { isEmptyValue, isHttpUrl, isValidValue } from "./values";

export type ConvertResult = { ok: true; value: Value | null } | { ok: false; reason: string };

const label = (t: FieldType) => FIELD_TYPE_META[t]?.label ?? t;

function missingChoices(ids: string[], toChoices: Choice[] | undefined): string[] {
  if (!toChoices) return [];
  return ids.filter((id) => !toChoices.some((c) => c.id === id));
}

function choiceCheck(ids: string[], toChoices: Choice[] | undefined, value: Value): ConvertResult {
  const missing = missingChoices(ids, toChoices);
  if (missing.length > 0) {
    return {
      ok: false,
      reason:
        missing.length === 1
          ? "The selected choice does not exist in the new choice list."
          : "Some selected choices do not exist in the new choice list.",
    };
  }
  return { ok: true, value };
}

/**
 * Converts a value from one field type to another without losing information.
 * - null (or an empty value) -> ok null; same type -> ok, unchanged.
 * - TEXT <-> LONG_TEXT; DROPDOWN -> MULTIPLE; MULTIPLE -> DROPDOWN (0 or 1 selected); PERCENT -> NUMBER;
 *   NUMBER -> PERCENT (integer 0..100); DATE -> DATE_RANGE ({start}); TEXT / LONG_TEXT -> LINK (valid http(s) URL).
 * - With `toChoices`, the resulting DROPDOWN / MULTIPLE ids must exist in it.
 * - Anything else -> ok:false with a plain-English reason.
 */
export function convertValue(from: FieldType, to: FieldType, value: Value | null, toChoices?: Choice[]): ConvertResult {
  if (value === null || value === undefined) return { ok: true, value: null };
  if (from === to) return { ok: true, value };
  if (!isValidValue(from, value)) {
    return { ok: false, reason: `The current value is not a valid ${label(from)} value.` };
  }
  if (from === "FILE" || isEmptyValue(from, value)) return { ok: true, value: null };

  const cannot: ConvertResult = {
    ok: false,
    reason: `A ${label(from)} value can't be changed into a ${label(to)} value without losing it.`,
  };

  switch (`${from}->${to}`) {
    case "TEXT->LONG_TEXT":
    case "LONG_TEXT->TEXT":
      return { ok: true, value: { text: (value as TextValue).text } };

    case "DROPDOWN->MULTIPLE": {
      const id = (value as DropdownValue).choiceId;
      return choiceCheck([id], toChoices, { choiceIds: [id] });
    }

    case "MULTIPLE->DROPDOWN": {
      const ids = [...new Set((value as MultipleValue).choiceIds)];
      if (ids.length === 0) return { ok: true, value: null };
      if (ids.length > 1) {
        return { ok: false, reason: `${ids.length} choices are selected, but a Dropdown can hold only one.` };
      }
      return choiceCheck(ids, toChoices, { choiceId: ids[0] });
    }

    case "PERCENT->NUMBER":
      return { ok: true, value: { number: (value as PercentValue).percent } };

    case "NUMBER->PERCENT": {
      const n = (value as NumberValue).number;
      if (Number.isInteger(n) && n >= 0 && n <= 100) return { ok: true, value: { percent: n } };
      return { ok: false, reason: `The number ${n} is not a whole number from 0 to 100.` };
    }

    case "DATE->DATE_RANGE":
      return { ok: true, value: { start: (value as DateValue).date } };

    case "TEXT->LINK":
    case "LONG_TEXT->LINK": {
      const text = (value as TextValue).text.trim();
      if (isHttpUrl(text)) return { ok: true, value: { url: text } };
      return { ok: false, reason: "The text is not a web address starting with http:// or https://." };
    }

    default:
      return cannot;
  }
}

/** True when a value can be converted (null always can). */
export function canConvertValue(from: FieldType, to: FieldType, value: Value | null, toChoices?: Choice[]): boolean {
  return convertValue(from, to, value, toChoices).ok;
}
