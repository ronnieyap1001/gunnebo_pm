import { describe, expect, it } from "vitest";
import { canConvertValue, convertValue } from "@/domain/convertValue";
import { FIELD_TYPES, type Choice, type FieldType, type Value } from "@/domain/types";

const SAMPLE: Record<Exclude<FieldType, "FILE">, Value> = {
  TEXT: { text: "hello" },
  LONG_TEXT: { text: "hello\nworld" },
  NUMBER: { number: 2.5 },
  PERCENT: { percent: 60 },
  DATE: { date: "2026-11-12" },
  DATE_RANGE: { start: "2027-01-01", end: "2028-12-31" },
  DROPDOWN: { choiceId: "afl" },
  MULTIPLE: { choiceIds: ["afl", "abcs"] },
  CHECKBOX: { checked: true },
  LINK: { url: "https://example.com" },
};

describe("convertValue: lossless conversions", () => {
  it.each<[FieldType, FieldType, Value, Value | null]>([
    ["TEXT", "LONG_TEXT", { text: "hello" }, { text: "hello" }],
    ["LONG_TEXT", "TEXT", { text: "a\nb" }, { text: "a\nb" }],
    ["DROPDOWN", "MULTIPLE", { choiceId: "afl" }, { choiceIds: ["afl"] }],
    ["MULTIPLE", "DROPDOWN", { choiceIds: ["afl"] }, { choiceId: "afl" }],
    ["MULTIPLE", "DROPDOWN", { choiceIds: [] }, null],
    ["PERCENT", "NUMBER", { percent: 60 }, { number: 60 }],
    ["PERCENT", "NUMBER", { percent: 0 }, { number: 0 }],
    ["NUMBER", "PERCENT", { number: 0 }, { percent: 0 }],
    ["NUMBER", "PERCENT", { number: 100 }, { percent: 100 }],
    ["NUMBER", "PERCENT", { number: 42 }, { percent: 42 }],
    ["DATE", "DATE_RANGE", { date: "2026-11-12" }, { start: "2026-11-12" }],
    ["TEXT", "LINK", { text: " https://gunnebo.sharepoint.com/x " }, { url: "https://gunnebo.sharepoint.com/x" }],
    ["LONG_TEXT", "LINK", { text: "http://example.com/a" }, { url: "http://example.com/a" }],
  ])("%s -> %s: %j -> %j", (from, to, value, expected) => {
    expect(convertValue(from, to, value)).toEqual({ ok: true, value: expected });
  });

  it("null converts to null between any two types", () => {
    for (const from of FIELD_TYPES) for (const to of FIELD_TYPES) expect(convertValue(from, to, null)).toEqual({ ok: true, value: null });
  });

  it("an empty value converts to null", () => {
    expect(convertValue("TEXT", "NUMBER", { text: "  " })).toEqual({ ok: true, value: null });
    expect(convertValue("DATE_RANGE", "DATE", {})).toEqual({ ok: true, value: null });
  });

  it("same type keeps the value unchanged", () => {
    for (const [t, v] of Object.entries(SAMPLE) as [FieldType, Value][]) {
      expect(convertValue(t, t, v)).toEqual({ ok: true, value: v });
    }
  });
});

describe("convertValue: refused conversions", () => {
  it.each<[FieldType, FieldType, Value]>([
    ["MULTIPLE", "DROPDOWN", { choiceIds: ["afl", "abcs"] }],
    ["NUMBER", "PERCENT", { number: 101 }],
    ["NUMBER", "PERCENT", { number: -1 }],
    ["NUMBER", "PERCENT", { number: 2.5 }],
    ["TEXT", "LINK", { text: "see the SharePoint folder" }],
    ["TEXT", "LINK", { text: "ftp://example.com" }],
    ["DATE_RANGE", "DATE", { start: "2027-01-01", end: "2028-12-31" }],
    ["DATE_RANGE", "DATE", { start: "2027-01-01" }],
    ["LINK", "TEXT", { url: "https://example.com" }],
    ["NUMBER", "TEXT", { number: 3 }],
    ["TEXT", "NUMBER", { text: "3" }],
    ["DROPDOWN", "TEXT", { choiceId: "afl" }],
    ["CHECKBOX", "TEXT", { checked: true }],
    ["DATE", "TEXT", { date: "2026-11-12" }],
    ["TEXT", "FILE", { text: "x" }],
  ])("%s -> %s refuses %j", (from, to, value) => {
    const result = convertValue(from, to, value);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/^[A-Z0-9]/);
    expect(canConvertValue(from, to, value)).toBe(false);
  });

  it("every pair outside the lossless table refuses a filled value", () => {
    const allowed = new Set([
      "TEXT->LONG_TEXT",
      "LONG_TEXT->TEXT",
      "DROPDOWN->MULTIPLE",
      "MULTIPLE->DROPDOWN",
      "PERCENT->NUMBER",
      "NUMBER->PERCENT",
      "DATE->DATE_RANGE",
      "TEXT->LINK",
      "LONG_TEXT->LINK",
    ]);
    const sample: Record<string, Value> = {
      ...SAMPLE,
      MULTIPLE: { choiceIds: ["afl"] },
      NUMBER: { number: 5 },
      TEXT: { text: "https://example.com" },
      LONG_TEXT: { text: "https://example.com" },
    };
    for (const from of Object.keys(SAMPLE) as FieldType[]) {
      for (const to of FIELD_TYPES) {
        if (from === to) continue;
        const result = convertValue(from, to, sample[from]);
        expect(result.ok, `${from}->${to}`).toBe(allowed.has(`${from}->${to}`));
      }
    }
  });

  it("refuses a value that is not valid for its own type", () => {
    const result = convertValue("PERCENT", "NUMBER", { percent: 150 });
    expect(result.ok).toBe(false);
  });
});

describe("convertValue: choice lists", () => {
  const TO: Choice[] = [
    { id: "afl", label: "AFL", state: "DONE" },
    { id: "abcs", label: "ABCS", state: "DONE" },
  ];

  it("accepts ids present in toChoices", () => {
    expect(convertValue("DROPDOWN", "MULTIPLE", { choiceId: "afl" }, TO)).toEqual({ ok: true, value: { choiceIds: ["afl"] } });
    expect(convertValue("MULTIPLE", "DROPDOWN", { choiceIds: ["abcs"] }, TO)).toEqual({ ok: true, value: { choiceId: "abcs" } });
  });

  it("refuses ids missing from toChoices", () => {
    expect(convertValue("DROPDOWN", "MULTIPLE", { choiceId: "immsec" }, TO).ok).toBe(false);
    expect(convertValue("MULTIPLE", "DROPDOWN", { choiceIds: ["immsec"] }, TO).ok).toBe(false);
  });

  it("an empty Multiple still converts with toChoices", () => {
    expect(convertValue("MULTIPLE", "DROPDOWN", { choiceIds: [] }, TO)).toEqual({ ok: true, value: null });
  });
});
