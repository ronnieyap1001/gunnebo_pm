import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { todayIn } from "@/domain/dates";
import { seedTemplateFile } from "@/domain/seed";
import {
  STATE_META,
  compareStates,
  deriveState,
  describeReason,
  isDateDrivenReason,
  isOpenState,
  parseState,
  stateFromCode,
  worstState,
  type StateNodeInput,
  type StateReason,
} from "@/domain/state";
import {
  FIELD_TYPES,
  STATES,
  type Choice,
  type DayContext,
  type FieldDef,
  type FieldType,
  type State,
  type StateCode,
  type Value,
} from "@/domain/types";

const TODAY = "2026-10-25";
const YESTERDAY = "2026-10-24";
const TOMORROW = "2026-10-26";
const ctx: DayContext = { today: TODAY, timeZone: "Asia/Singapore" };

const CHOICES: Choice[] = [
  { id: "not-started", label: "Not started", state: "NOT_STARTED" },
  { id: "in-progress", label: "In progress", state: "IN_PROGRESS" },
  { id: "waiting", label: "Waiting", state: "WAITING" },
  { id: "blocked", label: "Blocked", state: "BLOCKED" },
  { id: "done", label: "Done", state: "DONE" },
  { id: "not-needed", label: "Not needed", state: "NOT_APPLICABLE" },
  { id: "retired-done", label: "Old done", state: "DONE", archived: true },
  { id: "retired-blocked", label: "Old blocked", state: "BLOCKED", archived: true },
  { id: "untagged", label: "No tag" },
];

function def(fieldType: FieldType, choices: Choice[] = CHOICES): FieldDef {
  return { fieldType, choices, config: {} };
}

function node(value: Value | null, extra: Partial<StateNodeInput> = {}): StateNodeInput {
  return { value, notApplicable: false, flag: null, ...extra };
}

function derive(fieldType: FieldType, value: Value | null, extra: Partial<StateNodeInput> = {}, c: DayContext = ctx) {
  return deriveState(def(fieldType), node(value, extra), c);
}

/** A filled, valid value for every type (DATE in the past so it is DONE). */
const FILLED: Record<Exclude<FieldType, "FILE">, Value> = {
  TEXT: { text: "Kick-off went well" },
  LONG_TEXT: { text: "Line 1\nLine 2" },
  NUMBER: { number: 24 },
  PERCENT: { percent: 100 },
  DATE: { date: YESTERDAY },
  DATE_RANGE: { start: "2025-01-01", end: YESTERDAY },
  DROPDOWN: { choiceId: "done" },
  MULTIPLE: { choiceIds: ["done", "waiting"] },
  CHECKBOX: { checked: true },
  LINK: { url: "https://gunnebo.sharepoint.com/sites/pm/C0822" },
};

describe("deriveState: empty values", () => {
  it.each(FIELD_TYPES.map((t) => [t]))("%s with null is NOT_STARTED / EMPTY", (t) => {
    expect(derive(t, null)).toEqual({ state: "NOT_STARTED", reason: "EMPTY" });
  });

  it.each<[FieldType, Value]>([
    ["TEXT", { text: "" }],
    ["TEXT", { text: "   " }],
    ["LONG_TEXT", { text: "\n\t " }],
    ["MULTIPLE", { choiceIds: [] }],
    ["DATE_RANGE", {}],
  ])("%s with an empty shape %j is NOT_STARTED / EMPTY", (t, v) => {
    expect(derive(t, v)).toEqual({ state: "NOT_STARTED", reason: "EMPTY" });
  });

  it("FILE with 0 or missing attachments is NOT_STARTED / EMPTY", () => {
    expect(derive("FILE", null, { attachmentCount: 0 })).toEqual({ state: "NOT_STARTED", reason: "EMPTY" });
    expect(derive("FILE", null)).toEqual({ state: "NOT_STARTED", reason: "EMPTY" });
  });
});

