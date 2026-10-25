import { describe, expect, it } from "vitest";
import { addEdge, archiveEdge, archiveNodeInFlow, insertAfterInFlow, restoreBatchInFlow } from "@/domain/graph";
import { buildProjectSnapshot, remapFlow } from "@/domain/snapshot";
import {
  applySync,
  changeHashOf,
  dismissKeyOf,
  mergeSyncResult,
  planSync,
  type SyncApplyResult,
  type SyncItem,
  type SyncPlan,
  type SyncProjectInput,
} from "@/domain/syncPlan";
import type { Choice, DayContext, FlowEdge, Milestone, Step, Template, Value } from "@/domain/types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = "2026-10-24T02:00:00.000Z";
const LATER = "2026-10-25T02:00:00.000Z";
const ctx: DayContext = { today: "2026-10-25", timeZone: "Asia/Singapore" };

function counter(prefix: string) {
  let n = 0;
  return () => `${prefix}${++n}`;
}

function milestone(id: string, order: number, over: Partial<Milestone> = {}): Milestone {
  return {
    id,
    key: `key-${id}`,
    name: id.toUpperCase(),
    description: "",
    fieldType: "TEXT",
    choices: [],
    config: {},
    order,
    archived: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

const tEdge = (from: string, to: string, extra: Partial<FlowEdge> = {}): FlowEdge => ({
  id: `t-${from}-${to}`,
  from,
  to,
  createdAt: NOW,
  ...extra,
});

/** A template whose milestones form one chain in the given order, laid out on one row. */
function chain(ids: string[], over: Record<string, Partial<Milestone>> = {}): Template {
  const milestones = ids.map((id, i) => milestone(id, i + 1, over[id]));
  return {
    milestones,
    flow: {
      nodes: Object.fromEntries(ids.map((id, i) => [id, { x: i * 224, y: 0 }])),
      edges: ids.slice(1).map((id, i) => tEdge(ids[i], id)),
    },
    revision: 1,
  };
}

const sid = (tempId: string) => `s-${tempId}`;

/** A project created from the template the way the service does it. */
function createProject(t: Template): SyncProjectInput {
  const { steps, flow } = buildProjectSnapshot(t, NOW);
  const map = Object.fromEntries(steps.map((d) => [d.tempId, sid(d.tempId)]));
  return {
    steps: steps.map(({ tempId, ...rest }) => ({
      ...rest,
      id: sid(tempId),
      projectId: "p1",
      createdAt: NOW,
      updatedAt: NOW,
    })),
    flow: remapFlow(flow, map),
    dismissed: {},
  };
}

// --- template edits (what the Library / Template Flow services do) ---------

const withMilestones = (t: Template, f: (m: Milestone) => Milestone): Template => ({
  ...t,
  milestones: t.milestones.map(f),
  revision: t.revision + 1,
});
const editMilestone = (t: Template, id: string, patch: Partial<Milestone>) =>
  withMilestones(t, (m) => (m.id === id ? { ...m, ...patch } : m));

function insertAfter(t: Template, afterId: string, m: Milestone): Template {
  const at = t.flow.nodes[afterId] ?? { x: 0, y: 0 };
  return {
    milestones: [...t.milestones, m],
    flow: insertAfterInFlow(t.flow, afterId, m.id, { x: at.x, y: at.y + 120 }, NOW, counter(`t-ins-${m.id}-`)),
    revision: t.revision + 1,
  };
}

function archiveMilestone(t: Template, id: string, batchId = "B1", reconnect = true): Template {
  const { flow } = archiveNodeInFlow(t.flow, id, { batchId, now: LATER, reconnect, idFactory: counter(`t-br-${id}-`) });
  return {
    milestones: t.milestones.map((m) => (m.id === id ? { ...m, archived: true, archivedAt: LATER, archiveBatch: batchId } : m)),
    flow,
    revision: t.revision + 1,
  };
}

function restoreMilestone(t: Template, id: string, batchId = "B1"): Template {
  const milestones = t.milestones.map((m) => {
    if (m.id !== id) return m;
    const copy: Milestone = { ...m, archived: false };
    delete copy.archivedAt;
    delete copy.archiveBatch;
    return copy;
  });
  const active = new Set(milestones.filter((m) => !m.archived).map((m) => m.id));
  return { milestones, flow: restoreBatchInFlow(t.flow, batchId, active, LATER).flow, revision: t.revision + 1 };
}

function addTemplateEdge(t: Template, from: string, to: string): Template {
  const r = addEdge(t.flow, from, to, NOW, () => `t-${from}-${to}`);
  if (!r.ok) throw new Error(r.reason);
  return { ...t, flow: r.flow, revision: t.revision + 1 };
}

// --- project edits -----------------------------------------------------------

const editStep = (p: SyncProjectInput, id: string, patch: Partial<Step>): SyncProjectInput => ({
  ...p,
  steps: p.steps.map((s) => (s.id === id ? { ...s, ...patch } : s)),
});

function projectOnlyStep(id: string, name: string, over: Partial<Step> = {}): Step {
  return {
    id,
    projectId: "p1",
    name,
    description: "",
    fieldType: "TEXT",
    choices: [],
    config: {},
    value: null,
    notApplicable: false,
    flag: null,
    order: 1.5,
    rev: 1,
    archived: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

/** "Insert after" in the project with a project-only step. */
function insertProjectStep(p: SyncProjectInput, afterId: string, step: Step): SyncProjectInput {
  return {
    ...p,
    steps: [...p.steps, step],
    flow: insertAfterInFlow(p.flow, afterId, step.id, { x: 0, y: 300 }, NOW, counter(`u-${step.id}-`)),
  };
}

// --- running sync ------------------------------------------------------------

const plan = (t: Template, p: SyncProjectInput) => planSync(t, p, ctx);
const all = (i: SyncItem) => i.selectable;
const defaults = (i: SyncItem) => i.defaultChecked;

function sync(
  t: Template,
  p: SyncProjectInput,
  pick: string[] | ((i: SyncItem) => boolean),
): { project: SyncProjectInput; result: SyncApplyResult } {
  const ids = typeof pick === "function" ? plan(t, p).items.filter(pick).map((i) => i.id) : pick;
  const r = applySync(t, p, ids, ctx, LATER, counter("pe"));
  if (!r.ok) throw new Error(`STALE_PLAN: ${r.missingIds.join(", ")}`);
  const newStepIds = Object.fromEntries(r.result.newSteps.map((d) => [d.tempId, sid(d.tempId)]));
  return { project: mergeSyncResult(p, r.result, { newStepIds, projectId: "p1", now: LATER }), result: r.result };
}

/** One line per item: kind, [x] / [ ] / locked, title. */
const brief = (pl: SyncPlan) =>
  pl.items.map((i) => `${i.kind} ${i.selectable ? (i.defaultChecked ? "[x]" : "[ ]") : "locked"} ${i.title}`);

const pairs = (p: SyncProjectInput) =>
  p.flow.edges
    .filter((e) => !e.archivedAt)
    .map((e) => `${e.from}>${e.to}`)
    .sort();

const step = (p: SyncProjectInput, id: string) => p.steps.find((s) => s.id === id)!;

const poChoices: Choice[] = [
  { id: "awaiting", label: "Awaiting", state: "WAITING" },
  { id: "loi-received", label: "LOI received", state: "IN_PROGRESS" },
  { id: "full-po", label: "Full PO", state: "DONE" },
  { id: "revised-po", label: "Revised PO", state: "DONE", archived: true },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("planSync: a fresh project", () => {
  it("has nothing to sync, including archived choices, configs and descriptions", () => {
    const t = chain(["a", "po", "qty", "c"], {
      po: { fieldType: "DROPDOWN", choices: poChoices, description: "Customer PO / LOI" },
      qty: { fieldType: "NUMBER", config: { unit: "pcs" } },
    });
    const p = createProject(t);
    expect(plan(t, p)).toEqual({ items: [], warnings: [] });
    const { result } = sync(t, p, []);
    expect(result).toMatchObject({ newSteps: [], stepPatches: [], appliedItemIds: [], summary: [] });
    expect(result.flow).toEqual(p.flow);
  });
});

describe("planSync: new milestones", () => {
  const t0 = chain(["a", "b", "c"]);
  const p0 = createProject(t0);

  it("splices a milestone inserted mid-chain: adds it and its arrows, removes the old arrow", () => {
    const t1 = insertAfter(t0, "a", milestone("m", 1.5));
    const pl = plan(t1, p0);
    expect(brief(pl)).toEqual([
      'addNode [x] Add "M"',
      'addEdge [x] Add arrow "A" → "M"',
      'addEdge [x] Add arrow "M" → "B"',
      'removeEdge [x] Remove arrow "A" → "B"',
    ]);
    expect(pl.items[1].edge).toEqual({ from: "s-a", to: "m" });
    expect(pl.items[3].detail).toContain('inserted "M"');
    expect(pl.items[0].id).toMatch(/^addNode:m:[0-9a-z]+$/);

    const { project, result } = sync(t1, p0, defaults);
    expect(pairs(project)).toEqual(["s-a>s-m", "s-b>s-c", "s-m>s-b"]);
    expect(result.newSteps).toHaveLength(1);
    expect(result.newSteps[0]).toMatchObject({ tempId: "m", milestoneId: "m", value: null, rev: 0, order: 1.5 });
    expect(result.flow.nodes.m).toEqual({ x: 240, y: 120 }); // right of and below its predecessor
    const removed = project.flow.edges.find((e) => e.id === "te:t-a-b")!;
    expect(removed).toMatchObject({ archivedAt: LATER, archivedReason: "SYNC" });
    expect(project.flow.edges.find((e) => e.from === "s-a" && e.to === "s-m")!.templateEdgeId).toBe("t-ins-m-2");
    expect(plan(t1, project)).toEqual({ items: [], warnings: [] });
  });

  it("splices two milestones inserted in a row", () => {
    const t1 = insertAfter(insertAfter(t0, "a", milestone("m1", 1.3)), "m1", milestone("m2", 1.6));
    const pl = plan(t1, p0);
    expect(brief(pl)).toEqual([
      'addNode [x] Add "M1"',
      'addNode [x] Add "M2"',
      'addEdge [x] Add arrow "A" → "M1"',
      'addEdge [x] Add arrow "M1" → "M2"',
      'addEdge [x] Add arrow "M2" → "B"',
      'removeEdge [x] Remove arrow "A" → "B"',
    ]);
    expect(pl.items[5].detail).toContain('inserted "M1" and "M2"');
    const { project, result } = sync(t1, p0, defaults);
    expect(pairs(project)).toEqual(["s-a>s-m1", "s-b>s-c", "s-m1>s-m2", "s-m2>s-b"]);
    expect(result.flow.nodes.m2).toEqual({ x: 480, y: 240 });
    expect(plan(t1, project).items).toEqual([]);
  });

  it("moves a new node down until it no longer overlaps", () => {
    const t1 = insertAfter(t0, "a", milestone("m", 1.5));
    const p = { ...p0, flow: { ...p0.flow, nodes: { ...p0.flow.nodes, "s-c": { x: 250, y: 130 } } } };
    expect(sync(t1, p, defaults).result.flow.nodes.m).toEqual({ x: 240, y: 200 });
  });

  it("adds an unconnected milestone at its template position", () => {
    const t1: Template = {
      ...t0,
      milestones: [...t0.milestones, milestone("z", 9)],
      flow: { ...t0.flow, nodes: { ...t0.flow.nodes, z: { x: 900, y: 500 } } },
    };
    expect(brief(plan(t1, p0))).toEqual(['addNode [x] Add "Z"']);
    expect(sync(t1, p0, defaults).result.flow.nodes.z).toEqual({ x: 900, y: 500 });
  });

  it("skips (and keeps offering) arrows to a node that was not added", () => {
    const t1 = insertAfter(t0, "a", milestone("m", 1.5));
    const edgeIds = plan(t1, p0)
      .items.filter((i) => i.kind === "addEdge")
      .map((i) => i.id);
    const { project, result } = sync(t1, p0, edgeIds);
    expect(result.appliedItemIds).toEqual([]);
    expect(result.summary).toEqual([
      'Skipped arrow "A" → "M": "M" was not added.',
      'Skipped arrow "M" → "B": "M" was not added.',
    ]);
    expect(pairs(project)).toEqual(pairs(p0));
    expect(plan(t1, project).items).toHaveLength(4);
  });
});

describe("planSync: choices", () => {
  const t0 = chain(["a", "po"], { po: { fieldType: "DROPDOWN", choices: poChoices } });
  const p0 = editStep(createProject(t0), "s-po", { value: { choiceId: "loi-received" } });
  const setChoices = (f: (c: Choice[]) => Choice[]) =>
    editMilestone(t0, "po", { choices: f(poChoices.map((c) => ({ ...c }))) });

  it.each([
    {
      name: "renamed choice",
      t: setChoices((c) => c.map((x) => (x.id === "awaiting" ? { ...x, label: "Waiting for PO" } : x))),
      detail: 'Renamed "Awaiting" → "Waiting for PO".',
      stateChange: undefined,
    },
    {
      name: "retagged choice in use (colour change preview)",
      t: setChoices((c) => c.map((x) => (x.id === "loi-received" ? { ...x, state: "DONE" as const } : x))),
      detail: 'Retagged "LOI received" In progress → Done.',
      stateChange: { from: "IN_PROGRESS", to: "DONE" },
    },
    {
      name: "removed choice still in use is retired, value kept",
      t: setChoices((c) => c.filter((x) => x.id !== "loi-received")),
      detail: 'Retired "LOI received".',
      stateChange: undefined,
    },
    {
      name: "added choice",
      t: setChoices((c) => [...c, { id: "partial-po", label: "Partial PO", state: "IN_PROGRESS" }]),
      detail: 'Added "Partial PO".',
      stateChange: undefined,
    },
    {
      name: "archived choice brought back and reordered",
      t: setChoices((c) => [{ ...c[3], archived: false }, c[0], c[1], c[2]]),
      detail: 'Brought back "Revised PO".',
      stateChange: undefined,
    },
  ])("$name", ({ t, detail, stateChange }) => {
    const pl = plan(t, p0);
    expect(brief(pl)).toEqual(['updateChoices [x] Update choices of "PO"']);
    expect(pl.items[0].detail).toBe(detail);
    expect(pl.items[0].stateChange).toEqual(stateChange);
    const { project } = sync(t, p0, defaults);
    const s = step(project, "s-po");
    expect(s.value).toEqual({ choiceId: "loi-received" });
    expect(s.choices.find((c) => c.id === "loi-received")).toBeDefined(); // never removed
    expect(plan(t, project).items).toEqual([]);
  });

  it("merges project-only choices as retired, after the template's choices", () => {
    const p = editStep(p0, "s-po", {
      choices: [...poChoices, { id: "on-hold", label: "On hold", state: "BLOCKED" }],
      value: { choiceId: "on-hold" },
    });
    const t = setChoices((c) => c.map((x) => (x.id === "awaiting" ? { ...x, label: "Awaiting PO" } : x)));
    const { project } = sync(t, p, defaults);
    expect(step(project, "s-po").choices.map((c) => [c.id, !!c.archived])).toEqual([
      ["awaiting", false],
      ["loi-received", false],
      ["full-po", false],
      ["revised-po", true],
      ["on-hold", true],
    ]);
    expect(step(project, "s-po").value).toEqual({ choiceId: "on-hold" });
  });
});

describe("planSync: field type changes", () => {
  const t0 = chain(["a", "b", "d"], { d: { fieldType: "DATE" } });

  it("offers a checked change for a step without a value", () => {
    const t1 = editMilestone(t0, "b", { fieldType: "LONG_TEXT" });
    const pl = plan(t1, createProject(t0));
    expect(brief(pl)).toEqual(['changeType [x] Change "B" to Long text']);
    expect(pl.items[0].detail).toContain("no value yet");
    const { project, result } = sync(t1, createProject(t0), defaults);
    expect(result.stepPatches).toEqual([{ stepId: "s-b", patch: { fieldType: "LONG_TEXT" } }]);
    expect(plan(t1, project).items).toEqual([]);
  });

  it("converts a value losslessly (Date -> Date range keeps the date as start)", () => {
    const p = editStep(createProject(t0), "s-d", { value: { date: "2026-11-12" }, valueSetAt: NOW });
    const t1 = editMilestone(t0, "d", { fieldType: "DATE_RANGE" });
    const pl = plan(t1, p);
    expect(brief(pl)).toEqual(['changeType [x] Change "D" to Date range']);
    expect(pl.items[0].detail).toContain("value is kept");
    const { project } = sync(t1, p, defaults);
    expect(step(project, "s-d")).toMatchObject({ fieldType: "DATE_RANGE", value: { start: "2026-11-12" }, valueSetAt: NOW });
    expect(plan(t1, project).items).toEqual([]);
  });

  it("converts Dropdown -> Multiple with the merged choices and previews state changes", () => {
    const t = chain(["a", "prod"], {
      prod: { fieldType: "DROPDOWN", choices: [{ id: "afl", label: "AFL", state: "IN_PROGRESS" }] },
    });
    const p = editStep(createProject(t), "s-prod", { value: { choiceId: "afl" } });
    const t1 = editMilestone(t, "prod", { fieldType: "MULTIPLE", choices: [{ id: "afl", label: "AFL" }, { id: "abcs", label: "ABCS" }] });
    const pl = plan(t1, p);
    expect(brief(pl)).toEqual(['changeType [x] Change "PROD" to Multiple']);
    expect(pl.items[0].stateChange).toEqual({ from: "IN_PROGRESS", to: "DONE" });
    const { project } = sync(t1, p, defaults);
    expect(step(project, "s-prod")).toMatchObject({
      fieldType: "MULTIPLE",
      value: { choiceIds: ["afl"] },
      choices: [{ id: "afl", label: "AFL" }, { id: "abcs", label: "ABCS" }],
    });
    expect(plan(t1, project).items).toEqual([]);
  });

  it("never clears a value that can't be converted: the item is locked until the value is empty", () => {
    const p = editStep(createProject(t0), "s-b", { value: { text: "hello" } });
    const t1 = editMilestone(t0, "b", { fieldType: "NUMBER" });
    const pl = plan(t1, p);
    expect(brief(pl)).toEqual(['changeType locked "B" type differs from the template']);
    expect(pl.items[0].defaultChecked).toBe(false);
    expect(pl.warnings).toHaveLength(1);
    expect(pl.warnings[0]).toContain('"B" keeps its Text type');

    const { project } = sync(t1, p, all);
    expect(step(project, "s-b")).toMatchObject({ fieldType: "TEXT", value: { text: "hello" } });
    expect(applySync(t1, p, [pl.items[0].id], ctx, LATER, counter("x"))).toEqual({
      ok: false,
      reason: "STALE_PLAN",
      missingIds: [pl.items[0].id],
    });

    const cleared = editStep(project, "s-b", { value: null });
    expect(brief(plan(t1, cleared))).toEqual(['changeType [x] Change "B" to Number']);
  });
});

describe("planSync: definitions and silent refreshes", () => {
  const t0 = chain(["a", "b", "c"]);
  const p0 = createProject(t0);

  it("updates name, description and config together", () => {
    const t1 = editMilestone(t0, "b", { name: "B two", description: "New help", config: { unit: "pcs" } });
    const pl = plan(t1, p0);
    expect(brief(pl)).toEqual(['updateDefinition [x] Update "B"']);
    expect(pl.items[0].detail).toBe('Name: "B" → "B two"; Description updated; Unit: now "pcs".');
    const { project, result } = sync(t1, p0, defaults);
    expect(result.stepPatches).toEqual([
      { stepId: "s-b", patch: { config: { unit: "pcs" }, name: "B two", description: "New help" } },
    ]);
    expect(step(project, "s-b")).toMatchObject({ name: "B two", description: "New help", config: { unit: "pcs" } });
    expect(plan(t1, project).items).toEqual([]);
  });

  it("refreshes order (and config) silently, even when no item is selected", () => {
    const t1 = editMilestone(editMilestone(t0, "c", { order: 10 }), "a", { config: { unit: "sets" } });
    expect(brief(plan(t1, p0))).toEqual(['updateDefinition [x] Update "A"']);
    const { project, result } = sync(t1, p0, []);
    expect(result.stepPatches).toEqual([
      { stepId: "s-a", patch: { config: { unit: "sets" } } },
      { stepId: "s-c", patch: { order: 10 } },
    ]);
    expect(step(project, "s-c").order).toBe(10);
  });

  it("never touches values, flags or N/A of existing steps", () => {
    let p = editStep(p0, "s-b", { value: { text: "x" }, flag: "BLOCKED", valueSetAt: NOW });
    p = editStep(p, "s-c", { notApplicable: true });
    const t1 = editMilestone(editMilestone(t0, "b", { name: "B2" }), "c", { name: "C2", description: "d" });
    const { result, project } = sync(t1, p, all);
    for (const { patch } of result.stepPatches) {
      expect(Object.keys(patch).filter((k) => ["value", "flag", "notApplicable", "valueSetAt"].includes(k))).toEqual([]);
    }
    expect(step(project, "s-b")).toMatchObject({ value: { text: "x" }, flag: "BLOCKED" });
    expect(step(project, "s-c").notApplicable).toBe(true);
  });
});

describe("planSync: milestones removed from the template", () => {
  const t0 = chain(["a", "b", "c"]);
  const p0 = createProject(t0);

  it("offers to reconnect around it and (unchecked) to mark the step N/A", () => {
    const t1 = archiveMilestone(t0, "b");
    const pl = plan(t1, p0);
    expect(brief(pl)).toEqual([
      'addEdge [x] Add arrow "A" → "C"',
      'removeEdge [x] Remove arrow "A" → "B"',
      'removeEdge [x] Remove arrow "B" → "C"',
      'markNA [ ] Mark "B" not applicable',
    ]);
    expect(pl.items[0].detail).toContain('Reconnects around "B"');
    expect(pl.items[3].stateChange).toEqual({ from: "NOT_STARTED", to: "NOT_APPLICABLE" });

    const { project } = sync(t1, p0, defaults);
    expect(pairs(project)).toEqual(["s-a>s-c"]);
    expect(step(project, "s-b").notApplicable).toBe(false);
    expect(brief(plan(t1, project))).toEqual(['markNA [ ] Mark "B" not applicable']);

    const done = sync(t1, project, all).project;
    expect(step(done, "s-b").notApplicable).toBe(true);
    expect(plan(t1, done).items).toEqual([]);
  });

  it("previews the colour change of a FILE step from its attachment count", () => {
    const t = chain(["a", "docs"], { docs: { fieldType: "FILE" } });
    const p = { ...createProject(t), attachmentCounts: { "s-docs": 2 } };
    const pl = plan(archiveMilestone(t, "docs"), p);
    expect(pl.items.find((i) => i.kind === "markNA")!.stateChange).toEqual({ from: "DONE", to: "NOT_APPLICABLE" });
  });

  it("handles a milestone deleted outright", () => {
    const t1: Template = { ...t0, milestones: t0.milestones.filter((m) => m.id !== "c"), flow: { ...t0.flow, edges: [t0.flow.edges[0]] } };
    const pl = plan(t1, p0);
    expect(brief(pl)).toEqual(['removeEdge [x] Remove arrow "B" → "C"', 'markNA [ ] Mark "C" not applicable']);
    expect(pl.items[1].detail).toContain("no longer in the template");
  });

  it("insert M -> sync -> remove M -> sync returns the project to a -> b", () => {
    const t = chain(["a", "b"]);
    let p = createProject(t);
    const t1 = insertAfter(t, "a", milestone("m", 1.5));
    p = sync(t1, p, defaults).project;
    expect(pairs(p)).toEqual(["s-a>s-m", "s-m>s-b"]);

    const t2 = archiveMilestone(t1, "m");
    expect(brief(plan(t2, p))).toEqual([
      'addEdge [x] Add arrow "A" → "B"',
      'removeEdge [x] Remove arrow "A" → "M"',
      'removeEdge [x] Remove arrow "M" → "B"',
      'markNA [ ] Mark "M" not applicable',
    ]);
    p = sync(t2, p, defaults).project;
    expect(pairs(p)).toEqual(["s-a>s-b"]);
    // The original arrow came back (same id), linked to the template's new a -> b arrow.
    const ab = p.flow.edges.find((e) => !e.archivedAt)!;
    expect(ab.id).toBe("te:t-a-b");
    expect(ab.archivedReason).toBeUndefined();
    expect(brief(plan(t2, p))).toEqual(['markNA [ ] Mark "M" not applicable']);
  });
});

describe("planSync: arrows", () => {
  const t0 = chain(["a", "b", "c"]);
  const p0 = createProject(t0);

  it("never re-adds an arrow the user removed", () => {
    const p = { ...p0, flow: archiveEdge(p0.flow, "te:t-a-b", LATER, "USER") };
    expect(plan(t0, p).items).toEqual([]);
    const t1 = editMilestone(t0, "a", { name: "A2" });
    expect(brief(plan(t1, p))).toEqual(['updateDefinition [x] Update "A"']);
    // Nor after the template archives and restores a neighbour.
    expect(plan(restoreMilestone(archiveMilestone(t0, "b"), "b"), p).items).toEqual([]);
  });

  it("offers a template arrow between existing steps unchecked", () => {
    const t1 = addTemplateEdge(t0, "a", "c");
    const pl = plan(t1, p0);
    expect(brief(pl)).toEqual(['addEdge [ ] Add arrow "A" → "C"']);
    expect(pl.items[0].detail).toContain("re-routed");
    const { project } = sync(t1, p0, defaults);
    expect(pairs(project)).toEqual(pairs(p0));
    expect(brief(plan(t1, project))).toEqual(['addEdge [ ] Add arrow "A" → "C"']);
    const withIt = sync(t1, p0, all).project;
    expect(pairs(withIt)).toEqual(["s-a>s-b", "s-a>s-c", "s-b>s-c"]);
    expect(withIt.flow.edges.find((e) => e.from === "s-a" && e.to === "s-c")).toMatchObject({
      id: "pe1",
      templateEdgeId: "t-a-c",
      createdAt: LATER,
    });
  });

  it("links a user-drawn arrow with the same pair silently", () => {
    const drawn = addEdge(p0.flow, "s-a", "s-c", NOW, () => "u1");
    if (!drawn.ok) throw new Error(drawn.reason);
    const p = { ...p0, flow: drawn.flow };
    const t1 = addTemplateEdge(t0, "a", "c");
    expect(plan(t1, p)).toEqual({ items: [], warnings: [] });
    const { project } = sync(t1, p, []);
    expect(project.flow.edges.find((e) => e.id === "u1")!.templateEdgeId).toBe("t-a-c");
    // Once linked, the template removing that arrow is offered as a removal.
    const t2 = { ...t1, flow: archiveEdge(t1.flow, "t-a-c", LATER, "USER") };
    expect(brief(plan(t2, project))).toEqual(['removeEdge [ ] Remove arrow "A" → "C"']);
  });

  it("skips an arrow that would create a loop, with a warning", () => {
    const t = { ...chain(["a", "b", "c"]), flow: { ...chain(["a", "b", "c"]).flow, edges: [tEdge("a", "b")] } };
    const drawn = addEdge(createProject(t).flow, "s-b", "s-c", NOW, () => "u1");
    if (!drawn.ok) throw new Error(drawn.reason);
    const p = { ...createProject(t), flow: drawn.flow };
    const t1 = addTemplateEdge(t, "c", "a");
    const pl = plan(t1, p);
    expect(pl.items).toEqual([]);
    expect(pl.warnings).toEqual(['Arrow "C" → "A" skipped: it would create a loop.']);
  });

  it("offers a template arrow removal unchecked when it is not a splice", () => {
    const t1 = { ...t0, flow: archiveEdge(t0.flow, "t-b-c", LATER, "USER") };
    const pl = plan(t1, p0);
    expect(brief(pl)).toEqual(['removeEdge [ ] Remove arrow "B" → "C"']);
    expect(pl.items[0].detail).toBe("The template removed this arrow. The arrow is archived, not deleted.");
  });

  it("keeps project-only steps and arrows untouched", () => {
    const x = projectOnlyStep("x", "Extra check", { value: { text: "hi" } });
    const p = insertProjectStep(p0, "s-a", x);
    expect(pairs(p)).toEqual(["s-a>x", "s-b>s-c", "x>s-b"]);
    expect(plan(t0, p).items).toEqual([]);

    const t1 = insertAfter(editMilestone(t0, "b", { name: "B2" }), "c", milestone("n", 4));
    const pl = plan(t1, p);
    expect(brief(pl)).toEqual(['addNode [x] Add "N"', 'updateDefinition [x] Update "B"', 'addEdge [x] Add arrow "C" → "N"']);
    expect(pl.items.some((i) => i.stepId === "x" || i.edge?.from === "x" || i.edge?.to === "x")).toBe(false);

    const { project, result } = sync(t1, p, all);
    expect(result.stepPatches.some((sp) => sp.stepId === "x")).toBe(false);
    expect(step(project, "x")).toEqual(x);
    expect(pairs(project)).toEqual(["s-a>x", "s-b>s-c", "s-c>s-n", "x>s-b"]);
    expect(project.flow.edges.find((e) => e.id === "te:t-a-b")).toMatchObject({ archivedReason: "INSERT_AFTER" });
  });
});

describe("planSync: archive + Undo", () => {
  it("nets to no sync items (template)", () => {
    const t0 = chain(["a", "b", "c"]);
    const p = createProject(t0);
    const t1 = archiveMilestone(t0, "b");
    expect(plan(t1, p).items.length).toBeGreaterThan(0);
    expect(plan(restoreMilestone(t1, "b"), p)).toEqual({ items: [], warnings: [] });
  });

  it("nets to no sync items when the bridged pair had been removed on purpose (template)", () => {
    const t0 = insertAfter(chain(["a", "b"]), "a", milestone("m", 1.5)); // a -> b archived INSERT_AFTER
    const p = createProject(t0);
    const t2 = restoreMilestone(archiveMilestone(t0, "m"), "m");
    expect(plan(t2, p)).toEqual({ items: [], warnings: [] });
  });

  it("nets to no sync items (project-only step archived with reconnect)", () => {
    const t0 = chain(["a", "b", "c"]);
    const x = projectOnlyStep("x", "Extra");
    const p = insertProjectStep(createProject(t0), "s-a", x);
    const archived = archiveNodeInFlow(p.flow, "x", { batchId: "PB", now: LATER, reconnect: true, idFactory: () => "br" });
    const pArchived = { ...editStep(p, "x", { archived: true, archivedAt: LATER, archiveBatch: "PB" }), flow: archived.flow };
    expect(pairs(pArchived)).toEqual(["s-a>s-b", "s-b>s-c"]);
    expect(plan(t0, pArchived).items).toEqual([]);
    // Applying sync while it is archived links the bridge silently; Undo still nets to nothing.
    const synced = sync(t0, pArchived, []).project;
    const restored = {
      ...editStep(synced, "x", { archived: false }),
      flow: restoreBatchInFlow(synced.flow, "PB", new Set(["s-a", "s-b", "s-c", "x"]), LATER).flow,
    };
    expect(pairs(restored)).toEqual(pairs(p));
    expect(plan(t0, restored)).toEqual({ items: [], warnings: [] });
  });
});

describe("planSync: promoted project-only steps", () => {
  const t0 = chain(["a", "b", "c"]);

  it("links a matching project-only step instead of adding a duplicate", () => {
    const x = projectOnlyStep("x", "Customs  check!", { value: { text: "Cleared" }, valueSetAt: NOW });
    const p = insertProjectStep(createProject(t0), "s-a", x);
    const t1 = insertAfter(t0, "a", milestone("m", 1.5, { name: "Customs Check", fieldType: "LONG_TEXT", key: "customs-check" }));
    const pl = plan(t1, p);
    expect(brief(pl)).toEqual(['linkExisting [x] Link "Customs  check!" to the template']);
    expect(pl.items[0]).toMatchObject({ stepId: "x", milestoneId: "m" });

    const { project } = sync(t1, p, defaults);
    expect(step(project, "x")).toMatchObject({
      milestoneId: "m",
      milestoneKey: "customs-check",
      name: "Customs Check",
      fieldType: "LONG_TEXT",
      value: { text: "Cleared" },
      valueSetAt: NOW,
      order: 1.5,
    });
    expect(project.steps).toHaveLength(4);
    expect(project.flow.edges.filter((e) => !e.archivedAt).map((e) => e.templateEdgeId).sort()).toEqual(
      ["t-b-c", "t-ins-m-1", "t-ins-m-2"].sort(),
    );
    expect(plan(t1, project)).toEqual({ items: [], warnings: [] });
  });

  it("connects a linked step that had no arrows, and only when the link is applied", () => {
    const x = projectOnlyStep("x", "Customs check");
    const p = { ...createProject(t0), steps: [...createProject(t0).steps, x] };
    const t1 = insertAfter(t0, "a", milestone("m", 1.5, { name: "Customs check" }));
    const pl = plan(t1, p);
    expect(brief(pl)).toEqual([
      'linkExisting [x] Link "Customs check" to the template',
      'addEdge [x] Add arrow "A" → "Customs check"',
      'addEdge [x] Add arrow "Customs check" → "B"',
      'removeEdge [x] Remove arrow "A" → "B"',
    ]);
    expect(pl.items[1].edge).toEqual({ from: "s-a", to: "x" });
    const linked = sync(t1, p, defaults).project;
    expect(pairs(linked)).toEqual(["s-a>x", "s-b>s-c", "x>s-b"]);
    expect(plan(t1, linked).items).toEqual([]);

    const edgesOnly = sync(t1, p, (i) => i.kind === "addEdge");
    expect(edgesOnly.result.summary).toEqual([
      'Skipped arrow "A" → "Customs check": "Customs check" was not linked.',
      'Skipped arrow "Customs check" → "B": "Customs check" was not linked.',
    ]);
    expect(pairs(edgesOnly.project)).toEqual(pairs(p));
  });

  it("adds a new step when the matching step's value can't be converted", () => {
    const x = projectOnlyStep("x", "Customs check", { fieldType: "NUMBER", value: { number: 5 } });
    const p = insertProjectStep(createProject(t0), "s-a", x);
    const t1 = insertAfter(t0, "a", milestone("m", 1.5, { name: "Customs check", fieldType: "DATE" }));
    expect(plan(t1, p).items[0].kind).toBe("addNode");
  });
});

describe("planSync: dismissed items", () => {
  const t0 = chain(["a", "b", "c"]);
  const p0 = createProject(t0);

  it("returns a declined item unchecked until the change itself changes", () => {
    const t1 = editMilestone(t0, "b", { name: "B2" });
    const item = plan(t1, p0).items[0];
    const p = { ...p0, dismissed: { [dismissKeyOf(item.id)]: changeHashOf(item.id) } };
    expect(dismissKeyOf(item.id)).toBe("updateDefinition:b");
    const again = plan(t1, p).items[0];
    expect(again).toEqual({ ...item, defaultChecked: false });
    // Still selectable on purpose.
    expect(sync(t1, p, [again.id]).project.steps.find((s) => s.id === "s-b")!.name).toBe("B2");

    const t2 = editMilestone(t0, "b", { name: "B3" });
    const changed = plan(t2, p).items[0];
    expect(changed.id).not.toBe(item.id);
    expect(changed.defaultChecked).toBe(true);
  });

  it("a declined new milestone also unchecks its arrows and the splice", () => {
    const t1 = insertAfter(t0, "a", milestone("m", 1.5));
    const add = plan(t1, p0).items[0];
    const p = { ...p0, dismissed: { [dismissKeyOf(add.id)]: changeHashOf(add.id) } };
    const pl = plan(t1, p);
    expect(pl.items.every((i) => !i.defaultChecked)).toBe(true);
    const { project } = sync(t1, p, defaults);
    expect(pairs(project)).toEqual(pairs(p0));
    expect(plan(t1, project).items.map((i) => i.id)).toEqual(pl.items.map((i) => i.id));
  });
});

describe("applySync", () => {
  const t0 = chain(["a", "b", "c"]);
  const p0 = createProject(t0);

  it("rejects a stale plan", () => {
    const t1 = editMilestone(t0, "b", { name: "B2" });
    const stale = plan(t1, p0).items[0].id;
    const t2 = editMilestone(t0, "b", { name: "B3" });
    expect(applySync(t2, p0, [stale], ctx, LATER, counter("x"))).toEqual({
      ok: false,
      reason: "STALE_PLAN",
      missingIds: [stale],
    });
    expect(applySync(t2, p0, ["addNode:nope:123"], ctx, LATER, counter("x"))).toMatchObject({
      ok: false,
      missingIds: ["addNode:nope:123"],
    });
  });

  it("writes a plain-English summary", () => {
    const t1 = insertAfter(editMilestone(t0, "c", { name: "C2" }), "a", milestone("m", 1.5));
    const { result } = sync(t1, p0, all);
    expect(result.summary).toEqual([
      'Added "M".',
      'Updated "C".',
      'Removed arrow "A" → "B".',
      'Added arrow "A" → "M".',
      'Added arrow "M" → "B".',
    ]);
  });
});

describe("planSync properties", () => {
  /** A template with many kinds of change against a project with values. */
  function scenario() {
    const t0 = chain(["a", "po", "b", "d", "c", "e"], {
      po: { fieldType: "DROPDOWN", choices: poChoices },
      d: { fieldType: "DATE" },
    });
    let p = createProject(t0);
    p = editStep(p, "s-po", { value: { choiceId: "loi-received" } as Value });
    p = editStep(p, "s-d", { value: { date: "2026-10-01" }, valueSetAt: NOW });
    p = insertProjectStep(p, "s-e", projectOnlyStep("x", "Own step", { order: 6.5 }));

    let t = editMilestone(t0, "a", { name: "A renamed", config: { unit: "pcs" } });
    t = editMilestone(t, "po", {
      choices: poChoices.map((c) => (c.id === "loi-received" ? { ...c, state: "DONE" as const } : c)),
    });
    t = editMilestone(t, "d", { fieldType: "DATE_RANGE" });
    t = insertAfter(t, "b", milestone("m", 3.5));
    t = archiveMilestone(t, "c");
    t = addTemplateEdge(t, "a", "e");
    return { t, p };
  }

  it("the scenario has checked and unchecked items", () => {
    const { t, p } = scenario();
    expect(brief(plan(t, p))).toEqual([
      'addNode [x] Add "M"',
      'updateDefinition [x] Update "A"',
      'updateChoices [x] Update choices of "PO"',
      'changeType [x] Change "D" to Date range',
      'addEdge [ ] Add arrow "A" → "E"',
      'addEdge [x] Add arrow "B" → "M"',
      'addEdge [x] Add arrow "M" → "D"',
      'addEdge [x] Add arrow "D" → "E"',
      'removeEdge [x] Remove arrow "B" → "D"',
      'removeEdge [x] Remove arrow "D" → "C"',
      'removeEdge [x] Remove arrow "C" → "E"',
      'markNA [ ] Mark "C" not applicable',
    ]);
  });

  it("applying every selectable item, then re-planning, gives an empty plan", () => {
    const { t, p } = scenario();
    const { project } = sync(t, p, all);
    expect(plan(t, project)).toEqual({ items: [], warnings: [] });
    expect(step(project, "s-d").value).toEqual({ start: "2026-10-01" });
    expect(step(project, "x")).toEqual(p.steps.find((s) => s.id === "x"));
  });

  it("applying the defaults, then re-planning, leaves exactly the unchecked items", () => {
    const { t, p } = scenario();
    const first = plan(t, p);
    const unchecked = first.items.filter((i) => !i.defaultChecked).map((i) => i.id);
    const { project } = sync(t, p, defaults);
    expect(plan(t, project).items.map((i) => i.id)).toEqual(unchecked);
    expect(plan(t, project).items.every((i) => !i.defaultChecked)).toBe(true);
  });

  it("applying twice changes nothing the second time", () => {
    const { t, p } = scenario();
    const once = sync(t, p, defaults).project;
    const twice = sync(t, once, defaults);
    expect(twice.result.appliedItemIds).toEqual([]);
    expect(twice.result.stepPatches).toEqual([]);
    expect(twice.project.flow).toEqual(once.flow);
  });

  it("is deterministic and does not mutate its inputs", () => {
    const { t, p } = scenario();
    const tJson = JSON.stringify(t);
    const pJson = JSON.stringify(p);
    expect(plan(t, p)).toEqual(plan(t, p));
    sync(t, p, all);
    expect(JSON.stringify(t)).toBe(tJson);
    expect(JSON.stringify(p)).toBe(pJson);
  });
});

describe("review regressions", () => {
  it.each([
    { to: "NUMBER" as const, brief: 'changeType locked "D" type differs from the template', fieldType: "DATE" },
    { to: "TEXT" as const, brief: 'changeType [x] Change "D" to Text', fieldType: "TEXT" },
  ])("never clears a value that is invalid for its own type (template changes Date -> $to)", ({ to, brief: b, fieldType }) => {
    // A Date step holding a text value (written under an earlier type): it must not count as empty.
    const t0 = chain(["a", "d"], { d: { fieldType: "DATE" } });
    const p = editStep(createProject(t0), "s-d", { value: { text: "next week" } });
    const t1 = editMilestone(t0, "d", { fieldType: to });
    expect(brief(plan(t1, p))).toEqual([b]);
    const { project, result } = sync(t1, p, all);
    expect(result.stepPatches.some((sp) => "value" in sp.patch)).toBe(false);
    expect(step(project, "s-d")).toMatchObject({ fieldType, value: { text: "next week" } });
  });

  it("never clears an invalid value when linking a project-only step", () => {
    const t0 = chain(["a", "b"]);
    const x = projectOnlyStep("x", "Customs check", { fieldType: "DATE", value: { text: "tbc" } });
    const p = insertProjectStep(createProject(t0), "s-a", x);
    const t1 = insertAfter(t0, "a", milestone("m", 1.5, { name: "Customs check", fieldType: "NUMBER" }));
    expect(plan(t1, p).items[0].kind).toBe("addNode"); // not linked: the value can't be kept
    const { project } = sync(t1, p, all);
    expect(step(project, "x")).toEqual(x);
  });

  it("does not link arrows of a project-only step whose link was not applied", () => {
    const t0 = chain(["a", "b"]);
    const x = projectOnlyStep("x", "Customs check");
    const p = insertProjectStep(createProject(t0), "s-a", x); // s-a -> x -> s-b, drawn in the project
    const t1 = insertAfter(t0, "a", milestone("m", 1.5, { name: "Customs check" }));
    expect(brief(plan(t1, p))).toEqual(['linkExisting [x] Link "Customs check" to the template']);
    const { project } = sync(t1, p, []);
    const touchingX = project.flow.edges.filter((e) => e.from === "x" || e.to === "x");
    expect(touchingX.map((e) => e.templateEdgeId)).toEqual([undefined, undefined]);
    expect(project.flow).toEqual(p.flow);
  });

  it("does not cut the flow by default when a removed step is followed by a project-only step", () => {
    const t0 = chain(["a", "b", "c"]);
    const p = insertProjectStep(createProject(t0), "s-b", projectOnlyStep("x", "Extra", { order: 2.5 }));
    expect(pairs(p)).toEqual(["s-a>s-b", "s-b>x", "x>s-c"]);
    const t1 = archiveMilestone(t0, "b");
    const pl = plan(t1, p);
    expect(brief(pl)).toEqual([
      'addEdge [ ] Add arrow "A" → "C"',
      'removeEdge [ ] Remove arrow "A" → "B"',
      'markNA [ ] Mark "B" not applicable',
    ]);
    expect(pl.items[1].detail).toContain('cut "A" off from "Extra"');
    expect(pairs(sync(t1, p, defaults).project)).toEqual(pairs(p));
    // Everything selected still nets to an empty plan.
    const done = sync(t1, p, all).project;
    expect(pairs(done)).toEqual(["s-a>s-c", "s-b>x", "x>s-c"]);
    expect(plan(t1, done)).toEqual({ items: [], warnings: [] });
  });

  it("does not tick the reconnection when the removed step's arrows must stay", () => {
    // b has a second, project-only successor: removing b's arrows would cut "A" off from it.
    const t0 = chain(["a", "b", "c"]);
    const base = createProject(t0);
    const drawn = addEdge({ ...base.flow, nodes: { ...base.flow.nodes, x: { x: 0, y: 300 } } }, "s-b", "x", NOW, () => "u1");
    if (!drawn.ok) throw new Error(drawn.reason);
    const p = { ...base, steps: [...base.steps, projectOnlyStep("x", "Extra")], flow: drawn.flow };
    expect(pairs(p)).toEqual(["s-a>s-b", "s-b>s-c", "s-b>x"]);
    const t1 = archiveMilestone(t0, "b");
    expect(brief(plan(t1, p))).toEqual([
      'addEdge [ ] Add arrow "A" → "C"',
      'removeEdge [ ] Remove arrow "A" → "B"',
      'removeEdge [ ] Remove arrow "B" → "C"',
      'markNA [ ] Mark "B" not applicable',
    ]);
  });

  it("keeps a splice's old arrow when the inserted milestone is not added", () => {
    const t0 = chain(["a", "b", "c"]);
    const p0 = createProject(t0);
    const t1 = insertAfter(t0, "a", milestone("m", 1.5));
    const { project, result } = sync(t1, p0, (i) => i.kind === "removeEdge");
    expect(pairs(project)).toEqual(pairs(p0));
    expect(project.flow).toEqual(p0.flow);
    expect(result.appliedItemIds).toEqual([]);
    expect(result.summary).toEqual(['Kept arrow "A" → "B": "M" was not added.']);
    // The full splice still applies when everything is selected.
    expect(pairs(sync(t1, p0, all).project)).toEqual(["s-a>s-m", "s-b>s-c", "s-m>s-b"]);
  });

  it("offers choice updates even while a type change is locked", () => {
    const docs: Choice[] = [
      { id: "packing-list", label: "Packing list" },
      { id: "msds", label: "MSDS" },
    ];
    const t0 = chain(["a", "docs"], { docs: { fieldType: "MULTIPLE", choices: docs } });
    const p = editStep(createProject(t0), "s-docs", { value: { choiceIds: ["packing-list", "msds"] } });
    const t1 = editMilestone(t0, "docs", {
      fieldType: "DROPDOWN",
      choices: [
        { id: "packing-list", label: "Packing list (official)", state: "DONE" },
        { id: "msds", label: "MSDS", state: "DONE" },
        { id: "form-e", label: "Form E", state: "DONE" },
      ],
    });
    expect(brief(plan(t1, p))).toEqual([
      'changeType locked "DOCS" type differs from the template',
      'updateChoices [x] Update choices of "DOCS"',
    ]);
    const { project } = sync(t1, p, all);
    expect(step(project, "s-docs")).toMatchObject({ fieldType: "MULTIPLE", value: { choiceIds: ["packing-list", "msds"] } });
    expect(step(project, "s-docs").choices.map((c) => c.label)).toEqual(["Packing list (official)", "MSDS", "Form E"]);
    expect(brief(plan(t1, project))).toEqual(['changeType locked "DOCS" type differs from the template']);
  });

  it("brings a declined type change back when the template's choices change", () => {
    const t0 = chain(["a", "prod"], {
      prod: { fieldType: "DROPDOWN", choices: [{ id: "afl", label: "AFL", state: "DONE" }] },
    });
    const p0 = editStep(createProject(t0), "s-prod", { value: { choiceId: "afl" } });
    const t1 = editMilestone(t0, "prod", { fieldType: "MULTIPLE", choices: [{ id: "afl", label: "AFL" }] });
    const item = plan(t1, p0).items[0];
    expect(item.kind).toBe("changeType");
    const p = { ...p0, dismissed: { [dismissKeyOf(item.id)]: changeHashOf(item.id) } };
    expect(plan(t1, p).items[0].defaultChecked).toBe(false);
    const t2 = editMilestone(t1, "prod", { choices: [{ id: "afl", label: "AFL" }, { id: "abcs", label: "ABCS" }] });
    expect(plan(t2, p).items[0]).toMatchObject({ kind: "changeType", defaultChecked: true });
  });
});

describe("planSync on the 64-step chain", () => {
  it("copies 64 steps and 63 arrows and plans nothing", () => {
    const ids = Array.from({ length: 64 }, (_, i) => `m${i + 1}`);
    const t = chain(ids, { m54: { fieldType: "DROPDOWN", choices: poChoices } });
    const p = createProject(t);
    expect(p.steps).toHaveLength(64);
    expect(p.flow.edges).toHaveLength(63);
    expect(p.flow.edges.every((e) => e.templateEdgeId === e.id.slice(3))).toBe(true);
    expect(step(p, "s-m54").choices).toEqual(poChoices);
    expect(plan(t, p).items).toEqual([]);
  });
});
