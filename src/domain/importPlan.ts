/**
 * Template import, "replace the template" mode (DESIGN.md 4.9, amended in section 12). Pure: turns the current
 * library + a validated template file into a list of changes for the service layer to write (after a backup).
 *
 * - Milestones are upserted by key (existing ids are kept, so projects stay linked); choices merge by id and choices
 *   missing from the file are archived, never removed; milestones not in the file are archived (restorable).
 * - Template arrows are replaced: the same pair reuses (or restores) its existing edge id, other active arrows are
 *   archived with reason IMPORT.
 * - Positions come from the file, or from the wrapped auto-layout when the file has none.
 * - Project fields are upserted by key with choices merged by id; missing ones are never archived and the field type
 *   of an existing field is never changed (reported instead).
 *
 * Patches use a present key with value `undefined` to mean "clear this field" (archivedAt, archiveBatch).
 */
import { FIELD_TYPE_META } from "./fieldTypes";
import { findActivePair, findArchivedPair, isActiveEdge } from "./graph";
import { autoLayout } from "./layout";
import { copyChoices, defaultPositions } from "./snapshot";
import { choicesEqual, describeChoiceChanges, mergeChoicesById, stableStringify } from "./syncPlan";
import type { TemplateFile } from "./templateFile";
import type { FieldConfig, Flow, FlowEdge, Iso, Milestone, Position, ProjectField, Template } from "./types";

export interface ImportPlan {
  summary: {
    added: string[];
    updated: string[];
    archived: string[];
    choiceChanges: string[];
    edgesAdded: number;
    edgesRemoved: number;
    projectFieldsAdded: string[];
    projectFieldsUpdated: string[];
  };
  /** tempId = 'key:' + key; the flow uses the tempId until the caller remaps it to the new milestone id. */
  milestoneCreates: { tempId: string; data: Omit<Milestone, "id" | "createdAt" | "updatedAt"> }[];
  milestoneUpdates: { id: string; patch: Partial<Milestone> }[];
  /** Ids to archive (never delete). */
  milestoneArchives: string[];
  /** The full new template flow. Node keys are existing milestone ids or tempIds of creates. */
  flow: Flow;
  projectFieldCreates: Omit<ProjectField, "id">[];
  projectFieldUpdates: { id: string; patch: Partial<ProjectField> }[];
}

/** The tempId of a milestone created by an import. */
export function importTempId(key: string): string {
  return `key:${key}`;
}

const configOf = (c: FieldConfig | undefined): FieldConfig => ({ ...(c ?? {}) });
const sameConfig = (a: FieldConfig | undefined, b: FieldConfig | undefined) =>
  stableStringify(a ?? {}) === stableStringify(b ?? {});
const typeLabel = (t: keyof typeof FIELD_TYPE_META) => FIELD_TYPE_META[t]?.label ?? t;

/** One record per key: an active milestone wins over an archived one with the same key. */
function indexByKey<T extends { key: string; archived: boolean }>(rows: T[]): Map<string, T> {
  const out = new Map<string, T>();
  for (const r of rows) {
    const prev = out.get(r.key);
    if (!prev || (prev.archived && !r.archived)) out.set(r.key, r);
  }
  return out;
}