describe("deriveState: filled values for every type", () => {
  it.each<[FieldType, Value | null, Partial<StateNodeInput>, State, StateReason]>([
    ["TEXT", FILLED.TEXT, {}, "DONE", "FILLED"],
    ["LONG_TEXT", FILLED.LONG_TEXT, {}, "DONE", "FILLED"],
    ["NUMBER", FILLED.NUMBER, {}, "DONE", "FILLED"],
    ["NUMBER", { number: 0 }, {}, "DONE", "FILLED"],
    ["NUMBER", { number: -3.5 }, {}, "DONE", "FILLED"],
    ["PERCENT", FILLED.PERCENT, {}, "DONE", "PERCENT"],
    ["DATE", FILLED.DATE, {}, "DONE", "DATE_REACHED"],
    ["DATE_RANGE", FILLED.DATE_RANGE, {}, "DONE", "RANGE_ENDED"],
    ["DROPDOWN", FILLED.DROPDOWN, {}, "DONE", "CHOICE"],
    ["MULTIPLE", FILLED.MULTIPLE, {}, "DONE", "FILLED"],
    ["MULTIPLE", { choiceIds: ["blocked"] }, {}, "DONE", "FILLED"], // Multiple choices carry no state
    ["CHECKBOX", FILLED.CHECKBOX, {}, "DONE", "FILLED"],
    ["LINK", FILLED.LINK, {}, "DONE", "FILLED"],
    ["LINK", { url: "http://example.com", label: "Drawing" }, {}, "DONE", "FILLED"],
    ["FILE", null, { attachmentCount: 1 }, "DONE", "FILES"],
    ["FILE", null, { attachmentCount: 3 }, "DONE", "FILES"],
  ])("%s %j %j -> %s / %s", (t, v, extra, state, reason) => {
    expect(derive(t, v, extra)).toEqual({ state, reason });
  });

  it("every field type has at least one filled case", () => {
    for (const t of FIELD_TYPES) {
      const result = t === "FILE" ? derive(t, null, { attachmentCount: 1 }) : derive(t, FILLED[t]);
      expect(result.state, t).toBe("DONE");
    }
  });

  it("FILE ignores a stored value and looks only at attachments", () => {
    expect(derive("FILE", { text: "x" }, { attachmentCount: 0 })).toEqual({ state: "NOT_STARTED", reason: "EMPTY" });
    expect(derive("FILE", { text: "x" }, { attachmentCount: 2 })).toEqual({ state: "DONE", reason: "FILES" });
  });
});

describe("deriveState: DATE and the today boundary", () => {
  it.each<[string, State, StateReason]>([
    ["2026-01-01", "DONE", "DATE_REACHED"],
    [YESTERDAY, "DONE", "DATE_REACHED"],
    [TODAY, "DONE", "DATE_REACHED"],
    [TOMORROW, "IN_PROGRESS", "DATE_PLANNED"],
    ["2027-12-31", "IN_PROGRESS", "DATE_PLANNED"],
  ])("date %s (today %s) -> %s / %s", (date, state, reason) => {
    expect(derive("DATE", { date })).toEqual({ state, reason });
  });

  it.each<[string, string | undefined, string, StateReason]>([
    // [date, valueSetAt, timeZone, reason]
    [TODAY, "2026-10-20T03:00:00.000Z", "Asia/Singapore", "DATE_PASSED_AUTO"], // entered in advance
    [YESTERDAY, "2026-10-01T03:00:00.000Z", "Asia/Singapore", "DATE_PASSED_AUTO"],
    [TODAY, "2026-10-25T03:00:00.000Z", "Asia/Singapore", "DATE_REACHED"], // entered on the day
    [YESTERDAY, "2026-10-25T03:00:00.000Z", "Asia/Singapore", "DATE_REACHED"], // entered afterwards
    [TODAY, undefined, "Asia/Singapore", "DATE_REACHED"], // unknown -> no clock mark
    [TODAY, "not a timestamp", "Asia/Singapore", "DATE_REACHED"], // invalid -> no clock mark, no crash
    // 16:30Z on 24 Oct is already 25 Oct in Singapore (entered on the day there), but still 24 Oct in UTC.
    [TODAY, "2026-10-24T16:30:00.000Z", "Asia/Singapore", "DATE_REACHED"],
    [TODAY, "2026-10-24T16:30:00.000Z", "UTC", "DATE_PASSED_AUTO"],
  ])("date %s set at %s in %s -> DONE / %s", (date, valueSetAt, timeZone, reason) => {
    const result = deriveState(def("DATE"), node({ date }, { valueSetAt }), { today: TODAY, timeZone });
    expect(result).toEqual({ state: "DONE", reason });
  });

  it("a planned (future) date stays DATE_PLANNED whatever valueSetAt says", () => {
    expect(derive("DATE", { date: TOMORROW }, { valueSetAt: "2026-01-01T00:00:00.000Z" })).toEqual({
      state: "IN_PROGRESS",
      reason: "DATE_PLANNED",
    });
  });

  describe("SGT vs UTC midnight: now = 2026-10-24T16:30:00Z", () => {
    const now = new Date("2026-10-24T16:30:00Z");
    const sgt: DayContext = { today: todayIn("Asia/Singapore", now), timeZone: "Asia/Singapore" };
    const utc: DayContext = { today: todayIn("UTC", now), timeZone: "UTC" };

    it("today is already 25 Oct in Singapore but 24 Oct in UTC", () => {
      expect(sgt.today).toBe("2026-10-25");
      expect(utc.today).toBe("2026-10-24");
    });

    it("a 25 Oct date is Done in Singapore and still planned in UTC", () => {
      expect(derive("DATE", { date: "2026-10-25" }, {}, sgt).state).toBe("DONE");
      expect(derive("DATE", { date: "2026-10-25" }, {}, utc)).toEqual({ state: "IN_PROGRESS", reason: "DATE_PLANNED" });
    });

    it("a range ending 25 Oct has ended in Singapore and is running in UTC", () => {
      const v = { start: "2026-10-01", end: "2026-10-25" };
      expect(derive("DATE_RANGE", v, {}, sgt)).toEqual({ state: "DONE", reason: "RANGE_ENDED" });
      expect(derive("DATE_RANGE", v, {}, utc)).toEqual({ state: "IN_PROGRESS", reason: "RANGE_RUNNING" });
    });

    it("a range starting 25 Oct is running in Singapore and upcoming in UTC", () => {
      const v = { start: "2026-10-25", end: "2026-12-31" };
      expect(derive("DATE_RANGE", v, {}, sgt)).toEqual({ state: "IN_PROGRESS", reason: "RANGE_RUNNING" });
      expect(derive("DATE_RANGE", v, {}, utc)).toEqual({ state: "IN_PROGRESS", reason: "RANGE_UPCOMING" });
    });
  });
});

