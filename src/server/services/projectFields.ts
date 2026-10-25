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
import type { ProjectFieldInput, ProjectMirrors, Repo } from "@/server/repo/types";
import {
  alreadyLogged,
  appendHistory,
  AppError,
  dataRef,
  EV,
  findUnloggedCreate,
  LIBRARY_PREFIX,
  notFound,
  requireName,
  summaryFor,
  type Ctx,
} from "./context";
import { hasChoices, prepareChoices, prepareConfig, requireFieldType, typeLabel, type ChoiceInput } from "./definitions";
import { settleSome } from "./jobs";
import { projectDetailMirrors } from "./mirrors";

export async function listProjectFields(repo: Repo, opts: { includeArchived?: boolean } = {}): Promise<ProjectField[]> {
  const fields = await repo.projectFields.list({ includeArchived: opts.includeArchived });
  return [...fields].sort((a, b) => a.order - b.order || a.key.localeCompare(b.key));
}

async function requireField(ctx: Ctx, id: string): Promise<ProjectField> {
  return (await requireFieldAmong(ctx, id)).field;
}

/** The field and every project field (archived included). */
async function requireFieldAmong(ctx: Ctx, id: string): Promise<{ field: ProjectField; all: ProjectField[] }> {
  const all = await ctx.repo.projectFields.list({ includeArchived: true });
  const field = all.find((x) => x.id === id);
  if (!field) throw notFound("This project field");
  return { field, all };
}

function fieldSummary(text: string): string {
  return summaryFor(LIBRARY_PREFIX, text);
}

/** The active field (other than `exceptId`) already called `label` (case and outer spaces ignored), if any. */
export function activeFieldCalled(all: ProjectField[], label: string, exceptId?: string): ProjectField | undefined {
  const wanted = label.trim().toLowerCase();
  return all.find((f) => !f.archived && f.id !== exceptId && f.label.trim().toLowerCase() === wanted);
}

