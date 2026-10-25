import { describe, expect, it } from "vitest";
import { FIELD_TYPES, type Choice, type FieldDef, type FieldType, type Value } from "@/domain/types";
import { isEmptyValue, isHttpUrl, isValidValue, normalizeValue, parsePercentInput, valueSchema } from "@/domain/values";

const CHOICES: Choice[] = [
  { id: "packing-list", label: "Packing list" },
  { id: "commercial-invoice", label: "Commercial invoice" },
  { id: "msds", label: "MSDS" },
  { id: "old", label: "Old one", archived: true },
];

const def = (fieldType: FieldType, choices: Choice[] = CHOICES): FieldDef => ({ fieldType, choices, config: {} });

describe("valueSchema", () => {
  it("has no schema for FILE and a schema for every other type", () => {
    expect(valueSchema("FILE")).toBeNull();
    for (const t of FIELD_TYPES.filter((t) => t !== "FILE")) expect(valueSchema(t), t).not.toBeNull();
  });

  it.each<[FieldType, unknown, boolean]>([
    ["TEXT", { text: "hello" }, true],
    ["TEXT", { text: "" }, true],
    ["TEXT", { text: 1 }, false],
    ["TEXT", { text: "a", other: 1 }, false],
    ["LONG_TEXT", { text: "a\nb" }, true],
    ["NUMBER", { number: 0 }, true],
    ["NUMBER", { number: -1.25 }, true],
    ["NUMBER", { number: Number.NaN }, false],
    ["NUMBER", { number: Number.POSITIVE_INFINITY }, false],
    ["NUMBER", { percent: 3 }, false],
    ["PERCENT", { percent: 0 }, true],
    ["PERCENT", { percent: 100 }, true],
    ["PERCENT", { percent: 101 }, false],
    ["PERCENT", { percent: 2.5 }, false],
    ["DATE", { date: "2026-11-12" }, true],
    ["DATE", { date: "2026-11-31" }, false],
    ["DATE", { date: "2028-02-29" }, true],
    ["DATE", { date: "2026-02-29" }, false],
    ["DATE_RANGE", { start: "2027-01-01", end: "2028-12-31" }, true],
    ["DATE_RANGE", { start: "2027-01-01" }, true],
    ["DATE_RANGE", { end: "2027-01-01" }, true],
    ["DATE_RANGE", {}, true],
    ["DATE_RANGE", { start: "2027-01-02", end: "2027-01-01" }, false],
    ["DATE_RANGE", { date: "2027-01-01" }, false],
    ["DROPDOWN", { choiceId: "msds" }, true],
    ["DROPDOWN", { choiceId: "" }, false],
    ["MULTIPLE", { choiceIds: ["msds"] }, true],
    ["MULTIPLE", { choiceIds: [] }, true],
    ["MULTIPLE", { choiceIds: [1] }, false],
    ["CHECKBOX", { checked: true }, true],
    ["CHECKBOX", { checked: false }, false],
    ["LINK", { url: "https://example.com/a?b=c" }, true],
    ["LINK", { url: "http://intranet.local/x", label: "Spec" }, true],
    ["LINK", { url: "mailto:a@b.com" }, false],
    ["LINK", { url: "https://exa mple.com" }, false],
  ])("%s %j valid=%s", (t, v, valid) => {
    expect(valueSchema(t)!.safeParse(v).success).toBe(valid);
    expect(isValidValue(t, v as Value)).toBe(valid);
  });

  it("null is always a valid (empty) value", () => {
    for (const t of FIELD_TYPES) expect(isValidValue(t, null)).toBe(true);
  });
});