describe("deriveState: DATE_RANGE", () => {
  it.each<[string, { start?: string; end?: string }, State, StateReason]>([
    ["both in the past", { start: "2026-01-01", end: YESTERDAY }, "DONE", "RANGE_ENDED"],
    ["ends today", { start: "2026-01-01", end: TODAY }, "DONE", "RANGE_ENDED"],
    ["single day today", { start: TODAY, end: TODAY }, "DONE", "RANGE_ENDED"],
    ["ends tomorrow (running)", { start: "2026-01-01", end: TOMORROW }, "IN_PROGRESS", "RANGE_RUNNING"],
    ["starts today, ends later", { start: TODAY, end: "2028-12-31" }, "IN_PROGRESS", "RANGE_RUNNING"],
    ["starts yesterday, ends later", { start: YESTERDAY, end: "2028-12-31" }, "IN_PROGRESS", "RANGE_RUNNING"],
    ["starts tomorrow", { start: TOMORROW, end: "2028-12-31" }, "IN_PROGRESS", "RANGE_UPCOMING"],
    ["start only, in the past", { start: "2026-01-01" }, "IN_PROGRESS", "RANGE_RUNNING"],
    ["start only, today", { start: TODAY }, "IN_PROGRESS", "RANGE_RUNNING"],
    ["start only, in the future", { start: TOMORROW }, "IN_PROGRESS", "RANGE_UPCOMING"],
    ["end only, in the past", { end: YESTERDAY }, "DONE", "RANGE_ENDED"],
    ["end only, today", { end: TODAY }, "DONE", "RANGE_ENDED"],
    ["end only, in the future", { end: TOMORROW }, "IN_PROGRESS", "RANGE_RUNNING"],
  ])("%s -> %s / %s", (_label, v, state, reason) => {
    expect(derive("DATE_RANGE", v)).toEqual({ state, reason });
  });

  it("an empty range is NOT_STARTED", () => {
    expect(derive("DATE_RANGE", {})).toEqual({ state: "NOT_STARTED", reason: "EMPTY" });
  });

  it("a reversed range is an invalid value", () => {
    expect(derive("DATE_RANGE", { start: "2027-01-01", end: "2026-01-01" })).toEqual({
      state: "NOT_STARTED",
      reason: "INVALID_VALUE",
    });
  });
});

describe("deriveState: PERCENT", () => {
  it.each<[number, State]>([
    [0, "NOT_STARTED"],
    [1, "IN_PROGRESS"],
    [50, "IN_PROGRESS"],
    [99, "IN_PROGRESS"],
    [100, "DONE"],
  ])("%i %% -> %s", (percent, state) => {
    expect(derive("PERCENT", { percent })).toEqual({ state, reason: "PERCENT" });
  });

  it.each([[-1], [101], [50.5], [Number.NaN]])("%d %% is an invalid value", (percent) => {
    expect(derive("PERCENT", { percent })).toEqual({ state: "NOT_STARTED", reason: "INVALID_VALUE" });
  });
});

