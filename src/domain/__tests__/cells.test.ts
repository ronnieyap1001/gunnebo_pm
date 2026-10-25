import { describe, expect, it } from "vitest";
import { CELL_TEXT_LENGTH, buildCell, cellDef, cellDisplay, cellNode, cellState } from "@/domain/cells";
import { formatValue } from "@/domain/format";
import { deriveState } from "@/domain/state";
import type { Choice, DayContext, FieldType, NodeFlag, Step, Value } from "@/domain/types";

const ctx: DayContext = { today: "2026-10-25", timeZone: "Asia/Singapore" };

const PO_CHOICES: Choice[] = [
  { id: "awaiting", label: "Awaiting", state: "WAITING" },
  { id: "loi-received", label: "LOI received", state: "IN_PROGRESS" },
  { id: "full-po", label: "Full PO", state: "DONE" },
  { id: "old", label: "Old", state: "BLOCKED", archived: true },
  { id: "not-needed", label: "Not needed", state: "NOT_APPLICABLE" },
];
const DOC_CHOICES: Choice[] = [
  { id: "packing-list", label: "Packing list" },
  { id: "commercial-invoice", label: "Commercial invoice" },
  { id: "msds", label: "MSDS" },
  { id: "form-e", label: "Form E" },
];

function step(fieldType: FieldType, value: Value | null, extra: Partial<Step> = {}): Step {
  const choices = fieldType === "DROPDOWN" ? PO_CHOICES : fieldType === "MULTIPLE" ? DOC_CHOICES : [];
  return {
    id: "step-1",
    projectId: "p-1",
    milestoneId: "m-1",
    milestoneKey: "customer-po-loi",
    name: "Customer PO / LOI",
    description: "",
    fieldType,
    choices,
    config: {},
    value,
    notApplicable: false,
    flag: null,
    order: 8,
    rev: 3,
    archived: false,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...extra,
  };
}

const LONG = "x".repeat(30) + " " + "y".repeat(100);

describe("buildCell", () => {
  it("copies identity, type, flags and timestamps compactly", () => {
    const cell = buildCell(
      step("DROPDOWN", { choiceId: "full-po" }, {
        flag: "BLOCKED",
        notApplicable: true,
        valueSetAt: "2026-10-20T01:00:00.000Z",
        stateChangedAt: "2026-10-21T01:00:00.000Z",
      }),
      2,
    );
    expect(cell).toEqual({
      m: "m-1",
      k: "customer-po-loi",
      n: "Customer PO / LOI",
      t: "DROPDOWN",
      v: { choiceId: "full-po" },
      ch: [{ id: "full-po", label: "Full PO", state: "DONE" }],
      na: true,
      f: "BLOCKED",
      fc: 2,
      vs: "2026-10-20T01:00:00.000Z",
      c: "2026-10-21T01:00:00.000Z",
      o: 8,
    });
  });

  it("leaves out empty optional fields", () => {
    const cell = buildCell(step("TEXT", null, { milestoneId: undefined, milestoneKey: undefined }), 0);
    expect(cell).toEqual({ n: "Customer PO / LOI", t: "TEXT", v: null, o: 8 });
  });

  it("keeps only the selected choices, in choice order", () => {
    const cell = buildCell(step("MULTIPLE", { choiceIds: ["msds", "packing-list"] }), 0);
    expect(cell.ch).toEqual([
      { id: "packing-list", label: "Packing list" },
      { id: "msds", label: "MSDS" },
    ]);
  });

  it("keeps a retired choice with its flag and state", () => {
    expect(buildCell(step("DROPDOWN", { choiceId: "old" }), 0).ch).toEqual([
      { id: "old", label: "Old", state: "BLOCKED", archived: true },
    ]);
  });

  it("has no ch for an unknown choice id", () => {
    expect(buildCell(step("DROPDOWN", { choiceId: "gone" }), 0).ch).toBeUndefined();
  });

  it(`truncates text to ${CELL_TEXT_LENGTH} characters`, () => {
    const cell = buildCell(step("LONG_TEXT", { text: LONG }), 0);
    expect((cell.v as { text: string }).text).toBe(LONG.slice(0, CELL_TEXT_LENGTH));
  });

  it("reduces links to their origin and a short label", () => {
    const cell = buildCell(
      step("LINK", { url: "https://gunnebo.sharepoint.com/sites/pm/Shared%20Documents/C0822/FAT.pdf", label: "y".repeat(80) }),
      0,
    );
    expect(cell.v).toEqual({ url: "https://gunnebo.sharepoint.com", label: "y".repeat(CELL_TEXT_LENGTH) });
  });

  it("does not store a FILE value", () => {
    expect(buildCell(step("FILE", { text: "junk" } as Value), 3).v).toBeNull();
  });

  it("keeps an invalid value as is so the cell also shows it as invalid", () => {
    const bad = { percent: 150 } as Value;
    const cell = buildCell(step("PERCENT", bad), 0);
    expect(cell.v).toEqual(bad);
    expect(cellState(cell, ctx)).toEqual({ state: "NOT_STARTED", reason: "INVALID_VALUE" });
  });
});

