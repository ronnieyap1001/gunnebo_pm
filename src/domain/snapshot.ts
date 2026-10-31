/**
 * Template -> project copy (DESIGN.md 4.6, amended in section 12: ALL choices are copied, archived ones with
 * their flag, so a fresh project never shows spurious sync items).
 */
import { NODE_HEIGHT, NODE_WIDTH } from "./layout";
import type { Choice, Flow, FlowEdge, Iso, Milestone, Position, Step, Template } from "./types";

/** A step not yet stored. `tempId` is the milestone id; the caller maps it to the new step id with remapFlow. */
export interface StepDraft extends Omit<Step, "id" | "projectId" | "createdAt" | "updatedAt"> {
  tempId: string;
}

/** The project edge id used for an edge copied from a template edge. */
export function projectEdgeIdForTemplateEdge(templateEdgeId: string): string {
  return `te:${templateEdgeId}`;
}

export function copyChoices(choices: Choice[]): Choice[] {
  return choices.map((c) => {
    const copy: Choice = { id: c.id, label: c.label };
    if (c.state !== undefined) copy.state = c.state;
    if (c.archived) copy.archived = true;
    return copy;
  });
}

/** A fresh, empty step draft copied from a milestone. */
export function draftFromMilestone(m: Milestone): StepDraft {
  return {
    tempId: m.id,
    milestoneId: m.id,
    milestoneKey: m.key,
    name: m.name,
    description: m.description ?? "",
    fieldType: m.fieldType,
    choices: copyChoices(m.choices ?? []),
    config: { ...(m.config ?? {}) },
    value: null,
    notApplicable: false,
    flag: null,
    order: m.order,
    rev: 0,
    archived: false,
  };
}

/** Default positions for nodes without one: a row below everything that has a position, in the given order. */
export function defaultPositions(ids: string[], existing: Position[]): Record<string, Position> {
  const top = existing.length ? Math.max(...existing.map((p) => p.y)) + NODE_HEIGHT + 80 : 0;
  const out: Record<string, Position> = {};
  ids.forEach((id, i) => {
    out[id] = { x: i * (NODE_WIDTH + 40), y: top };
  });
  return out;
}

/**
 * One draft step per active milestone (value empty, not N/A, no flag, rev 0) and the template's active arrows
 * between active milestones. Flow node keys and edge ends are the drafts' tempIds (= milestone ids); each edge
 * gets id 'te:<templateEdgeId>' and templateEdgeId set.
 */
export function buildProjectSnapshot(template: Template, now: Iso): { steps: StepDraft[]; flow: Flow } {
  const active = template.milestones.filter((m) => !m.archived).sort((a, b) => a.order - b.order);
  const activeIds = new Set(active.map((m) => m.id));
  const steps = active.map(draftFromMilestone);

  const nodes: Record<string, Position> = {};
  const missing: string[] = [];
  for (const m of active) {
    const p = template.flow.nodes[m.id];
    if (p) nodes[m.id] = { x: p.x, y: p.y };
    else missing.push(m.id);
  }
  Object.assign(nodes, defaultPositions(missing, Object.values(nodes)));

  const edges: FlowEdge[] = [];
  const seen = new Set<string>();
  for (const e of template.flow.edges) {
    if (e.archivedAt || !activeIds.has(e.from) || !activeIds.has(e.to) || e.from === e.to) continue;
    const pair = `${e.from}\u0000${e.to}`;
    if (seen.has(pair)) continue;
    seen.add(pair);
    edges.push({ id: projectEdgeIdForTemplateEdge(e.id), from: e.from, to: e.to, createdAt: now, templateEdgeId: e.id });
  }
  return { steps, flow: { nodes, edges } };
}

/** Rewrite node keys and edge ends through `idMap`; ids not in the map are kept. */
export function remapFlow(flow: Flow, idMap: Record<string, string>): Flow {
  const map = (id: string) => (Object.prototype.hasOwnProperty.call(idMap, id) ? idMap[id] : id);
  const nodes: Record<string, Position> = {};
  for (const [id, p] of Object.entries(flow.nodes)) nodes[map(id)] = p;
  const edges = flow.edges.map((e) => ({ ...e, from: map(e.from), to: map(e.to) }));
  return { nodes, edges };
}