describe("deriveState: DROPDOWN", () => {
  it.each<[string, State]>([
    ["not-started", "NOT_STARTED"],
    ["in-progress", "IN_PROGRESS"],
    ["waiting", "WAITING"],
    ["blocked", "BLOCKED"],
    ["done", "DONE"],
    ["not-needed", "NOT_APPLICABLE"], // an NA-tagged choice counts as N/A everywhere
  ])("choice %s -> %s / CHOICE", (choiceId, state) => {
    expect(derive("DROPDOWN", { choiceId })).toEqual({ state, reason: "CHOICE" });
  });

  it("retired (archived) choices still count with their tag", () => {
    expect(derive("DROPDOWN", { choiceId: "retired-done" })).toEqual({ state: "DONE", reason: "CHOICE" });
    expect(derive("DROPDOWN", { choiceId: "retired-blocked" })).toEqual({ state: "BLOCKED", reason: "CHOICE" });
  });

  it("a choice without a state tag is NOT_STARTED", () => {
    expect(derive("DROPDOWN", { choiceId: "untagged" })).toEqual({ state: "NOT_STARTED", reason: "CHOICE" });
  });

  it("an unknown choice id is NOT_STARTED / UNKNOWN_CHOICE", () => {
    expect(derive("DROPDOWN", { choiceId: "deleted-long-ago" })).toEqual({
      state: "NOT_STARTED",
      reason: "UNKNOWN_CHOICE",
    });
    expect(deriveState(def("DROPDOWN", []), node({ choiceId: "done" }), ctx).reason).toBe("UNKNOWN_CHOICE");
  });

  it("a retag changes the colour of an existing value", () => {
    const retagged = CHOICES.map((c) => (c.id === "waiting" ? { ...c, state: "BLOCKED" as State } : c));
    expect(deriveState(def("DROPDOWN", retagged), node({ choiceId: "waiting" }), ctx).state).toBe("BLOCKED");
  });
});

describe("deriveState: invalid values", () => {
  it.each<[FieldType, unknown]>([
    ["TEXT", { number: 1 }],
    ["TEXT", { text: 5 }],
    ["LONG_TEXT", { text: "a", extra: true }],
    ["NUMBER", { number: "12" }],
    ["NUMBER", { number: Number.POSITIVE_INFINITY }],
    ["PERCENT", { percent: 150 }],
    ["DATE", { date: "2026-13-01" }],
    ["DATE", { date: "12/11/2026" }],
    ["DATE", { date: "2026-02-29" }],
    ["DATE_RANGE", { date: "2026-10-25" }],
    ["DATE_RANGE", { start: "2026-1-1" }],
    ["DROPDOWN", { choiceIds: ["done"] }],
    ["DROPDOWN", { choiceId: 7 }],
    ["MULTIPLE", { choiceId: "done" }],
    ["MULTIPLE", { choiceIds: "done" }],
    ["CHECKBOX", { checked: false }],
    ["CHECKBOX", { checked: "yes" }],
    ["LINK", { url: "ftp://files.example.com/x" }],
    ["LINK", { url: "javascript:alert(1)" }],
    ["LINK", { url: "not a url" }],
    ["LINK", { href: "https://example.com" }],
  ])("%s %j -> NOT_STARTED / INVALID_VALUE", (t, v) => {
    expect(derive(t, v as Value)).toEqual({ state: "NOT_STARTED", reason: "INVALID_VALUE" });
  });

  it.each<[unknown]>([[{ text: "x" }], [null]])(
    "an unknown field type (e.g. edited by hand in Notion) with %j is NOT_STARTED / INVALID_VALUE, never undefined",
    (v) => {
      const d: FieldDef = { fieldType: "Dropdown" as unknown as FieldType, choices: [], config: {} };
      expect(deriveState(d, node(v as Value | null), ctx)).toEqual({ state: "NOT_STARTED", reason: "INVALID_VALUE" });
      // N/A and flags still win.
      expect(deriveState(d, node(null, { flag: "BLOCKED" }), ctx)).toEqual({ state: "BLOCKED", reason: "FLAG" });
    },
  );
});

