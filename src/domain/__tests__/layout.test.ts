import { describe, expect, it } from "vitest";
import { autoLayout, NODE_HEIGHT, NODE_WIDTH, ranksPerRow } from "@/domain/layout";
import type { FlowEdge, Position } from "@/domain/types";

const e = (from: string, to: string, extra: Partial<FlowEdge> = {}): FlowEdge => ({
  id: `${from}-${to}`,
  from,
  to,
  createdAt: "2026-10-25T00:00:00.000Z",
  ...extra,
});

const chain = (n: number) => {
  const ids = Array.from({ length: n }, (_, i) => `n${i + 1}`);
  return { ids, edges: ids.slice(1).map((id, i) => e(ids[i], id)) };
};

function overlaps(pos: Record<string, Position>): string[] {
  const list = Object.entries(pos);
  const out: string[] = [];
  for (let i = 0; i < list.length; i++)
    for (let j = i + 1; j < list.length; j++) {
      const [a, p] = list[i];
      const [b, q] = list[j];
      if (Math.abs(p.x - q.x) < NODE_WIDTH && Math.abs(p.y - q.y) < NODE_HEIGHT) out.push(`${a}/${b}`);
    }
  return out;
}

describe("constants", () => {
  it("uses 184 x 56 cards", () => {
    expect([NODE_WIDTH, NODE_HEIGHT]).toEqual([184, 56]);
  });
});

describe("ranksPerRow", () => {
  it.each([
    [1600, 40, 12],
    [1440, 40, 11],
    [800, 40, 6],
    [300, 40, 4], // never fewer than 4
    [1600, 100, 10],
  ])("viewport %i, ranksep %i -> %i", (w, sep, expected) => {
    expect(ranksPerRow(w, sep)).toBe(expected);
  });
});

describe("autoLayout", () => {
  it("returns nothing for no nodes", () => {
    expect(autoLayout([], [])).toEqual({});
  });

  it("lays a chain out left to right, one rank per NODE_WIDTH + ranksep, starting at (0, 0)", () => {
    const { ids, edges } = chain(3);
    expect(autoLayout(ids, edges)).toEqual({ n1: { x: 0, y: 0 }, n2: { x: 224, y: 0 }, n3: { x: 448, y: 0 } });
    expect(autoLayout(ids, edges, { ranksep: 100 })).toEqual({
      n1: { x: 0, y: 0 },
      n2: { x: 284, y: 0 },
      n3: { x: 568, y: 0 },
    });
  });

  it("stacks parallel branches in the same column, nodesep apart", () => {
    const pos = autoLayout(["a", "b", "c", "d"], [e("a", "b"), e("a", "c"), e("b", "d"), e("c", "d")]);
    expect(pos.b.x).toBe(pos.c.x);
    expect(Math.abs(pos.b.y - pos.c.y)).toBe(NODE_HEIGHT + 24);
    expect(pos.a.x).toBeLessThan(pos.b.x);
    expect(pos.d.x).toBeGreaterThan(pos.b.x);
    expect(overlaps(pos)).toEqual([]);

    const wide = autoLayout(["a", "b", "c", "d"], [e("a", "b"), e("a", "c"), e("b", "d"), e("c", "d")], { nodesep: 50 });
    expect(Math.abs(wide.b.y - wide.c.y)).toBe(NODE_HEIGHT + 50);
  });

  it("ignores archived edges, self loops and edges to unknown nodes", () => {
    const pos = autoLayout(
      ["a", "b"],
      [e("a", "b", { archivedAt: "2026-10-25T00:00:00.000Z" }), e("a", "a"), e("a", "zz"), e("zz", "b")],
    );
    expect(pos.a.x).toBe(pos.b.x); // both rank 0
    expect(Object.keys(pos).sort()).toEqual(["a", "b"]);
  });

  it("is deterministic", () => {
    const { ids, edges } = chain(20);
    const extra = [...edges, e("n2", "n9"), e("n3", "n7")];
    expect(autoLayout(ids, extra, { wrap: true })).toEqual(autoLayout(ids, extra, { wrap: true }));
  });

  it.each([
    { viewportWidth: undefined, perRow: 12 },
    { viewportWidth: 1440, perRow: 11 },
    { viewportWidth: 500, perRow: 4 },
  ])("wraps the 64-step chain into rows of $perRow ranks (viewport $viewportWidth)", ({ viewportWidth, perRow }) => {
    const { ids, edges } = chain(64);
    const pos = autoLayout(ids, edges, { wrap: true, viewportWidth });
    expect(Object.keys(pos)).toHaveLength(64);
    ids.forEach((id, i) => {
      expect(pos[id]).toEqual({ x: (i % perRow) * (NODE_WIDTH + 40), y: Math.floor(i / perRow) * (NODE_HEIGHT + 80) });
    });
    expect(overlaps(pos)).toEqual([]);
  });

  it("wraps branching graphs without overlaps and keeps rows apart", () => {
    const { ids, edges } = chain(30);
    const more = [...ids, "b1", "b2", "b3"];
    const extra = [...edges, e("n3", "b1"), e("b1", "b2"), e("b2", "b3"), e("b3", "n20")];
    const pos = autoLayout(more, extra, { wrap: true, viewportWidth: 1000 });
    expect(overlaps(pos)).toEqual([]);
    expect(Math.min(...Object.values(pos).map((p) => p.x))).toBe(0);
    expect(Math.min(...Object.values(pos).map((p) => p.y))).toBe(0);
    // 1000 / (0.55 * 224) = 8.1 -> 8 ranks per row, so n9 (rank 8) starts the second row.
    expect(ranksPerRow(1000)).toBe(8);
    expect(pos.n9.y).toBeGreaterThan(pos.n8.y);
    expect(pos.n9.x).toBe(0);
  });
});
