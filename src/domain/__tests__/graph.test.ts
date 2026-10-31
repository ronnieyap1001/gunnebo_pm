import { describe, expect, it } from "vitest";
import {
  activeEdges,
  addEdge,
  archiveEdge,
  archiveNodeInFlow,
  computeProgress,
  currentNodeIds,
  flowOrder,
  insertAfterInFlow,
  predecessorsOf,
  restoreBatchInFlow,
  successorsOf,
  wouldCreateCycle,
} from "@/domain/graph";
import type { EdgeArchiveReason, Flow, FlowEdge, State } from "@/domain/types";

const NOW = "2026-10-25T02:00:00.000Z";
const LATER = "2026-10-25T03:00:00.000Z";

function e(spec: string, extra: Partial<FlowEdge> = {}): FlowEdge {
  const [from, to] = spec.split(">");
  return { id: `${from}-${to}`, from, to, createdAt: NOW, ...extra };
}
const archived = (spec: string, reason: EdgeArchiveReason = "USER", extra: Partial<FlowEdge> = {}) =>
  e(spec, { archivedAt: NOW, archivedReason: reason, ...extra });

function flowOf(nodes: string[], edges: FlowEdge[]): Flow {
  return { nodes: Object.fromEntries(nodes.map((n, i) => [n, { x: i * 200, y: 0 }])), edges };
}

/** Active pairs, sorted: ['a>b', ...]. */
const pairs = (flow: Flow | FlowEdge[]) =>
  (Array.isArray(flow) ? flow : flow.edges)
    .filter((x) => !x.archivedAt)
    .map((x) => `${x.from}>${x.to}`)
    .sort();

function ids(prefix = "id") {
  let n = 0;
  return () => `${prefix}${++n}`;
}

describe("activeEdges / predecessorsOf / successorsOf", () => {
  const edges = [e("a>b"), e("a>c"), archived("a>d"), e("b>c"), { ...e("a>b"), id: "dup" }];
  it("ignores archived edges", () => {
    expect(activeEdges({ nodes: {}, edges }).map((x) => x.id)).toEqual(["a-b", "a-c", "b-c", "dup"]);
  });
  it("lists active neighbours once, in edge order", () => {
    expect(successorsOf(edges, "a")).toEqual(["b", "c"]);
    expect(predecessorsOf(edges, "c")).toEqual(["a", "b"]);
    expect(predecessorsOf(edges, "d")).toEqual([]);
    expect(successorsOf(edges, "zzz")).toEqual([]);
  });
});

describe("wouldCreateCycle", () => {
  const chain = [e("a>b"), e("b>c"), e("c>d")];
  it.each([
    ["self loop", chain, "a", "a", true],
    ["direct back edge", chain, "b", "a", true],
    ["indirect back edge", chain, "d", "a", true],
    ["forward shortcut", chain, "a", "d", false],
    ["unrelated node", chain, "x", "a", false],
    ["into a new node", chain, "d", "x", false],
    ["archived path does not count", [e("a>b"), archived("b>c"), e("c>d")], "d", "a", false],
    ["parallel branch merge", [e("a>b"), e("a>c"), e("b>d"), e("c>d")], "b", "c", false],
    ["branch back into root", [e("a>b"), e("a>c"), e("b>d"), e("c>d")], "d", "a", true],
  ] as const)("%s", (_name, edges, from, to, expected) => {
    expect(wouldCreateCycle([...edges], from, to)).toBe(expected);
  });
});

describe("flowOrder", () => {
  const n = (id: string, order: number, name = id.toUpperCase()) => ({ id, order, name });

  it.each([
    {
      name: "straight chain ignores library order",
      nodes: [n("a", 3), n("b", 2), n("c", 1)],
      edges: [e("a>b"), e("b>c")],
      expected: ["a", "b", "c"],
    },
    {
      name: "parallel branches interleave by order",
      nodes: [n("a", 1), n("b", 2), n("c", 3), n("b2", 4), n("c2", 5), n("d", 6)],
      edges: [e("a>b"), e("a>c"), e("b>b2"), e("c>c2"), e("b2>d"), e("c2>d")],
      expected: ["a", "b", "c", "b2", "c2", "d"],
    },
    {
      name: "merge waits for both branches",
      nodes: [n("a", 1), n("d", 2), n("b", 3), n("c", 4)],
      edges: [e("a>b"), e("a>c"), e("b>d"), e("c>d")],
      expected: ["a", "b", "c", "d"],
    },
    {
      name: "ties broken by name, then id",
      nodes: [n("z", 1, "Same"), n("y", 1, "Alpha"), n("x", 1, "Same")],
      edges: [],
      expected: ["y", "x", "z"],
    },
    {
      name: "archived edges and edges to unknown nodes are ignored",
      nodes: [n("a", 2), n("b", 1)],
      edges: [archived("a>b"), e("q>b"), e("b>q")],
      expected: ["b", "a"],
    },
    {
      name: "leftovers of a cycle are appended by order",
      nodes: [n("a", 1), n("b", 3), n("c", 2), n("r", 9)],
      edges: [e("a>b"), e("b>c"), e("c>b")],
      expected: ["a", "r", "c", "b"],
    },
  ])("$name", ({ nodes, edges, expected }) => {
    expect(flowOrder(nodes, edges)).toEqual(expected);
  });
});