describe("deriveState: precedence N/A > flag > value", () => {
  it.each<[string, Partial<StateNodeInput>, Value | null, State, StateReason]>([
    ["N/A beats a done value", { notApplicable: true }, { choiceId: "done" }, "NOT_APPLICABLE", "NA_MARKED"],
    ["N/A beats a flag", { notApplicable: true, flag: "BLOCKED" }, { choiceId: "done" }, "NOT_APPLICABLE", "NA_MARKED"],
    ["N/A beats an invalid value", { notApplicable: true }, { choiceId: 1 } as unknown as Value, "NOT_APPLICABLE", "NA_MARKED"],
    ["N/A on an empty node", { notApplicable: true }, null, "NOT_APPLICABLE", "NA_MARKED"],
    ["WAITING flag beats a done value", { flag: "WAITING" }, { choiceId: "done" }, "WAITING", "FLAG"],
    ["BLOCKED flag beats a done value", { flag: "BLOCKED" }, { choiceId: "done" }, "BLOCKED", "FLAG"],
    ["flag beats an NA-tagged choice", { flag: "BLOCKED" }, { choiceId: "not-needed" }, "BLOCKED", "FLAG"],
    ["flag beats an invalid value", { flag: "BLOCKED" }, { choiceId: 1 } as unknown as Value, "BLOCKED", "FLAG"],
    ["flag on an empty node", { flag: "WAITING" }, null, "WAITING", "FLAG"],
    ["no flag: the value decides", { flag: null }, { choiceId: "done" }, "DONE", "CHOICE"],
  ])("%s", (_label, extra, value, state, reason) => {
    expect(derive("DROPDOWN", value, extra)).toEqual({ state, reason });
  });

  it("a flagged date stays flagged after the date passes", () => {
    expect(derive("DATE", { date: YESTERDAY }, { flag: "BLOCKED" })).toEqual({ state: "BLOCKED", reason: "FLAG" });
  });

  it("flags apply to every field type, including FILE", () => {
    for (const t of FIELD_TYPES) {
      expect(derive(t, null, { flag: "WAITING", attachmentCount: 2 }).state, t).toBe("WAITING");
      expect(derive(t, null, { notApplicable: true, flag: "WAITING" }).state, t).toBe("NOT_APPLICABLE");
    }
  });
});

// ---------------------------------------------------------------------------
// Seed: every dropdown choice maps to its bracket code in BRIEF.md
// ---------------------------------------------------------------------------

const CODE_TO_STATE: Record<string, State> = {
  NS: "NOT_STARTED",
  IP: "IN_PROGRESS",
  W: "WAITING",
  B: "BLOCKED",
  D: "DONE",
  NA: "NOT_APPLICABLE",
};

/** Parses the seed list of BRIEF.md: number -> [{label, state}] for Dropdown milestones. */
function briefDropdowns(): Map<number, { label: string; state: State }[]> {
  const brief = readFileSync(path.resolve(__dirname, "../../../docs/BRIEF.md"), "utf8");
  const section = brief.slice(brief.indexOf("## SEED"));
  const out = new Map<number, { label: string; state: State }[]>();
  for (const line of section.split("\n")) {
    const m = /^(\d+)\. .+? — Dropdown: (.+)$/.exec(line.trim());
    if (!m) continue;
    const n = Number(m[1]);
    const same = /^same choices as (\d+)$/.exec(m[2].trim());
    if (same) {
      out.set(n, out.get(Number(same[1]))!);
      continue;
    }
    out.set(
      n,
      m[2].split(" · ").map((part) => {
        const c = /^(.+?) \[(NS|IP|W|B|D|NA)\]$/.exec(part.trim());
        if (!c) throw new Error(`Cannot parse choice "${part}" of milestone ${n}`);
        return { label: c[1], state: CODE_TO_STATE[c[2]] };
      }),
    );
  }
  return out;
}

