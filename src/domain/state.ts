/**
 * State derivation. State is never stored as the source of truth: it is derived from the value, the N/A switch,
 * the flag and today's date every time it is needed.
 */
import { ymdFromInstant } from "./dates";
import { FIELD_TYPES } from "./types";
import type {
  DateRangeValue,
  DateValue,
  DayContext,
  DropdownValue,
  FieldDef,
  Iso,
  NodeFlag,
  PercentValue,
  State,
  StateCode,
  Value,
} from "./types";
import { isEmptyValue, isValidValue } from "./values";

export type StateReason =
  | "NA_MARKED"
  | "FLAG"
  | "INVALID_VALUE"
  | "EMPTY"
  | "CHOICE"
  | "UNKNOWN_CHOICE"
  | "DATE_PLANNED"
  | "DATE_REACHED"
  | "DATE_PASSED_AUTO"
  | "RANGE_UPCOMING"
  | "RANGE_RUNNING"
  | "RANGE_ENDED"
  | "PERCENT"
  | "FILLED"
  | "FILES";

export interface StateNodeInput {
  value: Value | null;
  notApplicable: boolean;
  flag: NodeFlag | null;
  /** When the value was last set; used for DATE_PASSED_AUTO. */
  valueSetAt?: Iso;
  /** Active attachments (files and links); drives FILE fields. */
  attachmentCount?: number;
}

export interface DerivedState {
  state: State;
  reason: StateReason;
}

const r = (state: State, reason: StateReason): DerivedState => ({ state, reason });

/**
 * Rules, first match wins:
 * 1. N/A marked -> NOT_APPLICABLE. 2. Flag -> WAITING / BLOCKED. 3. Value has the wrong shape -> NOT_STARTED.
 * 4. Empty (FILE: no attachments) -> NOT_STARTED. 5. By field type (see DESIGN.md 4.2).
 */
export function deriveState(def: FieldDef, node: StateNodeInput, ctx: DayContext): DerivedState {
  if (node.notApplicable) return r("NOT_APPLICABLE", "NA_MARKED");
  if (node.flag === "WAITING" || node.flag === "BLOCKED") return r(node.flag, "FLAG");

  const t = def.fieldType;
  // A type this version doesn't know (e.g. a field type edited by hand in Notion) can't be read: treat as invalid.
  if (!(FIELD_TYPES as readonly string[]).includes(t)) return r("NOT_STARTED", "INVALID_VALUE");
  if (t === "FILE") {
    // FILE never stores a value: its state comes from attachments only.
    return (node.attachmentCount ?? 0) >= 1 ? r("DONE", "FILES") : r("NOT_STARTED", "EMPTY");
  }

  const value = node.value ?? null;
  if (value !== null && !isValidValue(t, value)) return r("NOT_STARTED", "INVALID_VALUE");
  if (isEmptyValue(t, value)) return r("NOT_STARTED", "EMPTY");
  const v = value as Value;

  switch (t) {
    case "DROPDOWN": {
      const id = (v as DropdownValue).choiceId;
      const choice = (def.choices ?? []).find((c) => c.id === id);
      if (!choice) return r("NOT_STARTED", "UNKNOWN_CHOICE");
      return r(choice.state ?? "NOT_STARTED", "CHOICE");
    }
    case "DATE": {
      const date = (v as DateValue).date;
      if (date > ctx.today) return r("IN_PROGRESS", "DATE_PLANNED");
      return r("DONE", setBefore(node.valueSetAt, date, ctx.timeZone) ? "DATE_PASSED_AUTO" : "DATE_REACHED");
    }
    case "DATE_RANGE": {
      const { start, end } = v as DateRangeValue;
      if (end && end <= ctx.today) return r("DONE", "RANGE_ENDED");
      if (start && start > ctx.today) return r("IN_PROGRESS", "RANGE_UPCOMING");
      return r("IN_PROGRESS", "RANGE_RUNNING");
    }
    case "PERCENT": {
      const p = (v as PercentValue).percent;
      if (p <= 0) return r("NOT_STARTED", "PERCENT");
      if (p >= 100) return r("DONE", "PERCENT");
      return r("IN_PROGRESS", "PERCENT");
    }
    case "NUMBER":
    case "TEXT":
    case "LONG_TEXT":
    case "LINK":
    case "CHECKBOX":
    case "MULTIPLE":
      return r("DONE", "FILLED");
  }
}

