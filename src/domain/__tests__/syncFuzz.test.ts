/**
 * Seeded property tests for sync: random template edits against random project edits, checking the rules that must
 * hold for every input (DESIGN.md 4.7 and section 12). Deterministic: the same seeds run every time.
 */
import { describe, expect, it } from "vitest";
import {
  addEdge,
  archiveEdge,
  archiveNodeInFlow,
  insertAfterInFlow,
  isReachable,
  restoreBatchInFlow,
  wouldCreateCycle,
} from "@/domain/graph";
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
import type { Choice, DayContext, FieldType, FlowEdge, Milestone, Step, Template, Value } from "@/domain/types";
import { isEmptyValue } from "@/domain/values";

const NOW = "2026-10-24T02:00:00.000Z";
const LATER = "2026-10-25T02:00:00.000Z";
const ctx: DayContext = { today: "2026-10-25", timeZone: "Asia/Singapore" };

/** mulberry32 */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (n: number) => Math.floor(next() * n),
    pick: <T,>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)],
    chance: (p: number) => next() < p,
  };
}
type R = ReturnType<typeof rng>;

const TYPES: FieldType[] = ["TEXT", "LONG_TEXT", "NUMBER", "PERCENT", "DATE", "DATE_RANGE", "DROPDOWN", "MULTIPLE", "CHECKBOX", "LINK", "FILE"];
const STATES = ["NOT_STARTED", "IN_PROGRESS", "WAITING", "BLOCKED", "DONE", "NOT_APPLICABLE"] as const;

function choicesFor(r: R, t: FieldType): Choice[] {
  if (t !== "DROPDOWN" && t !== "MULTIPLE") return [];
  const n = 2 + r.int(3);
  return Array.from({ length: n }, (_, i) => {
    const c: Choice = { id: `c${i}`, label: `Choice ${i}` };
    if (t === "DROPDOWN") c.state = r.pick(STATES);
    return c;
  });
}

function valueFor(r: R, s: Step): Value | null {
  const ids = s.choices.filter((c) => !c.archived).map((c) => c.id);
  switch (s.fieldType) {
    case "TEXT":
    case "LONG_TEXT":
      return r.chance(0.3) ? { text: "https://example.com/x" } : { text: `note ${r.int(100)}` };
    case "NUMBER":
      return { number: r.pick([0, 5, 50, 100, 3.5, 250]) };
    case "PERCENT":
      return { percent: r.pick([0, 1, 60, 100]) };
    case "DATE":
      return { date: r.pick(["2026-10-01", "2026-10-25", "2026-12-01"]) };
    case "DATE_RANGE":
      return { start: "2026-10-01", end: r.pick(["2026-10-20", "2027-01-01"]) };
    case "DROPDOWN":
      return ids.length ? { choiceId: r.pick(ids) } : null;
    case "MULTIPLE":
      return ids.length ? { choiceIds: ids.slice(0, 1 + r.int(ids.length)) } : null;
    case "CHECKBOX":
      return { checked: true };
    case "LINK":
      return { url: "https://example.com/doc" };
    case "FILE":
      return null;
  }
}