export function planTemplateImport(
  current: { template: Template; projectFields: ProjectField[] },
  file: TemplateFile,
  now: Iso,
  idFactory: () => string,
): ImportPlan {
  const summary: ImportPlan["summary"] = {
    added: [],
    updated: [],
    archived: [],
    choiceChanges: [],
    edgesAdded: 0,
    edgesRemoved: 0,
    projectFieldsAdded: [],
    projectFieldsUpdated: [],
  };
  const milestoneCreates: ImportPlan["milestoneCreates"] = [];
  const milestoneUpdates: ImportPlan["milestoneUpdates"] = [];
  const milestoneArchives: string[] = [];

  // --- Milestones ----------------------------------------------------------
  const tpl = current.template;
  const byKey = indexByKey(tpl.milestones);
  const nodeIdOfKey = new Map<string, string>();
  const fileKeys = new Set(file.milestones.map((fm) => fm.key));

  for (const fm of file.milestones) {
    if (nodeIdOfKey.has(fm.key)) continue; // duplicate key (rejected by parseTemplateFile)
    const description = fm.description ?? "";
    const config = configOf(fm.config);
    const m = byKey.get(fm.key);
    if (!m) {
      const tempId = importTempId(fm.key);
      nodeIdOfKey.set(fm.key, tempId);
      milestoneCreates.push({
        tempId,
        data: {
          key: fm.key,
          name: fm.name,
          description,
          fieldType: fm.fieldType,
          choices: copyChoices(fm.choices ?? []),
          config,
          order: fm.order,
          archived: false,
        },
      });
      summary.added.push(fm.name);
      continue;
    }
    nodeIdOfKey.set(fm.key, m.id);
    const patch: Partial<Milestone> = {};
    if (m.name !== fm.name) patch.name = fm.name;
    if ((m.description ?? "") !== description) patch.description = description;
    if (m.fieldType !== fm.fieldType) patch.fieldType = fm.fieldType;
    if (!sameConfig(m.config, config)) patch.config = config;
    if (m.order !== fm.order) patch.order = fm.order;
    const merged = mergeChoicesById(fm.choices ?? [], m.choices ?? []);
    if (!choicesEqual(merged, m.choices ?? [])) {
      patch.choices = merged;
      summary.choiceChanges.push(`${fm.name}: ${describeChoiceChanges(m.choices ?? [], merged)}`);
    }
    if (m.archived) {
      patch.archived = false;
      patch.archivedAt = undefined;
      patch.archiveBatch = undefined;
    }
    if (Object.keys(patch).length) {
      milestoneUpdates.push({ id: m.id, patch });
      summary.updated.push(m.archived ? `${fm.name} (restored)` : fm.name);
    }
  }
  for (const m of tpl.milestones) {
    if (m.archived) continue;
    if (fileKeys.has(m.key) && byKey.get(m.key) === m) continue;
    milestoneArchives.push(m.id);
    summary.archived.push(m.name);
  }

  // --- Arrows --------------------------------------------------------------
  let edges: FlowEdge[] = [...tpl.flow.edges];
  const keep = new Set<string>();
  for (const fe of file.edges) {
    const from = nodeIdOfKey.get(fe.from);
    const to = nodeIdOfKey.get(fe.to);
    if (!from || !to || from === to) continue; // rejected by parseTemplateFile
    const active = findActivePair(edges, from, to);
    if (active) {
      keep.add(active.id);
      continue;
    }
    const archived = findArchivedPair(edges, from, to);
    if (archived) {
      const restored: FlowEdge = { ...archived };
      delete restored.archivedAt;
      delete restored.archivedReason;
      delete restored.batchId;
      delete restored.createdByBatchId;
      edges = edges.map((e) => (e === archived ? restored : e));
      keep.add(restored.id);
    } else {
      const edge: FlowEdge = { id: idFactory(), from, to, createdAt: now };
      edges.push(edge);
      keep.add(edge.id);
    }
    summary.edgesAdded++;
  }
  edges = edges.map((e) => {
    if (!isActiveEdge(e) || keep.has(e.id)) return e;
    summary.edgesRemoved++;
    return { ...e, archivedAt: now, archivedReason: "IMPORT" as const };
  });

  // --- Positions -----------------------------------------------------------
  const fileNodeIds = file.milestones.map((fm) => nodeIdOfKey.get(fm.key)!);
  const nodes: Record<string, Position> = {};
  // Keep the positions of milestones that stay archived, so a restore puts them back where they were.
  for (const [id, p] of Object.entries(tpl.flow.nodes)) nodes[id] = { x: p.x, y: p.y };
  const withPosition = file.milestones.filter((fm) => fm.position);
  if (withPosition.length === 0) {
    Object.assign(nodes, autoLayout(fileNodeIds, edges.filter(isActiveEdge), { wrap: true }));
  } else {
    const missing: string[] = [];
    for (const fm of file.milestones) {
      const id = nodeIdOfKey.get(fm.key)!;
      if (fm.position) nodes[id] = { x: fm.position.x, y: fm.position.y };
      else if (!tpl.flow.nodes[id]) missing.push(id);
    }
    const placed = fileNodeIds.filter((id) => !missing.includes(id)).map((id) => nodes[id]).filter(Boolean);
    Object.assign(nodes, defaultPositions(missing, placed));
  }

  // --- Project fields ------------------------------------------------------
  const projectFieldCreates: ImportPlan["projectFieldCreates"] = [];
  const projectFieldUpdates: ImportPlan["projectFieldUpdates"] = [];
  const fieldsByKey = indexByKey(current.projectFields);
  const seenFieldKeys = new Set<string>();
  for (const fpf of file.projectFields ?? []) {
    if (seenFieldKeys.has(fpf.key)) continue;
    seenFieldKeys.add(fpf.key);
    const f = fieldsByKey.get(fpf.key);
    if (!f) {
      const data: Omit<ProjectField, "id"> = {
        key: fpf.key,
        label: fpf.label,
        fieldType: fpf.fieldType,
        choices: copyChoices(fpf.choices ?? []),
        config: configOf(fpf.config),
        order: fpf.order,
        showInSummary: fpf.showInSummary,
        archived: false,
      };
      if (fpf.systemKey) data.systemKey = fpf.systemKey;
      projectFieldCreates.push(data);
      summary.projectFieldsAdded.push(fpf.label);
      continue;
    }
    const patch: Partial<ProjectField> = {};
    if (f.label !== fpf.label) patch.label = fpf.label;
    if (!sameConfig(f.config, fpf.config)) patch.config = configOf(fpf.config);
    if (f.order !== fpf.order) patch.order = fpf.order;
    if (f.showInSummary !== fpf.showInSummary) patch.showInSummary = fpf.showInSummary;
    if (fpf.systemKey && f.systemKey !== fpf.systemKey) patch.systemKey = fpf.systemKey;
    const merged = mergeChoicesById(fpf.choices ?? [], f.choices ?? []);
    if (!choicesEqual(merged, f.choices ?? [])) patch.choices = merged;
    if (f.archived) {
      patch.archived = false;
      patch.archivedAt = undefined;
    }
    const notes: string[] = [];
    if (f.fieldType !== fpf.fieldType) {
      notes.push(`field type kept as ${typeLabel(f.fieldType)}; the file has ${typeLabel(fpf.fieldType)}`);
    }
    if (Object.keys(patch).length) projectFieldUpdates.push({ id: f.id, patch });
    if (Object.keys(patch).length || notes.length) {
      summary.projectFieldsUpdated.push(notes.length ? `${fpf.label} (${notes.join("; ")})` : fpf.label);
    }
  }

  return {
    summary,
    milestoneCreates,
    milestoneUpdates,
    milestoneArchives,
    flow: { nodes, edges },
    projectFieldCreates,
    projectFieldUpdates,
  };
}
