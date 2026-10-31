import { describe, expect, it } from "vitest";
import { FIELD_TYPE_META, fieldTypeFromLabel, isFieldType } from "@/domain/fieldTypes";
import { FIELD_TYPES, type FieldType } from "@/domain/types";

describe("FIELD_TYPE_META", () => {
  it.each<[FieldType, string, boolean, boolean]>([
    ["TEXT", "Text", false, false],
    ["LONG_TEXT", "Long text", false, false],
    ["NUMBER", "Number", false, false],
    ["PERCENT", "Number (%)", false, false],
    ["DATE", "Date", false, false],
    ["DATE_RANGE", "Date range", false, false],
    ["DROPDOWN", "Dropdown", true, true],
    ["MULTIPLE", "Multiple", true, false],
    ["CHECKBOX", "Checkbox", false, false],
    ["LINK", "Link", false, false],
    ["FILE", "File", false, false],
  ])("%s -> %s (choices %s, states %s)", (t, label, hasChoices, choicesHaveState) => {
    expect(FIELD_TYPE_META[t]).toEqual({ label, hasChoices, choicesHaveState });
  });

  it("covers every field type with a unique label", () => {
    expect(Object.keys(FIELD_TYPE_META).sort()).toEqual([...FIELD_TYPES].sort());
    expect(new Set(FIELD_TYPES.map((t) => FIELD_TYPE_META[t].label)).size).toBe(FIELD_TYPES.length);
  });
});

describe("fieldTypeFromLabel", () => {
  it.each(FIELD_TYPES.map((t) => [FIELD_TYPE_META[t].label, t] as const))("round-trips %s -> %s", (label, t) => {
    expect(fieldTypeFromLabel(label)).toBe(t);
  });

  it.each<[string, FieldType]>([
    ["number (%)", "PERCENT"],
    ["  LONG   TEXT ", "LONG_TEXT"],
    ["DATE_RANGE", "DATE_RANGE"],
    ["date range", "DATE_RANGE"],
    ["Dropdown (single)", "DROPDOWN"],
    ["Multiple (multi-select)", "MULTIPLE"],
    ["Link (URL)", "LINK"],
    ["Percent", "PERCENT"],
  ])("accepts %j -> %s", (label, t) => {
    expect(fieldTypeFromLabel(label)).toBe(t);
  });

  it.each([["Rich text"], [""], ["Number(%%)x"], ["Dropdowns"]])("returns undefined for %j", (label) => {
    expect(fieldTypeFromLabel(label)).toBeUndefined();
  });

  it("isFieldType guards unknown input", () => {
    expect(isFieldType("DATE")).toBe(true);
    expect(isFieldType("date")).toBe(false);
    expect(isFieldType(3)).toBe(false);
  });
});
