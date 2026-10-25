import "server-only";
/**
 * Configurable project detail fields (Customer, End user, Site / country, Product, Quantity, Project type, Notes).
 * Values point live at the field definition (no snapshot). Type changes convert every project's value losslessly
 * with convertValue, or are refused naming the projects that block them. System fields (customer, projectType) can
 * be renamed and have their choices edited, but never be archived.
 */
import { convertValue } from "@/domain/convertValue";
import { formatValue } from "@/domain/format";
import { slugify } from "@/domain/slug";
import { choicesEqual, stableStringify } from "@/domain/syncPlan";
import type { Choice, FieldConfig, FieldType, Project, ProjectField, Value } from "@/domain/types";
import { isEmptyValue, isValidValue } from "@/domain/values";
import type { ProjectFieldInput, Repo } from "@/server/repo/types";
import {
  alreadyLogged,
  appendHistory,
  AppError,
  EV,
  LIBRARY_PREFIX,
  notFound,
  requireName,
  summaryFor,
  type Ctx,
} from "./context";
import { hasChoices, prepareChoices, prepareConfig, requireFieldType, typeLabel, type ChoiceInput } from "./definitions";

export async function listProjectFields(repo: Repo, opts: { includeArchived?: boolean } = {}): Promise<ProjectField[]> {
  const fields = await repo.projectFields.list({ includeArchived: opts.includeArchived });
  return [...fields].sort((a, b) => a.order - b.order || a.key.localeCompare(b.key));
}

async function requireField(ctx: Ctx, id: string): Promise<ProjectField> {
  const all = await ctx.repo.projectFields.list({ includeArchived: true });
  const f = all.find((x) => x.id === id);
  if (!f) throw notFound("This project field");
  return f;
}

function fieldSummary(text: string): string {
  return summaryFor(LIBRARY_PREFIX, text);
}

export interface CreateProjectFieldInput {
  label: string;
  fieldType: FieldType;
  choices?: ChoiceInput[];
  config?: FieldConfig;
  showInSummary?: boolean;
}

export async function createProjectField(ctx: Ctx, input: CreateProjectFieldInput): Promise<ProjectField> {
  const label = requireName(input.label, "The field name");
  const fieldType = requireFieldType(input.fieldType, { allowFile: false });
  const choices = prepareChoices(input.choices ?? [], { fieldType, existing: [], withStates: false });
  const config = prepareConfig(input.config);
  const all = await ctx.repo.projectFields.list({ includeArchived: true });
  if (await alreadyLogged(ctx)) {
    const same = all.find((f) => f.label === label && !f.archived);
    if (same) return same;
  }
  const data: ProjectFieldInput = {
    key: slugify(label, all.map((f) => f.key)),
    label,
    fieldType,
    choices,
    config,
    order: (all.length ? Math.max(...all.map((f) => f.order)) : 0) + 1,
    showInSummary: input.showInSummary === true,
    archived: false,
  };
  const field = await ctx.repo.projectFields.create(data);
  await appendHistory(ctx, {
    type: EV.projectFieldCreated,
    summary: fieldSummary(`Added project field "${label}"`),
    newDisplay: label,
    data: { fieldId: field.id, key: field.key, fieldType },
  });
  return field;
}

export interface ProjectFieldPatch {
  label?: string;
  fieldType?: FieldType;
  choices?: ChoiceInput[];
  config?: FieldConfig;
  showInSummary?: boolean;
  order?: number;
}

/** A project whose value blocks a type change, with the reason. */
export interface BlockingProject {
  projectId: string;
  code: string;
  reason: string;
}

/**
 * Converts every project's value of a field to a new type. Returns the converted values, or the projects whose
 * value can't be converted losslessly. A value already in the new shape (converted by an interrupted earlier attempt)
 * is left alone; a value that fits neither type is data, never "empty": it blocks the change.
 */
export function planFieldRetype(
  field: Pick<ProjectField, "id" | "fieldType">,
  to: FieldType,
  toChoices: Choice[],
  projects: Project[],
): { ok: true; values: { projectId: string; value: Value | null }[] } | { ok: false; blocking: BlockingProject[] } {
  const values: { projectId: string; value: Value | null }[] = [];
  const blocking: BlockingProject[] = [];
  for (const p of projects) {
    const v = p.details?.[field.id] ?? null;
    if (v === null) continue;
    if (!isValidValue(field.fieldType, v)) {
      if (!isValidValue(to, v)) {
        blocking.push({ projectId: p.id, code: p.code, reason: `The current value is not a valid ${typeLabel(field.fieldType)} value.` });
      }
      continue;
    }
    if (isEmptyValue(field.fieldType, v)) {
      values.push({ projectId: p.id, value: null });
      continue;
    }
    const r = convertValue(field.fieldType, to, v, hasChoices(to) ? toChoices : undefined);
    if (!r.ok) blocking.push({ projectId: p.id, code: p.code, reason: r.reason });
    else if (stableStringify(r.value) !== stableStringify(v)) values.push({ projectId: p.id, value: r.value });
  }
  return blocking.length ? { ok: false, blocking } : { ok: true, values };
}

/**
 * Edits a project field. Choices are never removed (left out = archived). A type change converts every project's
 * value with convertValue; when any value can't be converted the change is refused, naming those projects.
 * System fields must keep a Dropdown or Multiple type.
 */