describe("currentNodeIds (N/A is see-through)", () => {
  const S = (spec: Record<string, State>) => spec;
  it.each([
    {
      name: "A open -> B N/A -> C: only A is current",
      nodes: ["a", "b", "c"],
      edges: [e("a>b"), e("b>c")],
      states: S({ a: "IN_PROGRESS", b: "NOT_APPLICABLE", c: "NOT_STARTED" }),
      expected: ["a"],
    },
    {
      name: "A done -> B N/A -> C: C is current",
      nodes: ["a", "b", "c"],
      edges: [e("a>b"), e("b>c")],
      states: S({ a: "DONE", b: "NOT_APPLICABLE", c: "NOT_STARTED" }),
      expected: ["c"],
    },
    {
      name: "N/A root is see-through",
      nodes: ["a", "b"],
      edges: [e("a>b")],
      states: S({ a: "NOT_APPLICABLE", b: "WAITING" }),
      expected: ["b"],
    },
    {
      name: "parallel branches are both current",
      nodes: ["a", "b", "c", "d"],
      edges: [e("a>b"), e("a>c"), e("b>d"), e("c>d")],
      states: S({ a: "DONE", b: "IN_PROGRESS", c: "BLOCKED", d: "NOT_STARTED" }),
      expected: ["b", "c"],
    },
    {
      name: "merge needs every branch cleared",
      nodes: ["a", "b", "c", "d"],
      edges: [e("a>b"), e("a>c"), e("b>d"), e("c>d")],
      states: S({ a: "DONE", b: "DONE", c: "IN_PROGRESS", d: "NOT_STARTED" }),
      expected: ["c"],
    },
    {
      name: "merge with one branch N/A over done",
      nodes: ["a", "b", "c", "d"],
      edges: [e("a>b"), e("a>c"), e("b>d"), e("c>d")],
      states: S({ a: "DONE", b: "DONE", c: "NOT_APPLICABLE", d: "NOT_STARTED" }),
      expected: ["d"],
    },
    {
      name: "every open root is current; done and N/A nodes never are",
      nodes: ["r1", "r2", "r3", "r4"],
      edges: [],
      states: S({ r1: "NOT_STARTED", r2: "DONE", r3: "NOT_APPLICABLE", r4: "WAITING" }),
      expected: ["r1", "r4"],
    },
    {
      name: "missing state counts as not started; archived edges ignored; order of nodeIds kept",
      nodes: ["c", "b", "a"],
      edges: [archived("a>b"), e("a>c")],
      states: S({ a: "IN_PROGRESS" }),
      expected: ["b", "a"],
    },
    {
      name: "edges from nodes outside the list are ignored",
      nodes: ["b"],
      edges: [e("a>b")],
      states: S({ a: "IN_PROGRESS", b: "NOT_STARTED" }),
      expected: ["b"],
    },
  ])("$name", ({ nodes, edges, states, expected }) => {
    expect(currentNodeIds(nodes, states, edges)).toEqual(expected);
  });

  it("does not loop forever on a (forbidden) cycle", () => {
    const states = S({ a: "NOT_APPLICABLE", b: "NOT_APPLICABLE", c: "NOT_STARTED" });
    expect(currentNodeIds(["a", "b", "c"], states, [e("a>b"), e("b>a"), e("b>c")])).toEqual([]);
  });
});

