import "server-only";
/**
 * Validation shared by milestones, project-only steps and project fields: field types, choice lists and config.
 */
import { FIELD_TYPE_META, isFieldType } from "@/domain/fieldTypes";
import { slugify } from "@/domain/slug";
import { STATES, type Choice, type FieldConfig, type FieldType, type State } from "@/domain/types";
import { AppError, MAX_NAME_LENGTH } from "./context";

/** A choice as sent by the UI: `id` only for existing choices (new ones get a slug of the label). */
export interface ChoiceInput {
  id?: string;
  label: string;
  state?: State;
  archived?: boolean;
}

export const MAX_CHOICES = 100;

export function requireFieldType(raw: unknown, opts: { allowFile?: boolean } = {}): FieldType {
  if (!isFieldType(raw)) throw new AppError("VALIDATION", "Pick a field type.");
  if (raw === "FILE" && opts.allowFile === false) {
    throw new AppError("VALIDATION", "File is not available for project fields. Use a Link field instead.");
  }
  return raw;
}

export interface PrepareChoicesOptions {
  fieldType: FieldType;
  /** Choices stored now (archived included). Ids are never reused; missing ones are kept as archived. */
  existing: Choice[];
  /** Milestones and steps: Dropdown choices need a state. Project fields: states are dropped. */
  withStates: boolean;
  /** Missing Dropdown states become NOT_STARTED instead of an error (used when the type just changed to Dropdown). */
  defaultMissingState?: boolean;
}

/**
 * Validates a choice list from the UI and turns it into stored choices:
 * labels non-empty and unique ids; Dropdown choices need a state; new choices get slugify(label, all ids incl.
 * archived); choices are never removed (one left out of the input is kept with archived: true, at the end).
 */
export function prepareChoices(input: unknown, opts: PrepareChoicesOptions): Choice[] {
  if (!Array.isArray(input)) throw new AppError("VALIDATION", "Choices must be a list.");
  if (input.length > MAX_CHOICES) throw new AppError("VALIDATION", `A list can have at most ${MAX_CHOICES} choices.`);
  const existingById = new Map(opts.existing.map((c) => [c.id, c]));
  const taken = new Set(opts.existing.map((c) => c.id));
  const seen = new Set<string>();
  const out: Choice[] = [];
  const needsState = opts.withStates && opts.fieldType === "DROPDOWN";

  for (const raw of input as unknown[]) {
    if (!raw || typeof raw !== "object") throw new AppError("VALIDATION", "Each choice needs a label.");
    const c = raw as Partial<ChoiceInput>;
    if (typeof c.label !== "string" || !c.label.trim()) throw new AppError("VALIDATION", "Choice labels can't be empty.");
    const label = c.label.trim().replace(/\s+/g, " ");
    if (label.length > MAX_NAME_LENGTH) {
      throw new AppError("VALIDATION", `The choice "${label.slice(0, 40)}…" is too long (maximum ${MAX_NAME_LENGTH} characters).`);
    }
    let id: string;
    if (typeof c.id === "string" && existingById.has(c.id)) {
      id = c.id;
    } else {
      id = slugify(label, taken);
    }
    if (seen.has(id)) throw new AppError("VALIDATION", `The choice "${label}" is listed twice.`);
    seen.add(id);
    taken.add(id);

    const choice: Choice = { id, label };
    let state = c.state;
    if (state !== undefined && !(STATES as readonly string[]).includes(state)) {
      throw new AppError("VALIDATION", `The choice "${label}" has an unknown state.`);
    }
    if (opts.withStates) {
      if (!state && needsState) {
        if (opts.defaultMissingState) state = "NOT_STARTED";
        else throw new AppError("VALIDATION", `Pick a state (colour) for the choice "${label}".`);
      }
      if (state) choice.state = state;
    }
    if (c.archived) choice.archived = true;
    out.push(choice);
  }

  // Never remove a choice: anything left out stays, archived, so values on it keep their label and tag.
  for (const old of opts.existing) {
    if (seen.has(old.id)) continue;
    const kept: Choice = { id: old.id, label: old.label, archived: true };
    if (opts.withStates && old.state) kept.state = old.state;
    out.push(kept);
  }
  return out;
}

/** Fills missing Dropdown states with NOT_STARTED (type switched from Multiple to Dropdown). */
export function withDefaultStates(choices: Choice[]): Choice[] {
  return choices.map((c) => (c.state ? c : { ...c, state: "NOT_STARTED" as State }));
}

export function prepareConfig(raw: unknown): FieldConfig {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new AppError("VALIDATION", "Settings must be an object.");
  const unit = (raw as FieldConfig).unit;
  if (unit === undefined || unit === null) return {};
  if (typeof unit !== "string") throw new AppError("VALIDATION", "The unit must be text.");
  const u = unit.trim();
  if (u.length > 40) throw new AppError("VALIDATION", "The unit is too long (maximum 40 characters).");
  return u ? { unit: u } : {};
}

export function hasChoices(t: FieldType): boolean {
  return FIELD_TYPE_META[t]?.hasChoices ?? false;
}

export function typeLabel(t: FieldType): string {
  return FIELD_TYPE_META[t]?.label ?? t;
}