describe("normalizeValue: accepted input", () => {
  it.each<[FieldType, unknown, Value | null]>([
    // empty input -> null
    ["TEXT", null, null],
    ["TEXT", undefined, null],
    ["TEXT", "", null],
    ["TEXT", "   ", null],
    ["TEXT", { text: "  " }, null],
    ["LONG_TEXT", "\n\n", null],
    ["NUMBER", "", null],
    ["PERCENT", " ", null],
    ["DATE", "", null],
    ["DATE_RANGE", {}, null],
    ["DATE_RANGE", { start: "", end: "" }, null],
    ["DATE_RANGE", { start: null, end: undefined }, null],
    ["DROPDOWN", "", null],
    ["DROPDOWN", { choiceId: "" }, null],
    ["MULTIPLE", [], null],
    ["MULTIPLE", { choiceIds: [] }, null],
    ["CHECKBOX", false, null],
    ["CHECKBOX", { checked: false }, null],
    ["CHECKBOX", null, null],
    ["LINK", "", null],
    ["LINK", { url: " " }, null],
    // filled input
    ["TEXT", "  Kick-off held  ", { text: "Kick-off held" }],
    ["TEXT", { text: " x " }, { text: "x" }],
    ["LONG_TEXT", "  line 1\nline 2 \n", { text: "line 1\nline 2" }],
    ["NUMBER", 24, { number: 24 }],
    ["NUMBER", 0, { number: 0 }],
    ["NUMBER", -0, { number: 0 }],
    ["NUMBER", "1,250", { number: 1250 }],
    ["NUMBER", " 3.5 ", { number: 3.5 }],
    ["NUMBER", { number: -2 }, { number: -2 }],
    ["PERCENT", 60, { percent: 60 }],
    ["PERCENT", "60", { percent: 60 }],
    ["PERCENT", "60%", { percent: 60 }],
    ["PERCENT", 0, { percent: 0 }],
    ["PERCENT", 100, { percent: 100 }],
    ["PERCENT", { percent: 99 }, { percent: 99 }],
    ["DATE", "2026-11-12", { date: "2026-11-12" }],
    ["DATE", { date: " 2026-11-12 " }, { date: "2026-11-12" }],
    ["DATE_RANGE", { start: "2027-01-01", end: "2028-12-31" }, { start: "2027-01-01", end: "2028-12-31" }],
    ["DATE_RANGE", { start: "2027-01-01", end: "" }, { start: "2027-01-01" }],
    ["DATE_RANGE", { end: "2028-12-31" }, { end: "2028-12-31" }],
    ["DATE_RANGE", { start: "2027-01-01", end: "2027-01-01" }, { start: "2027-01-01", end: "2027-01-01" }],
    ["DROPDOWN", "msds", { choiceId: "msds" }],
    ["DROPDOWN", { choiceId: "old" }, { choiceId: "old" }], // an archived choice still exists
    ["MULTIPLE", ["msds", "packing-list"], { choiceIds: ["packing-list", "msds"] }], // kept in choice order
    ["MULTIPLE", { choiceIds: ["msds", "msds", "commercial-invoice"] }, { choiceIds: ["commercial-invoice", "msds"] }],
    ["CHECKBOX", true, { checked: true }],
    ["CHECKBOX", { checked: true }, { checked: true }],
    ["LINK", " https://gunnebo.sharepoint.com/x ", { url: "https://gunnebo.sharepoint.com/x" }],
    ["LINK", { url: "http://example.com", label: "  Drawing " }, { url: "http://example.com", label: "Drawing" }],
    ["LINK", { url: "http://example.com", label: "  " }, { url: "http://example.com" }],
    ["FILE", "anything", null],
    ["FILE", { url: "https://x.com" }, null],
  ])("%s %j -> %j", (t, raw, expected) => {
    const result = normalizeValue(def(t), raw);
    expect(result).toEqual({ ok: true, value: expected });
    if (result.ok && result.value !== null) expect(isValidValue(t, result.value)).toBe(true);
  });
});

