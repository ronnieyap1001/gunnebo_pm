import "server-only";
/**
 * Read models for the Milestone Library and the Template Flow.
 */
import { FIELD_TYPE_META } from "@/domain/fieldTypes";
import { isActiveEdge, predecessorsOf, successorsOf } from "@/domain/graph";
import { stableStringify } from "@/domain/syncPlan";
import type {
  Choice,
  FieldConfig,
  FieldType,
  FlowEdge,
  Milestone,
  Position,
  Project,
  ProjectField,
  SystemFieldKey,
  Template,
} from "@/domain/types";
import { isEmptyValue } from "@/domain/values";
import type { Repo } from "@/server/repo/types";
import { templateFlowOrder } from "@/server/services/library";
import { projectFieldsOf, templateOf, type ReadDeps } from "./common";

export interface MilestoneRow {
  id: string;
  key: string;
  name: string;
  description: string;
  fieldType: FieldType;
  fieldTypeLabel: string;
  choices: Choice[];
  config: FieldConfig;
  order: number;
  /** 1-based template flow-order number ("#"); null for archived milestones. */
  seq: number | null;
  archived: boolean;
  archivedAt: string | null;
  archiveBatch: string | null;
  /** Non-archived projects that have a step copied from this milestone. */
  usedIn: number;
  /** Other active milestones with an identical active choice list ("Also apply to …"). */
  sameChoicesAs: string[];
  /** Template arrows (active milestones only). */
  predecessors: string[];
  successors: string[];
}

export interface ProjectFieldRow {
  id: string;
  key: string;
  label: string;
  fieldType: FieldType;
  fieldTypeLabel: string;
  choices: Choice[];
  config: FieldConfig;
  order: number;
  showInSummary: boolean;
  systemKey: SystemFieldKey | null;
  archived: boolean;
  archivedAt: string | null;
  /** Projects (archived included) with a non-empty value. */
  usedIn: number;
}

export interface LibraryView {
  /** Active milestones in template flow order. */
  milestones: MilestoneRow[];
  archived: MilestoneRow[];
  /** All project fields in order (archived ones flagged). */
  projectFields: ProjectFieldRow[];
  revision: number;
}

function activeChoiceSignature(choices: Choice[]): string {
  return stableStringify((choices ?? []).filter((c) => !c.archived).map((c) => ({ l: c.label, s: c.state ?? null })));
}

export function buildMilestoneRows(template: Template, projects: Project[]): { active: MilestoneRow[]; archived: MilestoneRow[] } {
  const order = templateFlowOrder(template);
  const seqOf = new Map(order.map((id, i) => [id, i + 1]));
  const activeIds = new Set(order);
  const edges = template.flow.edges.filter((e) => isActiveEdge(e) && activeIds.has(e.from) && activeIds.has(e.to));

  const usage = new Map<string, number>();
  for (const p of projects) {
    if (p.archived) continue;
    const seen = new Set<string>();
    for (const c of Object.values(p.cells ?? {})) if (c.m && !seen.has(c.m)) seen.add(c.m);
    for (const m of seen) usage.set(m, (usage.get(m) ?? 0) + 1);
  }

  const signatures = new Map<string, string[]>();
  for (const m of template.milestones) {
    if (m.archived || !FIELD_TYPE_META[m.fieldType]?.hasChoices || !(m.choices ?? []).some((c) => !c.archived)) continue;
    const sig = `${m.fieldType}|${activeChoiceSignature(m.choices)}`;
    signatures.set(sig, [...(signatures.get(sig) ?? []), m.id]);
  }
  const sigOf = (m: Milestone) => `${m.fieldType}|${activeChoiceSignature(m.choices)}`;

  const row = (m: Milestone): MilestoneRow => ({
    id: m.id,
    key: m.key,
    name: m.name,
    description: m.description ?? "",
    fieldType: m.fieldType,
    fieldTypeLabel: FIELD_TYPE_META[m.fieldType]?.label ?? m.fieldType,
    choices: m.choices ?? [],
    config: m.config ?? {},
    order: m.order,
    seq: seqOf.get(m.id) ?? null,
    archived: m.archived,
    archivedAt: m.archivedAt ?? null,
    archiveBatch: m.archiveBatch ?? null,
    usedIn: usage.get(m.id) ?? 0,
    sameChoicesAs: m.archived ? [] : (signatures.get(sigOf(m)) ?? []).filter((id) => id !== m.id),
    predecessors: m.archived ? [] : predecessorsOf(edges, m.id),
    successors: m.archived ? [] : successorsOf(edges, m.id),
  });

  const byId = new Map(template.milestones.map((m) => [m.id, m]));
  const active = order.map((id) => row(byId.get(id)!));
  const archived = template.milestones
    .filter((m) => m.archived)
    .sort((a, b) => ((a.archivedAt ?? "") < (b.archivedAt ?? "") ? 1 : -1))
    .map(row);
  return { active, archived };
}