export async function updateProjectField(ctx: Ctx, id: string, patch: ProjectFieldPatch): Promise<ProjectField> {
  const f = await requireField(ctx, id);
  const next: Partial<ProjectFieldInput> = {};
  const changes: string[] = [];

  if (patch.label !== undefined) {
    const label = requireName(patch.label, "The field name");
    if (label !== f.label) {
      next.label = label;
      changes.push(`renamed "${f.label}" → "${label}"`);
    }
  }
  const fieldType = patch.fieldType !== undefined ? requireFieldType(patch.fieldType, { allowFile: false }) : f.fieldType;
  if (f.systemKey && !hasChoices(fieldType)) {
    throw new AppError("FORBIDDEN", `"${f.label}" is used by the Portfolio filters, so it must stay a Dropdown or Multiple field.`);
  }
  const choices =
    patch.choices !== undefined
      ? prepareChoices(patch.choices, { fieldType, existing: f.choices ?? [], withStates: false })
      : (f.choices ?? []);
  if (!choicesEqual(choices, f.choices ?? [])) {
    next.choices = choices;
    changes.push("choices");
  }
  if (patch.config !== undefined) {
    const config = prepareConfig(patch.config);
    if (stableStringify(config) !== stableStringify(f.config ?? {})) {
      next.config = config;
      changes.push("settings");
    }
  }
  if (patch.showInSummary !== undefined && patch.showInSummary !== f.showInSummary) {
    next.showInSummary = patch.showInSummary === true;
    changes.push(next.showInSummary ? "shown in summary" : "hidden from summary");
  }
  if (patch.order !== undefined) {
    if (!Number.isFinite(patch.order)) throw new AppError("VALIDATION", "The order must be a number.");
    if (patch.order !== f.order) next.order = patch.order;
  }

  let conversions: { projectId: string; value: Value | null }[] = [];
  if (fieldType !== f.fieldType) {
    const projects = await ctx.repo.projects.list({ includeArchived: true });
    const plan = planFieldRetype(f, fieldType, choices, projects);
    if (!plan.ok) {
      const codes = plan.blocking.map((b) => b.code);
      throw new AppError(
        "VALIDATION",
        `"${f.label}" can't become ${typeLabel(fieldType)}: the value in ${codes.slice(0, 5).join(", ")}${
          codes.length > 5 ? ` and ${codes.length - 5} more` : ""
        } can't be converted. Change or clear ${codes.length === 1 ? "that value" : "those values"} first.`,
        { blocking: plan.blocking },
      );
    }
    conversions = plan.values;
    next.fieldType = fieldType;
    changes.push(`type ${typeLabel(f.fieldType)} → ${typeLabel(fieldType)}`);
  }

  if (Object.keys(next).length === 0) return f;
  if (await alreadyLogged(ctx)) return f;

  const updated = await ctx.repo.projectFields.update(id, next);
  for (const c of conversions) {
    const p = await ctx.repo.projects.get(c.projectId);
    if (!p) continue;
    await ctx.repo.projects.update(p.id, { details: { ...(p.details ?? {}), [id]: c.value } });
  }
  if (changes.length) {
    await appendHistory(ctx, {
      type: EV.projectFieldUpdated,
      summary: fieldSummary(`Updated project field "${updated.label}": ${changes.join("; ")}`),
      data: {
        fieldId: id,
        key: f.key,
        changes,
        old: { label: f.label, fieldType: f.fieldType, choices: f.choices },
        new: { label: updated.label, fieldType: updated.fieldType, choices: updated.choices },
        convertedProjects: conversions.map((c) => c.projectId),
      },
    });
  }
  return updated;
}

/** Adds one choice from the project form ("Add customer…"). Returns the field and the new (or existing) choice id. */
export async function addProjectFieldChoice(
  ctx: Ctx,
  fieldId: string,
  label: string,
): Promise<{ field: ProjectField; choiceId: string }> {
  const f = await requireField(ctx, fieldId);
  if (!hasChoices(f.fieldType)) throw new AppError("VALIDATION", `"${f.label}" has no choices.`);
  const clean = requireName(label, "The choice");
  const existing = (f.choices ?? []).find((c) => c.label.toLowerCase() === clean.toLowerCase());
  if (existing && !existing.archived) return { field: f, choiceId: existing.id };
  const choices = (f.choices ?? []).map((c) => (existing && c.id === existing.id ? { ...c, archived: false } : c));
  if (!existing) choices.push({ id: slugify(clean, choices.map((c) => c.id)), label: clean });
  const field = await updateProjectField(ctx, fieldId, { choices });
  const choiceId = existing?.id ?? field.choices.find((c) => c.label === clean)!.id;
  return { field, choiceId };
}

export async function archiveProjectField(ctx: Ctx, id: string): Promise<void> {
  const f = await requireField(ctx, id);
  if (f.systemKey) {
    throw new AppError("FORBIDDEN", `"${f.label}" is used by the Portfolio filters and can't be archived. You can rename it.`);
  }
  if (f.archived) return;
  await ctx.repo.projectFields.update(id, { archived: true, archivedAt: ctx.now });
  await appendHistory(ctx, {
    type: EV.projectFieldArchived,
    summary: fieldSummary(`Archived project field "${f.label}"`),
    data: { fieldId: id, key: f.key },
  });
}

export async function restoreProjectField(ctx: Ctx, id: string): Promise<void> {
  const f = await requireField(ctx, id);
  if (!f.archived) return;
  await ctx.repo.projectFields.update(id, { archived: false, archivedAt: undefined });
  await appendHistory(ctx, {
    type: EV.projectFieldRestored,
    summary: fieldSummary(`Restored project field "${f.label}"`),
    data: { fieldId: id, key: f.key },
  });
}

/** Display of a project detail value (summary line, Projects table). */
export function formatDetail(field: ProjectField, value: Value | null | undefined): string {
  return formatValue({ fieldType: field.fieldType, choices: field.choices ?? [], config: field.config ?? {} }, value ?? null, {
    short: true,
  });
}
