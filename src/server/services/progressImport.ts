/**
 * Progress import: brings projects and their milestone progress from a file (prepared from emails) into the app,
 * through the same services the screens use, so History, colours and the Notion mirrors stay right.
 *
 * Safe to run again. Every write has an opId derived from what it writes, so a repeat is skipped (or finishes an
 * interrupted write). A step someone changed in the app is never overwritten: a step is written only when nothing is
 * set on it yet or its last change came from an import. Notes and links are only added, never removed.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { formatValue } from "@/domain/format";
import { stableStringify } from "@/domain/syncPlan";
import type { Choice, FieldType, NodeFlag, Project, ProjectField, Value } from "@/domain/types";
import { PROJECT_STATUSES } from "@/domain/types";
import { isEmptyValue, normalizeValue } from "@/domain/values";
import type { Repo, StoredStep } from "@/server/repo/types";
import { addLink } from "./attachments";
import { makeCtxFromSettings, type Ctx } from "./context";
import { defOf } from "./mirrors";
import { addNote } from "./notes";
import { addProjectFieldChoice, listProjectFields } from "./projectFields";
import { continueCreateProject, startCreateProject, updateProject, withKnownSteps } from "./projects";
import { setStepFlag, setStepNotApplicable, setStepValue } from "./steps";

/** opIds of import writes start with this, so a later import knows which values it may update. */
export const IMPORT_OP_PREFIX = "imp-";
export const IMPORT_ACTOR = "Claude – from Outlook";

const link = z.object({ name: z.string().max(500).optional(), url: z.string().min(1).max(2000) });

const stepSpec = z.object({
  value: z.unknown().optional(),
  na: z.boolean().optional(),
  flag: z.enum(["WAITING", "BLOCKED"]).optional(),
  flagReason: z.string().max(5000).optional(),
  note: z.string().max(50_000).optional(),
  links: z.array(link).max(20).optional(),
  /** Internet Message ID of the email the change comes from (stored on the History rows). */
  externalRef: z.string().max(500).optional(),
});

const projectSpec = z.object({
  code: z.string().min(1).max(100),
  name: z.string().min(1).max(500),
  status: z.enum(PROJECT_STATUSES).optional(),
  /** Keyed by field key or label; dropdown values by choice id or label (a missing choice is added). */
  details: z.record(z.string(), z.unknown()).optional(),
  /** Keyed by milestone key. */
  steps: z.record(z.string(), stepSpec).optional(),
  notes: z.array(z.string().min(1).max(50_000)).max(50).optional(),
  links: z.array(link).max(20).optional(),
});

export const progressFileSchema = z.object({
  format: z.literal("gunnebo-pm-progress"),
  version: z.literal(1),
  asOf: z.string().optional(),
  source: z.string().optional(),
  projects: z.array(projectSpec).max(500),
});

export type ProgressFile = z.infer<typeof progressFileSchema>;
export type ProgressProject = z.infer<typeof projectSpec>;
export type ProgressStep = z.infer<typeof stepSpec>;

export type ItemOutcome = "done" | "unchanged" | "skipped" | "error" | "planned";

export interface ReportItem {
  code: string;
  what: string;
  outcome: ItemOutcome;
  detail?: string;
}

export interface ProgressReport {
  applied: boolean;
  items: ReportItem[];
  counts: Record<ItemOutcome, number>;
}

export interface ProgressImportOptions {
  /** False (default): plan only, write nothing. */
  apply?: boolean;
  actor?: string;
  log?: (item: ReportItem) => void;
}