/** True when the local date of `valueSetAt` is before `date` (the date was entered in advance). */
function setBefore(valueSetAt: Iso | undefined, date: string, timeZone: string): boolean {
  if (!valueSetAt) return false;
  try {
    return ymdFromInstant(valueSetAt, timeZone) < date;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// State metadata
// ---------------------------------------------------------------------------

export type NotionColor = "gray" | "blue" | "yellow" | "red" | "green" | "default";

export interface StateMeta {
  label: string;
  code: StateCode;
  notionColor: NotionColor;
  /** Worst first: BLOCKED 0 ... NOT_APPLICABLE 5. */
  rank: number;
}

export const STATE_META: Record<State, StateMeta> = {
  NOT_STARTED: { label: "Not started", code: "NS", notionColor: "gray", rank: 3 },
  IN_PROGRESS: { label: "In progress", code: "IP", notionColor: "blue", rank: 2 },
  WAITING: { label: "Waiting", code: "W", notionColor: "yellow", rank: 1 },
  BLOCKED: { label: "Blocked", code: "B", notionColor: "red", rank: 0 },
  DONE: { label: "Done", code: "D", notionColor: "green", rank: 4 },
  NOT_APPLICABLE: { label: "Not applicable", code: "NA", notionColor: "default", rank: 5 },
};

const BY_CODE: Record<StateCode, State> = {
  NS: "NOT_STARTED",
  IP: "IN_PROGRESS",
  W: "WAITING",
  B: "BLOCKED",
  D: "DONE",
  NA: "NOT_APPLICABLE",
};

export function stateFromCode(code: StateCode): State {
  const state = BY_CODE[code];
  if (!state) throw new RangeError(`Unknown state code "${String(code)}"`);
  return state;
}

/** Lenient lookup for untrusted input: a state code ('W'), a state ('WAITING') or a label ('Waiting'). */
export function parseState(text: string): State | undefined {
  if (typeof text !== "string") return undefined;
  const s = text.trim();
  const upper = s.toUpperCase();
  if (upper in BY_CODE) return BY_CODE[upper as StateCode];
  for (const [state, meta] of Object.entries(STATE_META) as [State, StateMeta][]) {
    if (upper === state || s.toLowerCase() === meta.label.toLowerCase()) return state;
  }
  return undefined;
}

/** Open = still needs work: not DONE and not NOT_APPLICABLE. */
export function isOpenState(s: State): boolean {
  return s !== "DONE" && s !== "NOT_APPLICABLE";
}

/** Reasons that come from a date in the future (hidden from "My open items" unless asked for). */
export function isDateDrivenReason(reason: StateReason): boolean {
  return reason === "DATE_PLANNED" || reason === "RANGE_UPCOMING" || reason === "RANGE_RUNNING";
}

/** Sorts states worst first (BLOCKED, WAITING, IN_PROGRESS, NOT_STARTED, DONE, NOT_APPLICABLE). */
export function compareStates(a: State, b: State): number {
  return STATE_META[a].rank - STATE_META[b].rank;
}

/** The worst state of a list, or undefined for an empty list. */
export function worstState(states: Iterable<State>): State | undefined {
  let worst: State | undefined;
  for (const s of states) if (worst === undefined || compareStates(s, worst) < 0) worst = s;
  return worst;
}

const REASON_TEXT: Record<StateReason, string> = {
  NA_MARKED: "Marked not applicable",
  FLAG: "Flagged: the flag overrides the value",
  INVALID_VALUE: "Invalid value: shown as not started",
  EMPTY: "No value yet: not started",
  CHOICE: "Colour comes from the chosen option",
  UNKNOWN_CHOICE: "Unknown option: shown as not started",
  DATE_PLANNED: "Future date: in progress (planned)",
  DATE_REACHED: "Date reached: done",
  DATE_PASSED_AUTO: "Turned green because the date passed",
  RANGE_UPCOMING: "Date range not started yet: in progress (planned)",
  RANGE_RUNNING: "Date range running: in progress until the end date",
  RANGE_ENDED: "End date reached: done",
  PERCENT: "0 % = not started, 1–99 % = in progress, 100 % = done",
  FILLED: "Filled in: done",
  FILES: "File or link attached: done",
};

/** Plain-English helper text for a reason, e.g. 'Future date: in progress (planned)'. */
export function describeReason(reason: StateReason): string {
  return REASON_TEXT[reason] ?? "";
}