describe("cell state matches step state", () => {
  const cases: [string, Step, number][] = [
    ["empty dropdown", step("DROPDOWN", null), 0],
    ["dropdown waiting", step("DROPDOWN", { choiceId: "awaiting" }), 0],
    ["dropdown done", step("DROPDOWN", { choiceId: "full-po" }), 0],
    ["dropdown NA-tagged", step("DROPDOWN", { choiceId: "not-needed" }), 0],
    ["dropdown retired", step("DROPDOWN", { choiceId: "old" }), 0],
    ["dropdown unknown", step("DROPDOWN", { choiceId: "gone" }), 0],
    ["multiple", step("MULTIPLE", { choiceIds: ["msds"] }), 0],
    ["text", step("TEXT", { text: LONG }), 0],
    ["whitespace text", step("TEXT", { text: "   " }), 0],
    ["number zero", step("NUMBER", { number: 0 }), 0],
    ["percent 0", step("PERCENT", { percent: 0 }), 0],
    ["percent 50", step("PERCENT", { percent: 50 }), 0],
    ["percent 100", step("PERCENT", { percent: 100 }), 0],
    ["date planned", step("DATE", { date: "2026-10-26" }), 0],
    ["date today", step("DATE", { date: "2026-10-25" }), 0],
    ["date passed auto", step("DATE", { date: "2026-10-25" }, { valueSetAt: "2026-10-01T00:00:00.000Z" }), 0],
    ["range upcoming", step("DATE_RANGE", { start: "2027-01-01", end: "2028-12-31" }), 0],
    ["range running", step("DATE_RANGE", { start: "2026-01-01", end: "2028-12-31" }), 0],
    ["range ended", step("DATE_RANGE", { start: "2025-01-01", end: "2026-10-25" }), 0],
    ["checkbox", step("CHECKBOX", { checked: true }), 0],
    ["link", step("LINK", { url: "https://example.com/a/b" }), 0],
    ["file none", step("FILE", null), 0],
    ["file some", step("FILE", null), 2],
    ["flagged", step("DATE", { date: "2026-10-01" }, { flag: "BLOCKED" as NodeFlag }), 0],
    ["N/A", step("DROPDOWN", { choiceId: "full-po" }, { notApplicable: true, flag: "WAITING" }), 0],
  ];

  it.each(cases)("%s", (_label, s, attachments) => {
    const expected = deriveState(s, { ...s, attachmentCount: attachments }, ctx);
    const cell = buildCell(s, attachments);
    expect(cellState(cell, ctx)).toEqual(expected);
    // The cell's own definition and node agree with what was derived
    expect(deriveState(cellDef(cell), cellNode(cell), ctx)).toEqual(expected);
  });

  it.each(cases)("survives a JSON round trip: %s", (_label, s, attachments) => {
    const cell = JSON.parse(JSON.stringify(buildCell(s, attachments)));
    expect(cellState(cell, ctx)).toEqual(deriveState(s, { ...s, attachmentCount: attachments }, ctx));
  });
});

describe("cellDisplay", () => {
  it.each<[string, Step, number, string]>([
    ["dropdown", step("DROPDOWN", { choiceId: "loi-received" }), 0, "LOI received"],
    ["dropdown retired", step("DROPDOWN", { choiceId: "old" }), 0, "Old (retired)"],
    ["multiple short", step("MULTIPLE", { choiceIds: ["packing-list", "commercial-invoice", "msds", "form-e"] }), 0, "Packing list, Commercial invoice +2"],
    ["planned date", step("DATE", { date: "2026-11-12" }), 0, "Plan 12 Nov 2026"],
    ["text short", step("TEXT", { text: LONG }), 0, `${"x".repeat(30)} ${"y".repeat(9)}…`],
    ["percent", step("PERCENT", { percent: 60 }), 0, "60 %"],
    ["link", step("LINK", { url: "https://www.example.com/a/b" }), 0, "example.com"],
    ["files", step("FILE", null), 3, "3 files"],
    ["empty", step("DATE", null), 0, "—"],
  ])("%s", (_label, s, attachments, expected) => {
    expect(cellDisplay(buildCell(s, attachments), ctx)).toBe(expected);
  });

  it("matches the step's own short display (except number units, which cells do not carry)", () => {
    const s = step("DATE_RANGE", { start: "2027-01-01", end: "2028-12-31" });
    expect(cellDisplay(buildCell(s, 0), ctx)).toBe(formatValue(s, s.value, { short: true, today: ctx.today }));
  });

  it("shows a date without 'Plan' when no context is given", () => {
    expect(cellDisplay(buildCell(step("DATE", { date: "2026-11-12" }), 0))).toBe("12 Nov 2026");
  });
});