/** A deterministic opId for one write: the same file always gives the same ids. */
export function importOpId(...parts: unknown[]): string {
  const h = createHash("sha256").update(parts.map((p) => stableStringify(p ?? null)).join("\u0000")).digest("hex");
  return `${IMPORT_OP_PREFIX}${h.slice(0, 40)}`;
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/** Choice id for an id or a label (case-insensitive), or null. Archived choices are matched by id only. */
export function resolveChoice(choices: Choice[], input: unknown): string | null {
  if (typeof input !== "string" || !input.trim()) return null;
  const byId = choices.find((c) => c.id === input.trim());
  if (byId) return byId.id;
  const byLabel = choices.find((c) => !c.archived && norm(c.label) === norm(input));
  return byLabel ? byLabel.id : null;
}

/** Turns labels into choice ids for Dropdown / Multiple values; other types pass through unchanged. */
function resolveValue(fieldType: FieldType, choices: Choice[], raw: unknown): { value: unknown; unknown: string[] } {
  if (raw === null || raw === undefined || (typeof raw === "object" && !Array.isArray(raw))) return { value: raw, unknown: [] };
  if (fieldType === "DROPDOWN") {
    const id = resolveChoice(choices, raw);
    return id ? { value: id, unknown: [] } : { value: raw, unknown: [String(raw)] };
  }
  if (fieldType === "MULTIPLE" && Array.isArray(raw)) {
    const ids: string[] = [];
    const missing: string[] = [];
    for (const r of raw) {
      const id = resolveChoice(choices, r);
      if (id) ids.push(id);
      else missing.push(String(r));
    }
    return { value: ids, unknown: missing };
  }
  return { value: raw, unknown: [] };
}

/** The import may write a step when nothing is set on it yet, or when its last change came from an import. */
export function importMayWrite(step: StoredStep): boolean {
  if (step.lastOp?.startsWith(IMPORT_OP_PREFIX)) return true;
  return !step.notApplicable && !step.flag && isEmptyValue(step.fieldType, step.value ?? null);
}

/** A value as the app shows it ("Full PO", "15 Dec 2026"), or "empty". */
function display(def: Pick<StepLike, "fieldType" | "choices" | "config">, v: unknown): string {
  if (v === null || v === undefined) return "empty";
  return formatValue(defOf(def), v as Value) || "empty";
}

/** A stand-in step for a project that does not exist yet (dry run): built from the Library milestone. */
type StepLike = Pick<StoredStep, "id" | "name" | "milestoneKey" | "fieldType" | "choices" | "config" | "value" | "notApplicable" | "flag" | "rev" | "lastOp">;

export async function runProgressImport(repo: Repo, input: unknown, opts: ProgressImportOptions = {}): Promise<ProgressReport> {
  const apply = opts.apply === true;
  const items: ReportItem[] = [];
  const add = (item: ReportItem) => {
    items.push(item);
    opts.log?.(item);
  };
  const parsed = progressFileSchema.safeParse(input);
  if (!parsed.success) {
    add({ code: "-", what: "file", outcome: "error", detail: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
    return finish(apply, items);
  }
  const file = parsed.data;
  const actor = opts.actor ?? IMPORT_ACTOR;
  const ctxFor = (opId: string, externalRef?: string): Promise<Ctx> =>
    makeCtxFromSettings(repo, { opId, actor, source: "EMAIL", ...(externalRef ? { externalRef } : {}) });

  const milestones = (await repo.milestones.list()).filter((m) => !m.archived);
  const milestoneByKey = new Map(milestones.map((m) => [m.key, m]));

  for (const spec of file.projects) {
    const code = spec.code.trim().toUpperCase();
    try {
      await importProject(spec, code);
    } catch (e) {
      add({ code, what: "project", outcome: "error", detail: e instanceof Error ? e.message : String(e) });
    }
  }
  return finish(apply, items);

  async function importProject(spec: ProgressProject, code: string): Promise<void> {
    let fields = await listProjectFields(repo);
    const details = await resolveDetails(spec, code, fields);
    fields = await listProjectFields(repo);

    let project = await repo.projects.findByCode(code);
    if (!project) {
      if (!apply) {
        add({ code, what: `create project "${spec.name}"`, outcome: "planned" });
        planSteps(spec, code, virtualSteps());
        planExtras(spec, code);
        return;
      }
      project = await createProject(spec, code, details);
      add({ code, what: `create project "${spec.name}"`, outcome: "done" });
    } else {
      await updateDetails(project, code, fields, details);
    }
    if (project.setup !== "READY") {
      add({ code, what: "milestones", outcome: "error", detail: "The project's copy of the template is not finished. Open it in the app and finish copying, then run the import again." });
      return;
    }
    const steps = await withKnownSteps(repo, project, await repo.steps.listByProject(project.id));
    if (!apply) {
      planSteps(spec, code, steps);
      planExtras(spec, code);
      return;
    }
    await applySteps(spec, code, project, steps);
    await applyExtras(spec, code, project);
  }

  /** Details keyed by field id, with labels turned into choice ids (missing choices are added when applying). */
  async function resolveDetails(spec: ProgressProject, code: string, fields: ProjectField[]): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    for (const [k, raw] of Object.entries(spec.details ?? {})) {
      const f = fields.find((x) => !x.archived && (x.key === k || norm(x.label) === norm(k)));
      if (!f) {
        add({ code, what: `detail "${k}"`, outcome: "error", detail: "No project field with that key or name." });
        continue;
      }
      let choices = f.choices ?? [];
      let r = resolveValue(f.fieldType, choices, raw);
      for (const label of r.unknown) {
        if (!apply) {
          add({ code, what: `add choice "${label}" to ${f.label}`, outcome: "planned" });
          continue;
        }
        const added = await addProjectFieldChoice(await ctxFor(importOpId("choice", f.key, norm(label))), f.id, label.trim());
        choices = added.field.choices ?? [];
        add({ code, what: `add choice "${label}" to ${f.label}`, outcome: "done" });
      }
      if (r.unknown.length && apply) r = resolveValue(f.fieldType, choices, raw);
      if (r.unknown.length) continue; // dry run: the value is planned with the new choice
      const checked = normalizeValue({ fieldType: f.fieldType, choices, config: f.config ?? {} }, r.value);
      if (!checked.ok) {
        add({ code, what: `detail ${f.label}`, outcome: "error", detail: checked.error });
        continue;
      }
      out[f.id] = checked.value;
    }
    return out;
  }

  async function createProject(spec: ProgressProject, code: string, details: Record<string, unknown>): Promise<Project> {
    const opId = importOpId("create", code);
    const ctx = await ctxFor(opId);
    const { projectId } = await startCreateProject(ctx, { code, name: spec.name, status: spec.status ?? "ACTIVE", details });
    for (let i = 0; i < 200; i++) {
      const r = await continueCreateProject(await ctxFor(opId), opId);
      if (r.done) {
        const p = await repo.projects.get(projectId);
        if (!p) throw new Error(`${code} was created but cannot be read back.`);
        return p;
      }
    }
    throw new Error(`Copying the milestones into ${code} did not finish. Run the import again to continue.`);
  }

  /** Fills only details that are empty in the app; a different value already there is left as is. */
  async function updateDetails(project: Project, code: string, fields: ProjectField[], details: Record<string, unknown>): Promise<void> {
    const patch: Record<string, unknown> = {};
    for (const [fid, value] of Object.entries(details)) {
      const f = fields.find((x) => x.id === fid);
      const current = project.details?.[fid] ?? null;
      if (stableStringify(current) === stableStringify(value ?? null)) continue;
      if (f && !isEmptyValue(f.fieldType, current)) {
        add({ code, what: `detail ${f.label}`, outcome: "skipped", detail: `Already "${f ? display({ fieldType: f.fieldType, choices: f.choices ?? [], config: f.config ?? {} }, current) : String(current)}" in the app; left as is.` });
        continue;
      }
      patch[fid] = value;
    }
    if (Object.keys(patch).length === 0) return;
    const names = Object.keys(patch).map((fid) => fields.find((x) => x.id === fid)?.label ?? fid).join(", ");
    if (!apply) {
      add({ code, what: `fill details: ${names}`, outcome: "planned" });
      return;
    }
    await updateProject(await ctxFor(importOpId("details", code, patch)), project.id, { details: patch });
    add({ code, what: `fill details: ${names}`, outcome: "done" });
  }

  function virtualSteps(): StepLike[] {
    return milestones.map((m) => ({
      id: `new:${m.key}`,
      name: m.name,
      milestoneKey: m.key,
      fieldType: m.fieldType,
      choices: m.choices ?? [],
      config: m.config ?? {},
      value: null,
      notApplicable: false,
      flag: null,
      rev: 0,
    }));
  }

  /** Checks one step spec against a step; returns the resolved value (or an error / skip reason). */
  function check(code: string, key: string, s: ProgressStep, step: StepLike | undefined) {
    if (!step) {
      const known = milestoneByKey.has(key);
      return { error: known ? "This project has no step for that milestone (removed from its flow?)." : "No milestone with that key in the Library." };
    }
    if (s.value === undefined) return { step };
    const r = resolveValue(step.fieldType, step.choices ?? [], s.value);
    if (r.unknown.length) {
      const allowed = (step.choices ?? []).filter((c) => !c.archived).map((c) => c.label).join(", ");
      return { step, error: `Unknown choice "${r.unknown.join('", "')}". Allowed: ${allowed}.` };
    }
    if (step.fieldType === "FILE") return { step, error: "A File milestone has no value: give a link or a note instead." };
    const ok = normalizeValue(defOf(step), r.value);
    if (!ok.ok) return { step, error: ok.error };
    return { step, value: ok.value };
  }

  function planSteps(spec: ProgressProject, code: string, steps: StepLike[]): void {
    const byKey = new Map(steps.filter((s) => s.milestoneKey).map((s) => [s.milestoneKey!, s]));
    for (const [key, s] of Object.entries(spec.steps ?? {})) {
      const c = check(code, key, s, byKey.get(key));
      const name = c.step?.name ?? key;
      if (c.error) {
        add({ code, what: name, outcome: "error", detail: c.error });
        continue;
      }
      const step = c.step!;
      const writable = importMayWrite(step as StoredStep);
      if (s.na) {
        if (step.notApplicable) add({ code, what: `${name}: not applicable`, outcome: "unchanged" });
        else add({ code, what: `${name}: not applicable`, outcome: writable ? "planned" : "skipped", detail: writable ? undefined : "Changed in the app; left as is." });
      } else if (c.value !== undefined) {
        const same = stableStringify(step.value ?? null) === stableStringify(c.value);
        if (same) add({ code, what: `${name} = ${display(step, c.value)}`, outcome: "unchanged" });
        else add({ code, what: `${name}: ${display(step, step.value)} → ${display(step, c.value)}`, outcome: writable ? "planned" : "skipped", detail: writable ? undefined : "Changed in the app; left as is." });
      }
      if (s.flag && !s.na) {
        if (step.flag === s.flag) add({ code, what: `${name}: flag ${s.flag}`, outcome: "unchanged" });
        else add({ code, what: `${name}: flag ${s.flag}${s.flagReason ? ` (${s.flagReason})` : ""}`, outcome: "planned" });
      }
      if (s.note) add({ code, what: `${name}: note "${snippet(s.note)}"`, outcome: "planned" });
      for (const l of s.links ?? []) add({ code, what: `${name}: link ${l.name ?? l.url}`, outcome: "planned" });
    }
  }

  function planExtras(spec: ProgressProject, code: string): void {
    for (const body of spec.notes ?? []) add({ code, what: `project note "${snippet(body)}"`, outcome: "planned" });
    for (const l of spec.links ?? []) add({ code, what: `project link ${l.name ?? l.url}`, outcome: "planned" });
  }

  async function applySteps(spec: ProgressProject, code: string, project: Project, steps: StoredStep[]): Promise<void> {
    const byKey = new Map(steps.filter((s) => s.milestoneKey && !s.archived).map((s) => [s.milestoneKey!, s]));
    const notes = await repo.notes.listByProject(project.id);
    const atts = await repo.attachments.listByProject(project.id);
    for (const [key, s] of Object.entries(spec.steps ?? {})) {
      const listed = byKey.get(key);
      const step = listed ? ((await repo.steps.get(listed.id)) ?? listed) : undefined;
      const c = check(code, key, s, step);
      const name = c.step?.name ?? key;
      if (c.error || !step) {
        add({ code, what: name, outcome: "error", detail: c.error });
        continue;
      }
      try {
        await applyStep(code, project, step, s, c.value, notes, atts);
      } catch (e) {
        add({ code, what: name, outcome: "error", detail: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  async function applyStep(
    code: string,
    project: Project,
    first: StoredStep,
    s: ProgressStep,
    value: Value | null | undefined,
    notes: { stepId?: string; body: string; archived?: boolean }[],
    atts: { stepId?: string; url?: string; kind: string; archived?: boolean }[],
  ): Promise<void> {
    const name = first.name;
    const fresh = async () => (await repo.steps.get(first.id)) ?? first;
    let step = first;
    if (s.na) {
      if (step.notApplicable) add({ code, what: `${name}: not applicable`, outcome: "unchanged" });
      else if (!importMayWrite(step)) add({ code, what: `${name}: not applicable`, outcome: "skipped", detail: "Changed in the app; left as is." });
      else {
        await setStepNotApplicable(await ctxFor(importOpId("na", code, step.milestoneKey), s.externalRef), { stepId: step.id, notApplicable: true, expectedRev: step.rev });
        add({ code, what: `${name}: not applicable`, outcome: "done" });
      }
    } else if (value !== undefined) {
      if (stableStringify(step.value ?? null) === stableStringify(value)) add({ code, what: `${name} = ${display(step, value)}`, outcome: "unchanged" });
      else if (!importMayWrite(step)) add({ code, what: `${name} → ${display(step, value)}`, outcome: "skipped", detail: `Changed in the app to "${display(step, step.value)}"; left as is.` });
      else {
        const before = step.value;
        await setStepValue(await ctxFor(importOpId("value", code, step.milestoneKey, value), s.externalRef), { stepId: step.id, value, expectedRev: step.rev });
        add({ code, what: `${name}: ${display(step, before)} → ${display(step, value)}`, outcome: "done" });
      }
    }
    if (s.flag && !s.na) {
      step = await fresh();
      if (step.flag === s.flag) add({ code, what: `${name}: flag ${s.flag}`, outcome: "unchanged" });
      else if (step.flag && !step.lastOp?.startsWith(IMPORT_OP_PREFIX)) add({ code, what: `${name}: flag ${s.flag}`, outcome: "skipped", detail: `Flagged ${step.flag} in the app; left as is.` });
      else {
        await setStepFlag(await ctxFor(importOpId("flag", code, step.milestoneKey, s.flag, s.flagReason ?? ""), s.externalRef), {
          stepId: step.id,
          flag: s.flag as NodeFlag,
          reason: s.flagReason,
          expectedRev: step.rev,
        });
        add({ code, what: `${name}: flag ${s.flag}`, outcome: "done" });
      }
    }
    if (s.note) {
      const body = s.note.trim();
      if (notes.some((n) => !n.archived && n.stepId === first.id && n.body.trim() === body)) add({ code, what: `${name}: note`, outcome: "unchanged" });
      else {
        await addNote(await ctxFor(importOpId("note", code, first.milestoneKey, body), s.externalRef), { projectId: project.id, stepId: first.id, body });
        add({ code, what: `${name}: note "${snippet(body)}"`, outcome: "done" });
      }
    }
    for (const l of s.links ?? []) {
      if (atts.some((a) => !a.archived && a.kind === "LINK" && a.stepId === first.id && a.url === l.url.trim())) {
        add({ code, what: `${name}: link ${l.name ?? l.url}`, outcome: "unchanged" });
        continue;
      }
      await addLink(await ctxFor(importOpId("link", code, first.milestoneKey, l.url.trim()), s.externalRef), {
        projectId: project.id,
        stepId: first.id,
        url: l.url.trim(),
        ...(l.name ? { name: l.name } : {}),
      });
      add({ code, what: `${name}: link ${l.name ?? l.url}`, outcome: "done" });
    }
  }

  async function applyExtras(spec: ProgressProject, code: string, project: Project): Promise<void> {
    const notes = await repo.notes.listByProject(project.id);
    for (const raw of spec.notes ?? []) {
      const body = raw.trim();
      if (notes.some((n) => !n.archived && !n.stepId && n.body.trim() === body)) {
        add({ code, what: "project note", outcome: "unchanged" });
        continue;
      }
      await addNote(await ctxFor(importOpId("note", code, null, body)), { projectId: project.id, body });
      add({ code, what: `project note "${snippet(body)}"`, outcome: "done" });
    }
    const atts = await repo.attachments.listByProject(project.id);
    for (const l of spec.links ?? []) {
      if (atts.some((a) => !a.archived && a.kind === "LINK" && !a.stepId && a.url === l.url.trim())) {
        add({ code, what: `project link ${l.name ?? l.url}`, outcome: "unchanged" });
        continue;
      }
      await addLink(await ctxFor(importOpId("link", code, null, l.url.trim())), { projectId: project.id, url: l.url.trim(), ...(l.name ? { name: l.name } : {}) });
      add({ code, what: `project link ${l.name ?? l.url}`, outcome: "done" });
    }
  }
}

function snippet(s: string): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > 60 ? `${one.slice(0, 57)}…` : one;
}

function finish(applied: boolean, items: ReportItem[]): ProgressReport {
  const counts: Record<ItemOutcome, number> = { done: 0, unchanged: 0, skipped: 0, error: 0, planned: 0 };
  for (const i of items) counts[i.outcome]++;
  return { applied, items, counts };
}