export function buildProjectFieldRows(fields: ProjectField[], projects: Project[]): ProjectFieldRow[] {
  return [...fields]
    .sort((a, b) => a.order - b.order || a.key.localeCompare(b.key))
    .map((f) => ({
      id: f.id,
      key: f.key,
      label: f.label,
      fieldType: f.fieldType,
      fieldTypeLabel: FIELD_TYPE_META[f.fieldType]?.label ?? f.fieldType,
      choices: f.choices ?? [],
      config: f.config ?? {},
      order: f.order,
      showInSummary: f.showInSummary,
      systemKey: f.systemKey ?? null,
      archived: f.archived,
      archivedAt: f.archivedAt ?? null,
      usedIn: projects.filter((p) => {
        const v = p.details?.[f.id] ?? null;
        return v !== null && !isEmptyValue(f.fieldType, v);
      }).length,
    }));
}

/** Library screen: milestones (flow order, with usage), archived milestones, project fields. */
export async function getLibraryView(repo: Repo, deps?: ReadDeps): Promise<LibraryView> {
  const [template, fields, projects] = await Promise.all([
    templateOf(repo, deps),
    projectFieldsOf(repo, deps),
    repo.projects.list({ includeArchived: true }),
  ]);
  const { active, archived } = buildMilestoneRows(template, projects);
  return { milestones: active, archived, projectFields: buildProjectFieldRows(fields, projects), revision: template.revision };
}

export interface TemplateView {
  /** Active milestones in flow order. */
  milestones: MilestoneRow[];
  /** Positions of active milestones and the active arrows between them. */
  flow: { nodes: Record<string, Position>; edges: FlowEdge[] };
  revision: number;
  /** Active milestones without any arrow (the info strip lists them). */
  unconnected: string[];
  archivedCount: number;
  /** Non-archived projects (the editor says "used in N projects"). */
  projectCount: number;
}

/** Template Flow screen. */
export async function getTemplateView(repo: Repo, deps?: ReadDeps): Promise<TemplateView> {
  const [template, projects] = await Promise.all([templateOf(repo, deps), repo.projects.list()]);
  const { active, archived } = buildMilestoneRows(template, projects);
  const ids = new Set(active.map((m) => m.id));
  const edges = template.flow.edges.filter((e) => isActiveEdge(e) && ids.has(e.from) && ids.has(e.to));
  const nodes: Record<string, Position> = {};
  for (const id of ids) if (template.flow.nodes[id]) nodes[id] = template.flow.nodes[id];
  const connected = new Set(edges.flatMap((e) => [e.from, e.to]));
  return {
    milestones: active,
    flow: { nodes, edges },
    revision: template.revision,
    unconnected: active.filter((m) => !connected.has(m.id)).map((m) => m.id),
    archivedCount: archived.length,
    projectCount: projects.filter((p) => !p.archived).length,
  };
}