describe("normalizeValue: rejected input with plain-English errors", () => {
  it.each<[FieldType, unknown, RegExp]>([
    ["TEXT", 42, /text/i],
    ["TEXT", "x".repeat(50_001), /too long/i],
    ["NUMBER", "abc", /number/i],
    ["NUMBER", Number.NaN, /number/i],
    ["NUMBER", Number.POSITIVE_INFINITY, /number/i],
    ["NUMBER", "1e999", /number/i],
    ["NUMBER", true, /number/i],
    ["PERCENT", 101, /0 to 100/],
    ["PERCENT", -1, /0 to 100/],
    ["PERCENT", 50.5, /whole number/],
    ["PERCENT", "lots", /0 to 100/],
    ["DATE", "2026-02-30", /valid date/i],
    ["DATE", "12/11/2026", /valid date/i],
    ["DATE", 20261112, /valid date/i],
    ["DATE_RANGE", { start: "2028-01-01", end: "2027-01-01" }, /start date must be on or before the end date/i],
    ["DATE_RANGE", { start: "nope" }, /start date/i],
    ["DATE_RANGE", { end: "2027-13-01" }, /end date/i],
    ["DATE_RANGE", "2027-01-01", /start date/i],
    ["DROPDOWN", "missing", /not in this list/i],
    ["DROPDOWN", 3, /pick/i],
    ["MULTIPLE", ["msds", "missing"], /not in this list/i],
    ["MULTIPLE", ["missing", "gone"], /2 of the selected choices/i],
    ["MULTIPLE", "msds", /pick/i],
    ["CHECKBOX", "maybe", /tick/i],
    ["LINK", "ftp://example.com/file", /http:\/\/ or https:\/\//],
    ["LINK", "www.example.com", /http:\/\/ or https:\/\//],
    ["LINK", "javascript:alert(1)", /http:\/\/ or https:\/\//],
    ["LINK", { url: "https://example.com", label: 5 }, /label/i],
    ["LINK", { url: "https://example.com", label: "x".repeat(501) }, /label is too long/i],
  ])("%s %j fails", (t, raw, message) => {
    const result = normalizeValue(def(t), raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(message);
      expect(result.error).toMatch(/^[A-Z0-9]/); // a sentence for the user, not a code
    }
  });
});

describe("isEmptyValue", () => {
  it.each<[FieldType, Value | null, boolean]>([
    ["TEXT", null, true],
    ["TEXT", { text: "" }, true],
    ["TEXT", { text: "  \n" }, true],
    ["TEXT", { text: "x" }, false],
    ["LONG_TEXT", { text: "x" }, false],
    ["NUMBER", { number: 0 }, false],
    ["PERCENT", { percent: 0 }, false],
    ["DATE", { date: "2026-01-01" }, false],
    ["DATE_RANGE", {}, true],
    ["DATE_RANGE", { start: "2026-01-01" }, false],
    ["DATE_RANGE", { end: "2026-01-01" }, false],
    ["DROPDOWN", { choiceId: "a" }, false],
    ["MULTIPLE", { choiceIds: [] }, true],
    ["MULTIPLE", { choiceIds: ["a"] }, false],
    ["CHECKBOX", { checked: true }, false],
    ["LINK", { url: "https://a.com" }, false],
    ["FILE", null, true],
  ])("%s %j -> %s", (t, v, empty) => {
    expect(isEmptyValue(t, v)).toBe(empty);
  });

  it("null is empty for every type", () => {
    for (const t of FIELD_TYPES) expect(isEmptyValue(t, null)).toBe(true);
  });
});

describe("isHttpUrl", () => {
  it.each<[string, boolean]>([
    ["https://gunnebo.sharepoint.com/sites/x", true],
    ["http://localhost:3000", true],
    ["HTTPS://EXAMPLE.COM", true],
    ["ftp://example.com", false],
    ["https://", false],
    ["example.com", false],
    ["https://a b.com", false],
  ])("%s -> %s", (url, expected) => {
    expect(isHttpUrl(url)).toBe(expected);
  });
});

describe("parsePercentInput", () => {
  it.each([
    ["", 0],
    ["0", 0],
    ["45", 45],
    ["12.5", 13],
    ["12,5", 13],
    ["12.4", 12],
    [".5", 1],
    ["99.6", 100],
    ["100", 100],
    ["80 %", 80],
    ["80%", 80],
    ["  7 ", 7],
  ])("%j -> %s", (input, expected) => {
    expect(parsePercentInput(input)).toBe(expected);
  });

  it.each(["150", "100.5", "-5", "abc", "1.2.3", "12,5,1", "%", "1e2"])("%j is refused", (input) => {
    expect(parsePercentInput(input)).toBeNull();
  });
});