/** Two active fields with the same name would be indistinguishable on forms and in the Portfolio filters. */
export function assertLabelFree(all: ProjectField[], label: string, exceptId?: string, opts: { restoring?: boolean } = {}): void {
  const dup = activeFieldCalled(all, label, exceptId);
  if (!dup) return;
  throw new AppError(
    "VALIDATION",
    opts.restoring
      ? `There is already a project field called "${dup.label}". Rename that field first, then restore this one.`
      : `There is already a project field called "${dup.label}". Choose another name.`,
  );
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
  const same = all.filter((f) => f.label === label && f.fieldType === fieldType && !f.archived);
  if (await alreadyLogged(ctx)) {
    if (same[0]) return same[0];
  }
  // A retry after a crash between the create and the History row adopts the field the first attempt created.
  const adopted = await findUnloggedCreate(ctx, same, { type: EV.projectFieldCreated, refOf: dataRef("fieldId") });
  if (!adopted) assertLabelFree(all, label);
  const field =
    adopted ??
    (await ctx.repo.projectFields.create({
      key: slugify(label, all.map((f) => f.key)),
      label,
      fieldType,
      choices,
      config,
      order: (all.length ? Math.max(...all.map((f) => f.order)) : 0) + 1,
      showInSummary: input.showInSummary === true,
      archived: false,
    }));
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

/** More projects than this: the Notion mirrors a field change affects are left to Settings → Repair mirrors. */
export const MIRROR_REFRESH_LIMIT = 30;

export interface UpdatedProjectField extends ProjectField {
  /** Projects whose Notion mirrors (Customer, Project type, Summary) were rewritten because of this change. */
  mirrorsUpdated?: number;
  /** Plain English, set when more than MIRROR_REFRESH_LIMIT projects are affected: run Repair mirrors. */
  mirrorsNote?: string;
}

/**
 * Edits a project field. Choices are never removed (left out = archived). A type change converts every project's
 * value with convertValue; when any value can't be converted the change is refused, naming those projects.
 * System fields must keep a Dropdown or Multiple type.
 *
 * The Notion mirrors of projects (Customer and Project type selects, the Summary line) show detail values through
 * this field's type and choices: when the change alters them (choices, type, settings, "show in summary" or order of
 * the Customer / Project type field or a summary field), the affected projects' mirrors are rewritten too, up to
 * MIRROR_REFRESH_LIMIT projects; beyond that the result says to run Settings → Repair mirrors.
 */
export async function updateProjectField(ctx: Ctx, id: string, patch: ProjectFieldPatch): Promise<UpdatedProjectField> {
  const { field: f, all: allFields } = await requireFieldAmong(ctx, id);
  const next: Partial<ProjectFieldInput> = {};
  const changes: string[] = [];

  if (patch.label !== undefined) {
    const label = requireName(patch.label, "The field name");
    if (label !== f.label) {
      assertLabelFree(allFields, label, f.id);
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
  let projects: Project[] | null = null;
  if (fieldType !== f.fieldType) {
    projects = await ctx.repo.projects.list({ includeArchived: true });
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

  // Projects whose Notion mirrors this change alters (computed with the field as it is and as it will be).
  const fieldsAfter = allFields.map((x) => (x.id === id ? ({ ...x, ...next } as ProjectField) : x));
  const touchesMirrors =
    (f.systemKey !== undefined || f.showInSummary || next.showInSummary === true) &&
    (["choices", "fieldType", "config", "showInSummary", "order"] as const).some((k) => k in next);
  const converted = new Map(conversions.map((c) => [c.projectId, c.value]));
  const mirrorsAfter = (p: Project, details: Record<string, Value | null>) => {
    const after = projectDetailMirrors(fieldsAfter, details);
    return stableStringify(after) !== stableStringify(projectDetailMirrors(allFields, p.details ?? {})) ? after : null;
  };
  let mirrorOnly: { project: Project; mirrors: ProjectMirrors }[] = [];
  if (touchesMirrors) {
    projects ??= await ctx.repo.projects.list({ includeArchived: true });
    for (const p of projects) {
      if (converted.has(p.id)) continue; // written together with the converted value below
      const m = mirrorsAfter(p, p.details ?? {});
      if (m) mirrorOnly.push({ project: p, mirrors: m });
    }
  }
  let mirrorsNote: string | undefined;
  if (mirrorOnly.length > MIRROR_REFRESH_LIMIT) {
    mirrorsNote = `The Customer, Project type and Summary columns in Notion of ${mirrorOnly.length} projects still show the old values. Run Settings → Repair mirrors to update them.`;
    mirrorOnly = [];
  }

  // Write order: project values (converted) → History → mirrors → field. A retry after a crash at any point finishes
  // the change: values already converted are left alone, the History row is written once per opId, the mirrors are
  // derived again from the field as it still is, and the field is updated last, so its type never runs ahead of the
  // values.
  let mirrorsUpdated = 0;
  for (const c of conversions) {
    const p = await ctx.repo.projects.get(c.projectId);
    if (!p) continue;
    const details = { ...(p.details ?? {}), [id]: c.value };
    const mirrors = touchesMirrors ? mirrorsAfter(p, details) : null;
    if (mirrors) mirrorsUpdated++;
    await ctx.repo.projects.update(p.id, mirrors ? { details, mirrors } : { details });
  }
  if (changes.length) {
    const after = { ...f, ...next };
    await appendHistory(ctx, {
      type: EV.projectFieldUpdated,
      summary: fieldSummary(`Updated project field "${after.label}": ${changes.join("; ")}`),
      data: {
        fieldId: id,
        key: f.key,
        changes,
        old: { label: f.label, fieldType: f.fieldType, choices: f.choices },
        new: { label: after.label, fieldType: after.fieldType, choices: after.choices },
        convertedProjects: conversions.map((c) => c.projectId),
      },
    });
  }
  // Derived data only: in parallel (the Notion client keeps 3 in flight); a failure stops before the field changes.
  const written = await settleSome(mirrorOnly.map(({ project, mirrors }) => () => ctx.repo.projects.update(project.id, { mirrors })));
  if (written.error) throw written.error;
  mirrorsUpdated += mirrorOnly.length;
  const updated: UpdatedProjectField = await ctx.repo.projectFields.update(id, next);
  if (mirrorsUpdated) updated.mirrorsUpdated = mirrorsUpdated;
  if (mirrorsNote) updated.mirrorsNote = mirrorsNote;
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
  // History → field (as for every toggle): a retry with the same opId finishes an interrupted archive with one row.
  await appendHistory(ctx, {
    type: EV.projectFieldArchived,
    summary: fieldSummary(`Archived project field "${f.label}"`),
    data: { fieldId: id, key: f.key },
  });
  await ctx.repo.projectFields.update(id, { archived: true, archivedAt: ctx.now });
}

export async function restoreProjectField(ctx: Ctx, id: string): Promise<void> {
  const { field: f, all } = await requireFieldAmong(ctx, id);
  if (!f.archived) return;
  // Restoring must not leave two active fields with the same name (one may have been created after this was archived).
  assertLabelFree(all, f.label, f.id, { restoring: true });
  await appendHistory(ctx, {
    type: EV.projectFieldRestored,
    summary: fieldSummary(`Restored project field "${f.label}"`),
    data: { fieldId: id, key: f.key },
  });
  await ctx.repo.projectFields.update(id, { archived: false, archivedAt: undefined });
}

/** Display of a project detail value (summary line, Projects table). */
export function formatDetail(field: ProjectField, value: Value | null | undefined): string {
  return formatValue({ fieldType: field.fieldType, choices: field.choices ?? [], config: field.config ?? {} }, value ?? null, {
    short: true,
  });
}