describe("seed: every Dropdown choice derives the state of its bracket code in BRIEF.md", () => {
  const seed = seedTemplateFile();
  const expected = briefDropdowns();

  it("BRIEF.md lists 50 Dropdown milestones, all of them Dropdowns in the seed", () => {
    // 64 milestones minus 10 dates, 1 percent, 1 date range, 1 multiple and 1 text = 50 dropdowns
    expect(expected.size).toBe(50);
    expect(seed.milestones.filter((m) => m.fieldType === "DROPDOWN")).toHaveLength(50);
  });

  const cases: [number, string, string, State][] = [];
  for (const [n, choices] of expected) {
    for (const c of choices) cases.push([n, seed.milestones[n - 1].key, c.label, c.state]);
  }

  it.each(cases)("#%i %s: %s -> %s", (n, key, label, state) => {
    const m = seed.milestones[n - 1];
    expect(m.key).toBe(key);
    expect(m.fieldType).toBe("DROPDOWN");
    const choice = m.choices.find((c) => c.label === label);
    expect(choice, `choice "${label}" on #${n}`).toBeDefined();
    const fieldDef: FieldDef = { fieldType: m.fieldType, choices: m.choices, config: m.config ?? {} };
    expect(deriveState(fieldDef, node({ choiceId: choice!.id }), ctx)).toEqual({ state, reason: "CHOICE" });
  });

  it("each seed Dropdown has exactly the choices of the brief, in order", () => {
    for (const [n, choices] of expected) {
      expect(seed.milestones[n - 1].choices.map((c) => [c.label, c.state])).toEqual(choices.map((c) => [c.label, c.state]));
    }
  });
});

// ---------------------------------------------------------------------------
// Metadata and helpers
// ---------------------------------------------------------------------------

describe("STATE_META and helpers", () => {
  it.each<[State, string, StateCode, string, number]>([
    ["BLOCKED", "Blocked", "B", "red", 0],
    ["WAITING", "Waiting", "W", "yellow", 1],
    ["IN_PROGRESS", "In progress", "IP", "blue", 2],
    ["NOT_STARTED", "Not started", "NS", "gray", 3],
    ["DONE", "Done", "D", "green", 4],
    ["NOT_APPLICABLE", "Not applicable", "NA", "default", 5],
  ])("%s: %s, %s, %s, rank %i", (state, label, code, notionColor, rank) => {
    expect(STATE_META[state]).toEqual({ label, code, notionColor, rank });
    expect(stateFromCode(code)).toBe(state);
    expect(parseState(code)).toBe(state);
    expect(parseState(label.toUpperCase())).toBe(state);
    expect(parseState(state)).toBe(state);
  });

  it("covers every state with a unique code and rank", () => {
    expect(Object.keys(STATE_META).sort()).toEqual([...STATES].sort());
    expect(new Set(STATES.map((s) => STATE_META[s].code)).size).toBe(6);
    expect(new Set(STATES.map((s) => STATE_META[s].rank)).size).toBe(6);
  });

  it("stateFromCode throws on unknown codes; parseState returns undefined", () => {
    expect(() => stateFromCode("X" as StateCode)).toThrow();
    expect(parseState("nope")).toBeUndefined();
  });

  it.each<[State, boolean]>([
    ["NOT_STARTED", true],
    ["IN_PROGRESS", true],
    ["WAITING", true],
    ["BLOCKED", true],
    ["DONE", false],
    ["NOT_APPLICABLE", false],
  ])("isOpenState(%s) = %s", (s, open) => {
    expect(isOpenState(s)).toBe(open);
  });

  const ALL_REASONS: StateReason[] = [
    "NA_MARKED",
    "FLAG",
    "INVALID_VALUE",
    "EMPTY",
    "CHOICE",
    "UNKNOWN_CHOICE",
    "DATE_PLANNED",
    "DATE_REACHED",
    "DATE_PASSED_AUTO",
    "RANGE_UPCOMING",
    "RANGE_RUNNING",
    "RANGE_ENDED",
    "PERCENT",
    "FILLED",
    "FILES",
  ];

  it("isDateDrivenReason is true only for DATE_PLANNED, RANGE_UPCOMING and RANGE_RUNNING", () => {
    expect(ALL_REASONS.filter(isDateDrivenReason)).toEqual(["DATE_PLANNED", "RANGE_UPCOMING", "RANGE_RUNNING"]);
  });

  it("describeReason gives plain English for every reason", () => {
    for (const r of ALL_REASONS) expect(describeReason(r).length, r).toBeGreaterThan(5);
    expect(describeReason("DATE_PLANNED")).toBe("Future date: in progress (planned)");
    expect(new Set(ALL_REASONS.map(describeReason)).size).toBe(ALL_REASONS.length);
  });

  it("compareStates / worstState order worst first", () => {
    expect([...STATES].sort(compareStates)).toEqual([
      "BLOCKED",
      "WAITING",
      "IN_PROGRESS",
      "NOT_STARTED",
      "DONE",
      "NOT_APPLICABLE",
    ]);
    expect(worstState(["DONE", "WAITING", "IN_PROGRESS"])).toBe("WAITING");
    expect(worstState([])).toBeUndefined();
  });
});
