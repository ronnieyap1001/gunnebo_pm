/**
 * Browser-side derivation for the project page: the same pure domain functions the server's read model uses
 * (deriveState, formatValue, flowOrder, currentNodeIds, computeProgress), so optimistic updates look exactly like the
 * reloaded page will.
 */
import { FIELD_TYPE_META } from "@/domain/fieldTypes";
import { formatValue } from "@/domain/format";
import { computeProgress, currentNodeIds, flowOrder, isActiveEdge, predecessorsOf, successorsOf } from "@/domain/graph";
import { deriveState, describeReason, STATE_META } from "@/domain/state";
import type { State } from "@/domain/types";
import type { NoteDTO, ProjectPageData } from "@/server/queries";
import type { ProjectView, RawProject, RawStep, StepView } from "./types";

export function toRaw(d: ProjectPageData, readAt: string): RawProject {
  const steps: Record<string, RawStep> = {};
  for (const s of d.steps) {
    steps[s.id] = {
      id: s.id,
      milestoneId: s.milestoneId,
      milestoneKey: s.milestoneKey,
      name: s.name,
      description: s.description,
      fieldType: s.fieldType,
      choices: s.choices,
      config: s.config,
      value: s.value,
      notApplicable: s.notApplicable,
      flag: s.flag,
      order: s.order,
      rev: s.rev,
      valueSetAt: s.valueSetAt,
      stateChangedAt: s.stateChangedAt,
      lastChangedAt: s.lastChangedAt,
      projectOnly: s.projectOnly,
      notInTemplate: s.notInTemplate,
      typeDiffers: s.typeDiffers,
    };
  }
  return {
    project: d.project,
    details: d.details,
    detailFields: d.detailFields,
    steps,
    positions: d.flow.nodes,
    edges: d.flow.edges,
    notes: d.notes,
    attachments: d.attachments,
    archivedSteps: d.archivedSteps,
    sync: d.sync,
    suggestClose: d.suggestClose,
    version: d.version,
    today: d.today,
    readAt,
  };
}

export function derive(raw: RawProject, timeZone: string): ProjectView {
  const day = { today: raw.today, timeZone };
  const list = Object.values(raw.steps);
  const ids = new Set(list.map((s) => s.id));
  const edges = raw.edges.filter((e) => isActiveEdge(e) && ids.has(e.from) && ids.has(e.to));
  const order = flowOrder(
    list.map((s) => ({ id: s.id, order: s.order, name: s.name })),
    edges,
  );

  const attachmentCount: Record<string, number> = {};
  for (const a of raw.attachments) if (!a.archived && a.stepId) attachmentCount[a.stepId] = (attachmentCount[a.stepId] ?? 0) + 1;
  const notesByStep = new Map<string, NoteDTO[]>();
  for (const n of raw.notes) {
    if (n.archived || !n.stepId) continue;
    const arr = notesByStep.get(n.stepId) ?? [];
    arr.push(n);
    notesByStep.set(n.stepId, arr);
  }
  for (const arr of notesByStep.values()) arr.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));

  const states: Record<string, State> = {};
  const derived = new Map<string, ReturnType<typeof deriveState>>();
  for (const s of list) {
    const d = deriveState(
      { fieldType: s.fieldType, choices: s.choices ?? [], config: s.config ?? {} },
      {
        value: s.value ?? null,
        notApplicable: s.notApplicable,
        flag: s.flag,
        valueSetAt: s.valueSetAt ?? undefined,
        attachmentCount: attachmentCount[s.id] ?? 0,
      },
      day,
    );
    derived.set(s.id, d);
    states[s.id] = d.state;
  }
  const currentIds = currentNodeIds(order, states, edges);
  const currentSet = new Set(currentIds);

  const steps: StepView[] = order.map((id, i) => {
    const s = raw.steps[id];
    const d = derived.get(id)!;
    const count = attachmentCount[id] ?? 0;
    const def = { fieldType: s.fieldType, choices: s.choices ?? [], config: s.config ?? {} };
    const sn = notesByStep.get(id) ?? [];
    return {
      ...s,
      state: d.state,
      stateCode: STATE_META[d.state].code,
      stateLabel: STATE_META[d.state].label,
      reason: d.reason,
      reasonText: describeReason(d.reason),
      fieldTypeLabel: FIELD_TYPE_META[s.fieldType]?.label ?? s.fieldType,
      seq: i + 1,
      display: formatValue(def, s.value ?? null, { attachmentCount: count, today: raw.today }),
      shortDisplay: formatValue(def, s.value ?? null, { attachmentCount: count, today: raw.today, short: true }),
      isCurrent: currentSet.has(id),
      noteCount: sn.length,
      latestNote: sn[0] ?? null,
      attachmentCount: count,
      predecessors: predecessorsOf(edges, id),
      successors: successorsOf(edges, id),
    };
  });

  return {
    steps,
    byId: new Map(steps.map((s) => [s.id, s])),
    progress: computeProgress(order.map((id) => states[id])),
    currentIds,
  };
}

/** Active arrows between active steps (what the canvas draws). */
export function activeEdgesOf(raw: RawProject) {
  return raw.edges.filter((e) => isActiveEdge(e) && raw.steps[e.from] && raw.steps[e.to]);
}
