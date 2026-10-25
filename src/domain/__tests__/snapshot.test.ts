import { describe, expect, it } from "vitest";
import { buildProjectSnapshot, remapFlow } from "@/domain/snapshot";
import type { Choice, FlowEdge, Milestone, Template } from "@/domain/types";

const NOW = "2026-10-25T02:00:00.000Z";

function milestone(id: string, order: number, over: Partial<Milestone> = {}): Milestone {
  return {
    id,
    key: `key-${id}`,
    name: `Milestone ${id}`,
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
const edge = (id: string, from: string, to: string, extra: Partial<FlowEdge> = {}): FlowEdge => ({
  id,
  from,
  to,
  createdAt: NOW,
  ...extra,
});

const invoiceChoices: Choice[] = [
  { id: "not-applicable", label: "Not applicable", state: "NOT_APPLICABLE" },
  { id: "not-due", label: "Not due", state: "NOT_STARTED" },
  { id: "paid", label: "Paid", state: "DONE" },
  { id: "old", label: "Old option", state: "WAITING", archived: true },
];

function chainTemplate(n: number): Template {
  const milestones = Array.from({ length: n }, (_, i) =>
    milestone(`m${i + 1}`, i + 1, i % 3 === 0 ? { fieldType: "DROPDOWN", choices: invoiceChoices } : {}),
  );
  const edges = milestones.slice(1).map((m, i) => edge(`t${i + 1}`, milestones[i].id, m.id));
  const nodes = Object.fromEntries(milestones.map((m, i) => [m.id, { x: i * 224, y: 0 }]));
  return { milestones, flow: { nodes, edges }, revision: 7 };
}

describe("buildProjectSnapshot", () => {
  it("copies the 64-step chain as 64 steps and 63 linked edges with all choices", () => {
    const t = chainTemplate(64);
    const { steps, flow } = buildProjectSnapshot(t, NOW);
    expect(steps).toHaveLength(64);
    expect(flow.edges).toHaveLength(63);
    expect(Object.keys(flow.nodes)).toHaveLength(64);
    for (const [i, e] of flow.edges.entries()) {
      expect(e).toEqual({ id: `te:t${i + 1}`, from: `m${i + 1}`, to: `m${i + 2}`, createdAt: NOW, templateEdgeId: `t${i + 1}` });
    }
    const dropdown = steps.find((s) => s.tempId === "m1")!;
    expect(dropdown.choices).toEqual(invoiceChoices); // archived choice included, with its flag
    expect(dropdown.choices).not.toBe(invoiceChoices);
    expect(dropdown.choices[3]).not.toBe(invoiceChoices[3]);
  });

  it("creates empty drafts that carry the milestone definition", () => {
    const m = milestone("q", 4.5, {
      key: "quantity",
      name: "Quantity",
      description: "How many gates",
      fieldType: "NUMBER",
      config: { unit: "pcs" },
    });
    const t: Template = { milestones: [m], flow: { nodes: { q: { x: 5, y: 6 } }, edges: [] }, revision: 1 };
    const { steps, flow } = buildProjectSnapshot(t, NOW);
    expect(steps).toEqual([
      {
        tempId: "q",
        milestoneId: "q",
        milestoneKey: "quantity",
        name: "Quantity",
        description: "How many gates",
        fieldType: "NUMBER",
        choices: [],
        config: { unit: "pcs" },
        value: null,
        notApplicable: false,
        flag: null,
        order: 4.5,
        rev: 0,
        archived: false,
      },
    ]);
    expect(steps[0].config).not.toBe(m.config);
    expect(flow.nodes).toEqual({ q: { x: 5, y: 6 } });
  });

  it("skips archived milestones, archived edges and edges touching archived milestones", () => {
    const t: Template = {
      milestones: [milestone("a", 1), milestone("b", 2, { archived: true }), milestone("c", 3), milestone("d", 4)],
      flow: {
        nodes: { a: { x: 0, y: 0 }, b: { x: 1, y: 0 }, c: { x: 2, y: 0 }, d: { x: 3, y: 0 } },
        edges: [
          edge("ab", "a", "b"),
          edge("bc", "b", "c"),
          edge("ac", "a", "c"),
          edge("cd", "c", "d", { archivedAt: NOW, archivedReason: "USER" }),
          edge("ad", "a", "d"),
        ],
      },
      revision: 3,
    };
    const { steps, flow } = buildProjectSnapshot(t, NOW);
    expect(steps.map((s) => s.tempId)).toEqual(["a", "c", "d"]);
    expect(flow.edges.map((e) => e.templateEdgeId)).toEqual(["ac", "ad"]);
    expect(Object.keys(flow.nodes).sort()).toEqual(["a", "c", "d"]);
  });

  it("gives nodes without a template position a default position below the others, in order", () => {
    const t: Template = {
      milestones: [milestone("a", 1), milestone("c", 3), milestone("b", 2)],
      flow: { nodes: { a: { x: 100, y: 40 } }, edges: [] },
      revision: 1,
    };
    const { flow } = buildProjectSnapshot(t, NOW);
    expect(flow.nodes.a).toEqual({ x: 100, y: 40 });
    expect(flow.nodes.b).toEqual({ x: 0, y: 40 + 56 + 80 });
    expect(flow.nodes.c).toEqual({ x: 224, y: 40 + 56 + 80 });

    const none = buildProjectSnapshot({ ...t, flow: { nodes: {}, edges: [] } }, NOW).flow.nodes;
    expect(none).toEqual({ a: { x: 0, y: 0 }, b: { x: 224, y: 0 }, c: { x: 448, y: 0 } });
  });
});

describe("remapFlow", () => {
  it("rewrites node keys and edge ends, leaving unknown ids alone", () => {
    const flow = {
      nodes: { m1: { x: 1, y: 2 }, m2: { x: 3, y: 4 }, other: { x: 5, y: 6 } },
      edges: [edge("te:t1", "m1", "m2", { templateEdgeId: "t1" }), edge("u1", "m2", "other")],
    };
    const out = remapFlow(flow, { m1: "s1", m2: "s2" });
    expect(out.nodes).toEqual({ s1: { x: 1, y: 2 }, s2: { x: 3, y: 4 }, other: { x: 5, y: 6 } });
    expect(out.edges).toEqual([edge("te:t1", "s1", "s2", { templateEdgeId: "t1" }), edge("u1", "s2", "other")]);
    expect(flow.edges[0].from).toBe("m1"); // input untouched
  });
});