describe("computeProgress", () => {
  it.each([
    { states: [] as State[], done: 0, applicable: 0, pct: 0 },
    { states: ["NOT_APPLICABLE", "NOT_APPLICABLE"] as State[], done: 0, applicable: 0, pct: 0 },
    { states: ["DONE", "NOT_STARTED", "IN_PROGRESS"] as State[], done: 1, applicable: 3, pct: 33 },
    { states: ["DONE", "DONE", "NOT_APPLICABLE"] as State[], done: 2, applicable: 2, pct: 100 },
    { states: ["DONE", "BLOCKED", "WAITING", "NOT_APPLICABLE", "DONE", "IN_PROGRESS"] as State[], done: 2, applicable: 5, pct: 40 },
  ])("$states.length states -> $pct %", ({ states, done, applicable, pct }) => {
    const p = computeProgress(states);
    expect(p).toMatchObject({ done, applicable, pct });
    expect(Object.values(p.counts).reduce((a, b) => a + b, 0)).toBe(states.length);
  });

  it("counts every state, zero-filled", () => {
    expect(computeProgress(["BLOCKED", "BLOCKED", "DONE"]).counts).toEqual({
      NOT_STARTED: 0,
      IN_PROGRESS: 0,
      WAITING: 0,
      BLOCKED: 2,
      DONE: 1,
      NOT_APPLICABLE: 0,
    });
  });

  it("58 of 64 applicable, 34 done", () => {
    const states: State[] = [...Array(34).fill("DONE"), ...Array(24).fill("NOT_STARTED"), ...Array(6).fill("NOT_APPLICABLE")];
    expect(computeProgress(states)).toMatchObject({ done: 34, applicable: 58, pct: 58 });
  });
});

describe("addEdge", () => {
  const base = flowOf(["a", "b", "c"], [e("a>b"), archived("b>c", "USER", { templateEdgeId: "t-bc", id: "keep-me" })]);

  it.each([
    ["self loop", "a", "a", "SELF"],
    ["unknown node", "a", "zz", "MISSING_NODE"],
    ["duplicate", "a", "b", "DUPLICATE"],
    ["loop", "b", "a", "CYCLE"],
  ] as const)("refuses a %s", (_n, from, to, reason) => {
    const r = addEdge(base, from, to, LATER, ids());
    expect(r).toEqual({ ok: false, reason });
  });

  it("adds a new edge with an id from the factory", () => {
    const r = addEdge(base, "a", "c", LATER, ids("new"));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.edge).toEqual({ id: "new1", from: "a", to: "c", createdAt: LATER });
    expect(pairs(r.flow)).toEqual(["a>b", "a>c"]);
    expect(base.edges).toHaveLength(2); // input untouched
  });

  it("restores an archived edge with the same pair (same id and templateEdgeId)", () => {
    const r = addEdge(base, "b", "c", LATER, ids());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.edge).toEqual({ id: "keep-me", from: "b", to: "c", createdAt: NOW, templateEdgeId: "t-bc" });
    expect(r.flow.edges).toHaveLength(2);
    expect(pairs(r.flow)).toEqual(["a>b", "b>c"]);
  });
});

describe("archiveEdge", () => {
  const base = flowOf(["a", "b"], [e("a>b"), archived("b>a", "SYNC")]);
  it("archives with time and reason", () => {
    const f = archiveEdge(base, "a-b", LATER, "INSERT_AFTER");
    expect(f.edges[0]).toMatchObject({ archivedAt: LATER, archivedReason: "INSERT_AFTER" });
  });
  it.each([["unknown", "nope"], ["already archived", "b-a"]])("leaves the flow unchanged for an %s edge", (_n, id) => {
    expect(archiveEdge(base, id, LATER, "USER")).toBe(base);
  });
});

