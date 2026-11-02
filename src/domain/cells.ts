/**
 * Cells: the compact per-step summary stored on each project row so the Portfolio can derive state and a short
 * value for every step without reading the steps themselves.
 */
import { formatValue } from "./format";
import { deriveState, type DerivedState, type StateNodeInput } from "./state";
import type {
  Cell,
  Choice,
  DayContext,
  DropdownValue,
  FieldDef,
  LinkValue,
  MultipleValue,
  Step,
  TextValue,
  Value,
} from "./types";
import { isValidValue } from "./values";

/** Text values in cells are cut to this many characters (state only needs emptiness; display needs 40). */
export const CELL_TEXT_LENGTH = 60;

function cutText(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max).join("");
}

/** The "lite" form of a value: text cut to 60 characters; links reduced to origin + short label. */
export function liteValue(step: Pick<Step, "fieldType" | "value">): Value | null {
  const v = step.value;
  if (v === null || v === undefined || step.fieldType === "FILE") return null;
  if (!isValidValue(step.fieldType, v)) return v; // keep as is, so the cell derives INVALID_VALUE too
  switch (step.fieldType) {
    case "TEXT":
    case "LONG_TEXT":
      return { text: cutText((v as TextValue).text.trim(), CELL_TEXT_LENGTH) };
    case "LINK": {
      const { url, label } = v as LinkValue;
      let origin = url;
      try {
        origin = new URL(url).origin;
      } catch {
        // valid values always parse; keep the url otherwise
      }
      const lite: LinkValue = { url: origin };
      if (label) lite.label = cutText(label, CELL_TEXT_LENGTH);
      return lite;
    }
    default:
      return v;
  }
}

function selectedChoices(step: Pick<Step, "fieldType" | "value" | "choices">): Choice[] | undefined {
  const v = step.value;
  if (!v) return undefined;
  const choices = step.choices ?? [];
  if (step.fieldType === "DROPDOWN") {
    const id = (v as DropdownValue).choiceId;
    const found = choices.filter((c) => c.id === id);
    return found.length ? found.map((c) => ({ ...c })) : undefined;
  }
  if (step.fieldType === "MULTIPLE") {
    const ids = (v as MultipleValue).choiceIds;
    if (!Array.isArray(ids)) return undefined;
    const wanted = new Set(ids);
    const found = choices.filter((c) => wanted.has(c.id));
    return found.length ? found.map((c) => ({ ...c })) : undefined;
  }
  return undefined;
}

/** Builds the compact cell for a step. Optional fields are left out when empty, to keep the JSON small. */
export function buildCell(step: Step, attachmentCount: number): Cell {
  const cell: Cell = { n: step.name, t: step.fieldType, v: liteValue(step) };
  if (step.milestoneId) cell.m = step.milestoneId;
  if (step.milestoneKey) cell.k = step.milestoneKey;
  const ch = selectedChoices(step);
  if (ch) cell.ch = ch;
  if (step.notApplicable) cell.na = true;
  if (step.flag) cell.f = step.flag;
  if (attachmentCount > 0) cell.fc = Math.floor(attachmentCount);
  if (step.valueSetAt) cell.vs = step.valueSetAt;
  if (step.stateChangedAt) cell.c = step.stateChangedAt;
  if (typeof step.order === "number") cell.o = step.order;
  return cell;
}

/** The field definition a cell carries (only the selected choices; no config). */
export function cellDef(cell: Cell): FieldDef {
  return { fieldType: cell.t, choices: cell.ch ?? [], config: {} };
}

export function cellNode(cell: Cell): StateNodeInput {
  const node: StateNodeInput = {
    value: cell.v ?? null,
    notApplicable: cell.na === true,
    flag: cell.f ?? null,
    attachmentCount: cell.fc ?? 0,
  };
  if (cell.vs) node.valueSetAt = cell.vs;
  return node;
}

export function cellState(cell: Cell, ctx: DayContext): DerivedState {
  return deriveState(cellDef(cell), cellNode(cell), ctx);
}

/** Short display value for a cell (Portfolio tooltips, My open items). */
export function cellDisplay(cell: Cell, ctx?: DayContext): string {
  return formatValue(cellDef(cell), cell.v ?? null, {
    attachmentCount: cell.fc ?? 0,
    short: true,
    today: ctx?.today,
  });
}
