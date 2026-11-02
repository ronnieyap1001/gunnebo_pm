import { describe, expect, it } from "vitest";
import { EMPTY_DISPLAY, formatValue, type FormatOptions } from "@/domain/format";
import { FIELD_TYPES, type Choice, type FieldConfig, type FieldDef, type FieldType, type Value } from "@/domain/types";

const DROPDOWN_CHOICES: Choice[] = [
  { id: "awaiting", label: "Awaiting", state: "WAITING" },
  { id: "full-po", label: "Full PO", state: "DONE" },
  { id: "old-po", label: "Old PO", state: "DONE", archived: true },
];

const MULTIPLE_CHOICES: Choice[] = [
  { id: "packing-list", label: "Packing list" },
  { id: "commercial-invoice", label: "Commercial invoice" },
  { id: "msds", label: "MSDS" },
  { id: "form-e", label: "Form E" },
  { id: "retired", label: "Retired doc", archived: true },
];

function def(fieldType: FieldType, config: FieldConfig = {}): FieldDef {
  const choices = fieldType === "DROPDOWN" ? DROPDOWN_CHOICES : fieldType === "MULTIPLE" ? MULTIPLE_CHOICES : [];
  return { fieldType, choices, config };
}

const LONG = "The customer asked for a revised layout of lanes 3 and 4 after the site survey";

describe("formatValue", () => {
  it.each<[string, FieldType, Value | null, FormatOptions, string, FieldConfig?]>([
    // Dropdown
    ["dropdown label", "DROPDOWN", { choiceId: "full-po" }, {}, "Full PO"],
    ["dropdown retired", "DROPDOWN", { choiceId: "old-po" }, {}, "Old PO (retired)"],
    ["dropdown unknown", "DROPDOWN", { choiceId: "gone" }, {}, "Unknown choice"],
    // Multiple
    ["multiple, all", "MULTIPLE", { choiceIds: ["packing-list", "msds", "form-e", "commercial-invoice"] }, {}, "Packing list, MSDS, Form E, Commercial invoice"],
    ["multiple, short", "MULTIPLE", { choiceIds: ["packing-list", "msds", "form-e", "commercial-invoice"] }, { short: true }, "Packing list, MSDS +2"],
    ["multiple, short with two", "MULTIPLE", { choiceIds: ["packing-list", "msds"] }, { short: true }, "Packing list, MSDS"],
    ["multiple, retired marked", "MULTIPLE", { choiceIds: ["msds", "retired"] }, {}, "MSDS, Retired doc (retired)"],
    // Date
    ["date", "DATE", { date: "2026-11-12" }, {}, "12 Nov 2026"],
    ["date in the future with today", "DATE", { date: "2026-11-12" }, { today: "2026-10-25" }, "Plan 12 Nov 2026"],
    ["date today with today", "DATE", { date: "2026-10-25" }, { today: "2026-10-25" }, "25 Oct 2026"],
    ["date in the past with today", "DATE", { date: "2026-01-02" }, { today: "2026-10-25" }, "2 Jan 2026"],
    // Date range
    ["range", "DATE_RANGE", { start: "2027-01-01", end: "2028-12-31" }, {}, "1 Jan 2027 → 31 Dec 2028"],
    ["range start only", "DATE_RANGE", { start: "2027-01-01" }, {}, "From 1 Jan 2027"],
    ["range end only", "DATE_RANGE", { end: "2028-12-31" }, {}, "Until 31 Dec 2028"],
    // Numbers
    ["percent", "PERCENT", { percent: 60 }, {}, "60 %"],
    ["percent 0", "PERCENT", { percent: 0 }, {}, "0 %"],
    ["number with unit", "NUMBER", { number: 24 }, {}, "24 pcs", { unit: "pcs" }],
    ["number without unit", "NUMBER", { number: 24 }, {}, "24"],
    ["number zero", "NUMBER", { number: 0 }, {}, "0 pcs", { unit: "pcs" }],
    ["number grouping and decimals", "NUMBER", { number: 1234.5 }, {}, "1,234.5"],
    ["number negative", "NUMBER", { number: -3 }, {}, "-3"],
    // Text
    ["text", "TEXT", { text: "Kick-off held" }, {}, "Kick-off held"],
    ["text long, full", "TEXT", { text: LONG }, {}, LONG],
    ["text long, short", "TEXT", { text: LONG }, { short: true }, `${LONG.slice(0, 40).trimEnd()}…`],
    ["text exactly 40, short", "TEXT", { text: "x".repeat(40) }, { short: true }, "x".repeat(40)],
    ["long text, short joins lines", "LONG_TEXT", { text: "Line one\nLine two" }, { short: true }, "Line one Line two"],
    ["long text, full keeps lines", "LONG_TEXT", { text: "Line one\nLine two" }, {}, "Line one\nLine two"],
    // Checkbox, link, file
    ["checkbox", "CHECKBOX", { checked: true }, {}, "Yes"],
    ["link label", "LINK", { url: "https://gunnebo.sharepoint.com/sites/pm", label: "FAT report" }, {}, "FAT report"],
    ["link host", "LINK", { url: "https://gunnebo.sharepoint.com/sites/pm/x?y=1" }, {}, "gunnebo.sharepoint.com"],
    ["link host strips www", "LINK", { url: "https://www.example.com/a" }, {}, "example.com"],
    ["file one", "FILE", null, { attachmentCount: 1 }, "1 file"],
    ["file many", "FILE", null, { attachmentCount: 3 }, "3 files"],
    ["file none", "FILE", null, { attachmentCount: 0 }, EMPTY_DISPLAY],
    ["file no count", "FILE", null, {}, EMPTY_DISPLAY],
    // Invalid
    ["invalid date", "DATE", { date: "2026-02-30" }, {}, "Invalid value"],
    ["wrong shape", "PERCENT", { number: 5 } as Value, {}, "Invalid value"],
  ])("%s", (_label, t, value, opts, expected, config) => {
    expect(formatValue(def(t, config), value, opts)).toBe(expected);
  });

  it.each(FIELD_TYPES.map((t) => [t]))("%s shows '—' when empty", (t) => {
    expect(formatValue(def(t), null)).toBe("—");
    expect(formatValue(def(t), null, { short: true, today: "2026-10-25" })).toBe("—");
  });

  it.each<[FieldType, Value]>([
    ["TEXT", { text: "   " }],
    ["MULTIPLE", { choiceIds: [] }],
    ["DATE_RANGE", {}],
  ])("%s shows '—' for an empty shape %j", (t, v) => {
    expect(formatValue(def(t), v)).toBe("—");
  });

  it("an unknown field type shows 'Invalid value' (or '—' when empty), never undefined", () => {
    const d: FieldDef = { fieldType: "Dropdown" as unknown as FieldType, choices: [], config: {} };
    expect(formatValue(d, { text: "x" })).toBe("Invalid value");
    expect(formatValue(d, null)).toBe("—");
  });
});