function milestone(id: string, order: number, r: R): Milestone {
  const fieldType = r.pick(TYPES);
  return {
    id,
    key: `key-${id}`,
    name: `Step ${id}`,
    description: "",
    fieldType,
    choices: choicesFor(r, fieldType),
    config: {},
    order,
    archived: false,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function counter(prefix: string) {
  let n = 0;
  return () => `${prefix}${++n}`;
}

function baseTemplate(r: R): Template {
  const n = 4 + r.int(5);
  const ids = Array.from({ length: n }, (_, i) => `m${i}`);
  const milestones = ids.map((id, i) => milestone(id, i + 1, r));
  let flow = {
    nodes: Object.fromEntries(ids.map((id, i) => [id, { x: i * 224, y: 0 }])),
    edges: ids.slice(1).map((id, i): FlowEdge => ({ id: `t-${ids[i]}-${id}`, from: ids[i], to: id, createdAt: NOW })),
  };
  // A few parallel branches.
  for (let k = 0; k < r.int(3); k++) {
    const a = r.int(n);
    const b = r.int(n);
    if (a < b) {
      const res = addEdge(flow, ids[a], ids[b], NOW, () => `t-${ids[a]}-${ids[b]}`);
      if (res.ok) flow = res.flow;
    }
  }
  return { milestones, flow, revision: 1 };
}

function createProject(t: Template): SyncProjectInput {
  const { steps, flow } = buildProjectSnapshot(t, NOW);
  const map = Object.fromEntries(steps.map((d) => [d.tempId, `s-${d.tempId}`]));
  return {
    steps: steps.map(({ tempId, ...rest }) => ({ ...rest, id: `s-${tempId}`, projectId: "p1", createdAt: NOW, updatedAt: NOW })),
    flow: remapFlow(flow, map),
    dismissed: {},
  };
}

function editProject(r: R, p0: SyncProjectInput): SyncProjectInput {
  let p = p0;
  p = {
    ...p,
    steps: p.steps.map((s) => {
      const out: Step = { ...s };
      if (r.chance(0.6)) out.value = valueFor(r, s);
      if (r.chance(0.1)) out.notApplicable = true;
      if (r.chance(0.1)) out.flag = r.pick(["WAITING", "BLOCKED"] as const);
      return out;
    }),
  };
  const ids = () => p.steps.filter((s) => !s.archived).map((s) => s.id);
  for (let k = 0; k < r.int(3); k++) {
    // Insert a project-only step after a random step; sometimes named like a future template step.
    const after = r.pick(ids());
    const id = `x${k}`;
    const fieldType = r.pick(TYPES);
    const s: Step = {
      id,
      projectId: "p1",
      name: r.chance(0.5) ? `Step n${k}` : `Own ${k}`,
      description: "",
      fieldType,
      choices: choicesFor(r, fieldType),
      config: {},
      value: null,
      notApplicable: false,
      flag: null,
      order: 10 + k,
      rev: 1,
      archived: false,
      createdAt: NOW,
      updatedAt: NOW,
    };
    if (r.chance(0.5)) s.value = valueFor(r, s);
    p = { ...p, steps: [...p.steps, s], flow: insertAfterInFlow(p.flow, after, id, { x: 0, y: 300 + k * 80 }, NOW, counter(`u${k}-`)) };
  }
  for (let k = 0; k < r.int(3); k++) {
    const live = p.flow.edges.filter((e) => !e.archivedAt);
    if (r.chance(0.5) && live.length) p = { ...p, flow: archiveEdge(p.flow, r.pick(live).id, NOW, "USER") };
    else {
      const res = addEdge(p.flow, r.pick(ids()), r.pick(ids()), NOW, counter(`d${k}-`));
      if (res.ok) p = { ...p, flow: res.flow };
    }
  }
  // Values that are invalid for their type (written under an earlier type, or edited by hand).
  if (r.chance(0.2)) {
    const id = r.pick(ids());
    p = { ...p, steps: p.steps.map((s) => (s.id === id ? { ...s, value: r.pick([{ text: "tbc" }, { date: "2026-02-30" }, { choiceId: "gone" }] as Value[]) } : s)) };
  }
  // Archive a project-only step (with reconnect), sometimes followed by Undo.
  const own = p.steps.filter((s) => !s.milestoneId && !s.archived);
  if (own.length && r.chance(0.3)) {
    const x = r.pick(own);
    const archived = archiveNodeInFlow(p.flow, x.id, { batchId: "PB", now: NOW, reconnect: r.chance(0.8), idFactory: counter("pb-") });
    p = { ...p, steps: p.steps.map((s) => (s.id === x.id ? { ...s, archived: true } : s)), flow: archived.flow };
    if (r.chance(0.5)) {
      const active = new Set(p.steps.filter((s) => s.id === x.id || !s.archived).map((s) => s.id));
      p = {
        ...p,
        steps: p.steps.map((s) => (s.id === x.id ? { ...s, archived: false } : s)),
        flow: restoreBatchInFlow(p.flow, "PB", active, NOW).flow,
      };
    }
  }
  return p;
}

function editTemplate(r: R, t0: Template): Template {
  let t = t0;
  const active = () => t.milestones.filter((m) => !m.archived);
  for (let k = 0; k < 1 + r.int(4); k++) {
    const op = r.int(10);
    if (op === 7 && active().length > 2) {
      // Archive a milestone, then Undo.
      const m = r.pick(active());
      const batchId = `U${k}`;
      const archived = archiveNodeInFlow(t.flow, m.id, { batchId, now: LATER, reconnect: true, idFactory: counter(`tu${k}-`) });
      const ids = new Set(active().map((x) => x.id));
      t = { ...t, flow: restoreBatchInFlow(archived.flow, batchId, ids, LATER).flow };
      continue;
    }
    if (op === 8) {
      // Retire a choice.
      const withChoices = active().filter((x) => x.choices.length > 1);
      if (!withChoices.length) continue;
      const m = r.pick(withChoices);
      const c = r.pick(m.choices);
      t = { ...t, milestones: t.milestones.map((x) => (x.id === m.id ? { ...x, choices: x.choices.map((y) => (y.id === c.id ? { ...y, archived: true } : y)) } : x)) };
      continue;
    }
    if (op === 9) {
      // Dropdown <-> Multiple.
      const m = active().find((x) => x.fieldType === "DROPDOWN" || x.fieldType === "MULTIPLE");
      if (!m) continue;
      const to: FieldType = m.fieldType === "DROPDOWN" ? "MULTIPLE" : "DROPDOWN";
      t = {
        ...t,
        milestones: t.milestones.map((x) =>
          x.id === m.id
            ? { ...x, fieldType: to, choices: x.choices.map((c) => (to === "DROPDOWN" ? { ...c, state: r.pick(STATES) } : { id: c.id, label: c.label })) }
            : x,
        ),
      };
      continue;
    }
    if (op === 0) {
      const after = r.pick(active());
      const m = milestone(`n${k}`, after.order + 0.5, r);
      if (r.chance(0.3)) m.name = `Own ${k}`; // may match a project-only step by name
      t = {
        ...t,
        milestones: [...t.milestones, m],
        flow: insertAfterInFlow(t.flow, after.id, m.id, { x: 0, y: 200 }, NOW, counter(`ti${k}-`)),
      };
    } else if (op === 1 && active().length > 2) {
      const m = r.pick(active());
      const { flow } = archiveNodeInFlow(t.flow, m.id, { batchId: `B${k}`, now: LATER, reconnect: r.chance(0.8), idFactory: counter(`tb${k}-`) });
      t = { ...t, milestones: t.milestones.map((x) => (x.id === m.id ? { ...x, archived: true } : x)), flow };
    } else if (op === 2) {
      const m = r.pick(active());
      t = { ...t, milestones: t.milestones.map((x) => (x.id === m.id ? { ...x, name: `${x.name}!`, config: { unit: "pcs" } } : x)) };
    } else if (op === 3) {
      const m = r.pick(active());
      const fieldType = r.pick(TYPES);
      t = {
        ...t,
        milestones: t.milestones.map((x) =>
          x.id === m.id ? { ...x, fieldType, choices: x.choices.length ? x.choices : choicesFor(r, fieldType) } : x,
        ),
      };
    } else if (op === 4) {
      const m = r.pick(active().filter((x) => x.choices.length) .concat(active()));
      t = {
        ...t,
        milestones: t.milestones.map((x) =>
          x.id === m.id
            ? {
                ...x,
                choices: [
                  ...x.choices.slice(1).map((c) => (r.chance(0.5) ? { ...c, label: `${c.label}*` } : c)),
                  { id: `c${9 + k}`, label: "New", ...(x.fieldType === "DROPDOWN" ? { state: r.pick(STATES) } : {}) },
                ],
              }
            : x,
        ),
      };
    } else if (op === 5) {
      const a = r.pick(active());
      const b = r.pick(active());
      const res = addEdge(t.flow, a.id, b.id, NOW, counter(`te${k}-`));
      if (res.ok) t = { ...t, flow: res.flow };
    } else {
      const live = t.flow.edges.filter((e) => !e.archivedAt);
      if (live.length) t = { ...t, flow: archiveEdge(t.flow, r.pick(live).id, LATER, "USER") };
    }
  }
  return { ...t, revision: t.revision + 1 };
}

function runSync(t: Template, p: SyncProjectInput, pick: (i: SyncItem) => boolean) {
  const ids = planSync(t, p, ctx).items.filter(pick).map((i) => i.id);
  const res = applySync(t, p, ids, ctx, LATER, counter("pe"));
  if (!res.ok) throw new Error(`STALE_PLAN ${res.missingIds.join(",")}`);
  const newStepIds = Object.fromEntries(res.result.newSteps.map((d) => [d.tempId, `s-${d.tempId}`]));
  return { project: mergeSyncResult(p, res.result, { newStepIds, projectId: "p1", now: LATER }), result: res.result };
}

function isAcyclic(edges: FlowEdge[]): boolean {
  const live = edges.filter((e) => !e.archivedAt);
  return live.every((e) => !wouldCreateCycle(live.filter((x) => x !== e), e.from, e.to));
}

/** FUZZ_DEBUG=<seed> prints the inputs, plan, result and re-plan of that seed. */
function debugDump(
  mode: string,
  t: Template,
  p: SyncProjectInput,
  plan: SyncPlan,
  result: SyncApplyResult,
  project: SyncProjectInput,
  again: SyncPlan,
) {
  const items = (pl: SyncPlan) => [
    ...pl.items.map((i) => `  ${i.kind} ${i.selectable ? (i.defaultChecked ? "[x]" : "[ ]") : "locked"} ${i.title} | ${i.detail}`),
    ...pl.warnings.map((w) => `  WARN ${w}`),
  ];
  const live = (f: { edges: FlowEdge[] }) =>
    f.edges
      .filter((e) => !e.archivedAt)
      .map((e) => `${e.from}>${e.to}`)
      .sort()
      .join(" ");
  console.log(
    [
      `--- ${mode}`,
      "template milestones:",
      ...t.milestones.map((m) => `  ${m.id} ${m.fieldType}${m.archived ? " ARCHIVED" : ""} ${m.name}`),
      `template edges: ${live(t.flow)}`,
      "project steps:",
      ...p.steps.map((s) => `  ${s.id} ${s.milestoneId ?? "-"} ${s.fieldType} ${s.name} ${JSON.stringify(s.value)} na=${s.notApplicable}`),
      `project edges before: ${live(p.flow)}`,
      "plan:",
      ...items(plan),
      `applied: ${result.appliedItemIds.join(", ")}`,
      `summary: ${result.summary.join(" / ")}`,
      `project edges after: ${live(project.flow)}`,
      "re-plan:",
      ...items(again),
    ].join("\n"),
  );
}

/** FUZZ_SEEDS=<n> runs more seeds locally (e.g. 5000). */
const SEEDS = Array.from({ length: Number(process.env.FUZZ_SEEDS ?? 400) }, (_, i) => i + 1);

describe("sync properties over random edits", () => {
  it.each(SEEDS)("seed %i", (seed) => {
    const r = rng(seed);
    const t0 = baseTemplate(r);
    let p = editProject(r, createProject(t0));
    const t = editTemplate(r, t0);

    // Sometimes the user declined some items earlier.
    if (r.chance(0.3)) {
      const first = planSync(t, p, ctx).items;
      const declined = first.filter(() => r.chance(0.3));
      p = { ...p, dismissed: Object.fromEntries(declined.map((i) => [dismissKeyOf(i.id), changeHashOf(i.id)])) };
    }

    const plan = planSync(t, p, ctx);
    // Item edges refer to project nodes, or to the milestone id of a node this plan adds.
    for (const i of plan.items) {
      for (const end of i.edge ? [i.edge.from, i.edge.to] : []) {
        expect(p.steps.some((s) => s.id === end && !s.archived) || plan.items.some((x) => x.kind === "addNode" && x.milestoneId === end)).toBe(true);
      }
    }

    // A random selection never fails, never clears a value and never makes a loop.
    {
      const { project } = runSync(t, p, (i) => i.selectable && r.chance(0.5));
      for (const before of p.steps) {
        const after = project.steps.find((s) => s.id === before.id)!;
        if (!isEmptyValue(before.fieldType, before.value)) expect(isEmptyValue(after.fieldType, after.value)).toBe(false);
        expect(after.flag).toBe(before.flag);
      }
      expect(isAcyclic(project.flow.edges)).toBe(true);
      for (const s of project.steps) if (!s.archived) expect(project.flow.nodes[s.id], `position of ${s.id}`).toBeDefined();
    }
    // Deterministic, unique ids.
    expect(planSync(t, p, ctx)).toEqual(plan);
    expect(new Set(plan.items.map((i) => i.id)).size).toBe(plan.items.length);
    expect(plan.items.every((i) => i.selectable || !i.defaultChecked)).toBe(true);

    for (const mode of ["all", "defaults"] as const) {
      const pick = mode === "all" ? (i: SyncItem) => i.selectable : (i: SyncItem) => i.defaultChecked;
      const { project, result } = runSync(t, p, pick);

      // Never clears a value, never touches flags; N/A only via markNA.
      for (const before of p.steps) {
        const after = project.steps.find((s) => s.id === before.id)!;
        if (!isEmptyValue(before.fieldType, before.value)) {
          expect(isEmptyValue(after.fieldType, after.value), `${mode}: value of ${before.id} cleared`).toBe(false);
        }
        expect(after.flag, `${mode}: flag of ${before.id}`).toBe(before.flag);
        if (!before.notApplicable && after.notApplicable) {
          expect(result.appliedItemIds.some((id) => id.startsWith(`markNA:${before.id}:`))).toBe(true);
        }
      }
      expect(isAcyclic(project.flow.edges), `${mode}: flow has a loop`).toBe(true);

      const again = planSync(t, project, ctx);
      if (process.env.FUZZ_DEBUG === String(seed)) debugDump(mode, t, p, plan, result, project, again);
      if (mode === "all") {
        expect(again.items.filter((i) => i.selectable).map((i) => i.title), "apply all leaves selectable items").toEqual([]);
      } else {
        const unchecked = plan.items.filter((i) => !i.defaultChecked).map((i) => i.id);
        expect(again.items.map((i) => i.id), "apply defaults leaves exactly the unchecked items").toEqual(unchecked);
        // Default sync never cuts the flow between steps the template still has.
        const kept = p.steps.filter((s) => !s.archived && (!s.milestoneId || t.milestones.some((m) => m.id === s.milestoneId && !m.archived)));
        for (const u of kept) {
          for (const w of kept) {
            if (u.id !== w.id && isReachable(p.flow.edges, u.id, w.id)) {
              expect(isReachable(project.flow.edges, u.id, w.id), `defaults cut ${u.id} -> ${w.id}`).toBe(true);
            }
          }
        }
      }
      // Idempotent: applying the same selection again changes nothing.
      const twice = runSync(t, project, pick);
      expect(twice.result.stepPatches).toEqual([]);
      expect(twice.result.newSteps).toEqual([]);
      expect(twice.project.flow).toEqual(project.flow);
    }
  });
});