describe("archiveNodeInFlow / restoreBatchInFlow", () => {
  const opts = (reconnect = true) => ({ batchId: "B1", now: LATER, reconnect, idFactory: ids("br") });

  it("archives touching edges and bridges predecessors to successors", () => {
    const f = flowOf(["a", "b", "c"], [e("a>b"), e("b>c")]);
    const r = archiveNodeInFlow(f, "b", opts());
    expect(r.archivedEdgeIds).toEqual(["a-b", "b-c"]);
    expect(r.flow.edges.find((x) => x.id === "a-b")).toMatchObject({
      archivedAt: LATER,
      archivedReason: "NODE_ARCHIVED",
      batchId: "B1",
    });
    expect(r.bridgeEdgeIds).toEqual(["br1"]);
    expect(r.flow.edges.find((x) => x.id === "br1")).toEqual({
      id: "br1",
      from: "a",
      to: "c",
      createdAt: LATER,
      createdByBatchId: "B1",
    });
    expect(pairs(r.flow)).toEqual(["a>c"]);
    expect(r.flow.nodes.b).toEqual(f.nodes.b); // position kept
  });

  it("does not bridge without reconnect", () => {
    const r = archiveNodeInFlow(flowOf(["a", "b", "c"], [e("a>b"), e("b>c")]), "b", opts(false));
    expect(r.bridgeEdgeIds).toEqual([]);
    expect(pairs(r.flow)).toEqual([]);
  });

  it("bridges every predecessor to every successor, skipping pairs that already exist", () => {
    const f = flowOf(["p1", "p2", "n", "s1", "s2"], [e("p1>n"), e("p2>n"), e("n>s1"), e("n>s2"), e("p1>s1")]);
    const r = archiveNodeInFlow(f, "n", opts());
    expect(r.bridgeEdgeIds).toHaveLength(3);
    expect(pairs(r.flow)).toEqual(["p1>s1", "p1>s2", "p2>s1", "p2>s2"]);
  });

  it("restores a system-archived same-pair edge as the bridge, but leaves an arrow the user removed alone", () => {
    const sys = flowOf(["a", "b", "c"], [e("a>b"), e("b>c"), archived("a>c", "SYNC", { templateEdgeId: "t-ac" })]);
    const r1 = archiveNodeInFlow(sys, "b", opts());
    expect(r1.bridgeEdgeIds).toEqual(["a-c"]);
    expect(r1.flow.edges.find((x) => x.id === "a-c")).toEqual({
      id: "a-c",
      from: "a",
      to: "c",
      createdAt: NOW,
      templateEdgeId: "t-ac",
      createdByBatchId: "B1",
    });

    const user = flowOf(["a", "b", "c"], [e("a>b"), e("b>c"), archived("a>c", "INSERT_AFTER")]);
    const r2 = archiveNodeInFlow(user, "b", opts());
    expect(r2.bridgeEdgeIds).toEqual(["br1"]);
    expect(r2.flow.edges.find((x) => x.id === "a-c")).toEqual(user.edges[2]);
  });

  const graphs: { name: string; nodes: string[]; edges: FlowEdge[]; node: string }[] = [
    { name: "chain", nodes: ["a", "b", "c"], edges: [e("a>b"), e("b>c")], node: "b" },
    {
      name: "diamond middle",
      nodes: ["a", "b", "c", "d"],
      edges: [e("a>b"), e("a>c"), e("b>d"), e("c>d")],
      node: "b",
    },
    {
      name: "bridge pair already present",
      nodes: ["a", "b", "c"],
      edges: [e("a>b"), e("b>c"), e("a>c")],
      node: "b",
    },
    {
      name: "user-removed pair",
      nodes: ["a", "b", "c"],
      edges: [e("a>b"), e("b>c"), archived("a>c", "INSERT_AFTER")],
      node: "b",
    },
    {
      name: "system-archived pair",
      nodes: ["a", "b", "c"],
      edges: [e("a>b"), e("b>c"), archived("a>c", "SYNC")],
      node: "b",
    },
    {
      name: "many to many",
      nodes: ["p1", "p2", "n", "s1", "s2"],
      edges: [e("p1>n"), e("p2>n"), e("n>s1"), e("n>s2")],
      node: "n",
    },
    { name: "root", nodes: ["a", "b"], edges: [e("a>b")], node: "a" },
  ];

  it.each(graphs)("archive + restore gives the identical active edge set ($name)", ({ nodes, edges, node }) => {
    const f = flowOf(nodes, edges);
    const archivedFlow = archiveNodeInFlow(f, node, opts()).flow;
    const r = restoreBatchInFlow(archivedFlow, "B1", new Set(nodes), "2026-10-25T04:00:00.000Z");
    expect(pairs(r.flow)).toEqual(pairs(f));
    expect(r.skippedEdgeIds).toEqual([]);
    // Edges that were active before are active again with the same ids.
    expect(r.flow.edges.filter((x) => !x.archivedAt).map((x) => x.id).sort()).toEqual(
      f.edges.filter((x) => !x.archivedAt).map((x) => x.id).sort(),
    );
    // Arrows the user removed keep their "removed by you" state exactly.
    for (const old of f.edges.filter((x) => x.archivedAt)) {
      const now = r.flow.edges.find((x) => x.id === old.id)!;
      if (old.archivedReason === "USER" || old.archivedReason === "INSERT_AFTER") expect(now).toEqual(old);
    }
    expect(r.flow.edges.some((x) => x.createdByBatchId === "B1")).toBe(false);
  });

  it.each(Array.from({ length: 300 }, (_, i) => i + 1))(
    "archive + restore gives the identical active edge set (random graph, seed %i)",
    (seed) => {
      // mulberry32
      let s = seed >>> 0;
      const rand = () => {
        s = (s + 0x6d2b79f5) >>> 0;
        let t = Math.imul(s ^ (s >>> 15), s | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      const int = (n: number) => Math.floor(rand() * n);
      const nodes = Array.from({ length: 3 + int(7) }, (_, i) => `n${i}`);
      let f = flowOf(nodes, []);
      const next = ids("e");
      for (let i = 0; i < nodes.length * 2; i++) {
        const [a, b] = [int(nodes.length), int(nodes.length)];
        const res = a < b ? addEdge(f, nodes[a], nodes[b], NOW, next) : null;
        if (res?.ok) f = res.flow;
      }
      const reasons: EdgeArchiveReason[] = ["USER", "INSERT_AFTER", "SYNC", "NODE_ARCHIVED", "IMPORT"];
      for (let i = int(4); i > 0; i--) {
        const live = f.edges.filter((x) => !x.archivedAt);
        if (live.length) f = archiveEdge(f, live[int(live.length)].id, NOW, reasons[int(reasons.length)]);
      }
      const archivedFlow = archiveNodeInFlow(f, nodes[int(nodes.length)], opts(rand() < 0.8));
      const r = restoreBatchInFlow(archivedFlow.flow, "B1", new Set(nodes), LATER);
      const activeIds = (fl: Flow) => fl.edges.filter((x) => !x.archivedAt).map((x) => x.id).sort();
      expect(activeIds(r.flow)).toEqual(activeIds(f));
      expect(r.skippedEdgeIds).toEqual([]);
      // Arrows archived before stay archived, unchanged unless they served as a bridge.
      for (const old of f.edges.filter((x) => x.archivedAt)) {
        const now = r.flow.edges.find((x) => x.id === old.id)!;
        expect(now.archivedAt).toBeDefined();
        if (!archivedFlow.bridgeEdgeIds.includes(old.id)) expect(now).toEqual(old);
      }
    },
  );

  it("reports removed bridges and restored edges", () => {
    const f = flowOf(["a", "b", "c"], [e("a>b"), e("b>c")]);
    const archivedFlow = archiveNodeInFlow(f, "b", opts()).flow;
    const r = restoreBatchInFlow(archivedFlow, "B1", new Set(["a", "b", "c"]), LATER);
    expect(r.removedBridgeIds).toEqual(["br1"]);
    expect(r.restoredEdgeIds).toEqual(["a-b", "b-c"]);
    expect(r.flow.edges.find((x) => x.id === "br1")).toMatchObject({ archivedReason: "NODE_ARCHIVED" });
    expect(r.flow.edges.find((x) => x.id === "a-b")).toEqual(e("a>b"));
  });

  it("skips edges whose other end is archived, and edges that would now make a loop", () => {
    const f = flowOf(["a", "b", "c"], [e("a>b"), e("b>c")]);
    const archivedFlow = archiveNodeInFlow(f, "b", opts(false)).flow;
    // c was archived meanwhile.
    const r1 = restoreBatchInFlow(archivedFlow, "B1", new Set(["a", "b"]), LATER);
    expect(r1.restoredEdgeIds).toEqual(["a-b"]);
    expect(r1.skippedEdgeIds).toEqual(["b-c"]);

    // While b was archived, the user drew c -> a; restoring a -> b -> c would close a loop.
    const withLoop: Flow = { ...archivedFlow, edges: [...archivedFlow.edges, e("c>a")] };
    const r2 = restoreBatchInFlow(withLoop, "B1", new Set(["a", "b", "c"]), LATER);
    expect(r2.restoredEdgeIds).toEqual(["a-b"]);
    expect(r2.skippedEdgeIds).toEqual(["b-c"]);
    expect(pairs(r2.flow)).toEqual(["a>b", "c>a"]);
  });
});

describe("insertAfterInFlow", () => {
  it("re-routes every outgoing arrow through the new node", () => {
    const f = flowOf(["a", "b", "c"], [e("a>b"), e("a>c")]);
    const r = insertAfterInFlow(f, "a", "n", { x: 10, y: 20 }, LATER, ids("x"));
    expect(pairs(r)).toEqual(["a>n", "n>b", "n>c"]);
    expect(r.edges.filter((x) => x.archivedAt).map((x) => [x.id, x.archivedReason])).toEqual([
      ["a-b", "INSERT_AFTER"],
      ["a-c", "INSERT_AFTER"],
    ]);
    expect(r.nodes.n).toEqual({ x: 10, y: 20 });
  });

  it("works on a leaf", () => {
    const r = insertAfterInFlow(flowOf(["a"], []), "a", "n", { x: 0, y: 0 }, LATER, ids("x"));
    expect(pairs(r)).toEqual(["a>n"]);
  });
});
