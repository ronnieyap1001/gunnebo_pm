import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { EV } from "@/server/services/context";
import {
  addTemplateEdge,
  applyChoicesTo,
  archiveMilestone,
  archiveTemplateEdge,
  copyChoicesInto,
  createMilestone,
  getTemplate,
  layoutTemplate,
  moveTemplateNodes,
  reorderMilestone,
  restoreBatch,
  restoreMilestone,
  templateFlowOrder,
  updateMilestone,
} from "@/server/services/library";
import { activeEdgePairs, expectAppError, historyOfType, milestoneByKey, seedLibrary, world, type World } from "./_helpers";

let w: World;
beforeEach(async () => {
  w = world();
  await seedLibrary(w);
});

const revision = async () => (await getTemplate(w.repo)).revision;

describe("milestones", () => {
  it("createMilestone: slug key unique incl. archived, node below the graph, revision + 1, History", async () => {
    const r0 = await revision();
    const m = await createMilestone(w.ctx(), { name: "BOM", fieldType: "TEXT" });
    expect(m.key).toBe("bom-2");
    expect(m.order).toBe(65);
    const t = await getTemplate(w.repo);
    expect(t.revision).toBe(r0 + 1);
    const maxY = Math.max(...Object.entries(t.flow.nodes).filter(([id]) => id !== m.id).map(([, p]) => p.y));
    expect(t.flow.nodes[m.id].y).toBeGreaterThan(maxY);
    expect(t.flow.edges.some((e) => !e.archivedAt && (e.from === m.id || e.to === m.id))).toBe(false);
    const rows = await historyOfType(w, EV.milestoneCreated);
    expect(rows[0]).toMatchObject({ milestoneId: m.id, summary: 'Library · Added "BOM"' });
    expect(rows[0].projectId).toBeUndefined();

    // A key taken by an archived milestone is not reused.
    await archiveMilestone(w.ctx(), m.id);
    const again = await createMilestone(w.ctx(), { name: "BOM", fieldType: "TEXT" });
    expect(again.key).toBe("bom-3");
  });

  it("createMilestone after X inserts it into the chain (order halfway, arrows spliced)", async () => {
    const bom = await milestoneByKey(w, "bom");
    const next = await milestoneByKey(w, "customer-drawings-approval");
    const m = await createMilestone(w.ctx(), { name: "Factory audit", fieldType: "DATE", afterMilestoneId: bom.id });
    expect(m.order).toBe(bom.order + 0.5);
    const t = await getTemplate(w.repo);
    const pairs = activeEdgePairs(t.flow.edges);
    expect(pairs).toContain(`${bom.id}->${m.id}`);
    expect(pairs).toContain(`${m.id}->${next.id}`);
    expect(pairs).not.toContain(`${bom.id}->${next.id}`);
    const order = templateFlowOrder(t);
    expect(order.indexOf(m.id)).toBe(order.indexOf(bom.id) + 1);
  });

  it("validates choices: labels, unique ids, Dropdown states", async () => {
    await expectAppError(createMilestone(w.ctx(), { name: " ", fieldType: "TEXT" }), "VALIDATION");
    await expectAppError(createMilestone(w.ctx(), { name: "X", fieldType: "DROPDOWN", choices: [{ label: "A" }] }), "VALIDATION", /state/);
    await expectAppError(
      createMilestone(w.ctx(), { name: "X", fieldType: "DROPDOWN", choices: [{ label: "", state: "DONE" }] }),
      "VALIDATION",
    );
    const m = await createMilestone(w.ctx(), {
      name: "X",
      fieldType: "DROPDOWN",
      choices: [
        { label: "Open", state: "IN_PROGRESS" },
        { label: "Open", state: "DONE" },
      ],
    });
    expect(m.choices.map((c) => c.id)).toEqual(["open", "open-2"]);
  });

  it("updateMilestone: new choices get slug ids, left-out choices are archived (never removed), revision + 1", async () => {
    const po = await milestoneByKey(w, "customer-po-loi");
    const r0 = await revision();
    const updated = await updateMilestone(w.ctx(), po.id, {
      choices: [
        { id: "full-po", label: "Full PO", state: "DONE" },
        { id: "awaiting", label: "Awaiting PO", state: "WAITING" },
        { label: "Cancelled", state: "BLOCKED" },
      ],
    });
    expect(updated.choices.map((c) => [c.id, c.label, !!c.archived])).toEqual([
      ["full-po", "Full PO", false],
      ["awaiting", "Awaiting PO", false],
      ["cancelled", "Cancelled", false],
      ["loi-received", "LOI received", true],
      ["partial-po", "Partial PO", true],
      ["revised-po", "Revised PO", true],
    ]);
    expect(await revision()).toBe(r0 + 1);
    const row = (await historyOfType(w, EV.milestoneUpdated))[0];
    expect(row.summary).toMatch(/^Library · Updated "Customer PO \/ LOI": choices/);
    expect(row.data).toMatchObject({ old: { choices: po.choices } });

    // A choice can't take an archived choice's id.
    const again = await updateMilestone(w.ctx(), po.id, { choices: [...updated.choices, { label: "LOI received", state: "IN_PROGRESS" }] });
    expect(again.choices.filter((c) => c.label === "LOI received").map((c) => c.id)).toEqual(["loi-received", "loi-received-2"]);
  });

  it("renames log 'Renamed X to Y'; no change means no write", async () => {
    const bom = await milestoneByKey(w, "bom");
    await updateMilestone(w.ctx(), bom.id, { name: "Bill of materials" });
    expect((await historyOfType(w, EV.milestoneUpdated))[0]).toMatchObject({
      summary: 'Library · Renamed "BOM" to "Bill of materials"',
      oldDisplay: "BOM",
      newDisplay: "Bill of materials",
    });
    expect((await milestoneByKey(w, "bom")).key).toBe("bom"); // key never changes
    const writes = w.repo.writeCount();
    await updateMilestone(w.ctx(), bom.id, { name: "Bill of materials" });
    expect(w.repo.writeCount()).toBe(writes);
  });

  it("switching Multiple -> Dropdown gives choices without a state NOT_STARTED; choices stay when switching away", async () => {
    const docs = await milestoneByKey(w, "shipping-documents");
    expect(docs.fieldType).toBe("MULTIPLE");
    const asDropdown = await updateMilestone(w.ctx(), docs.id, { fieldType: "DROPDOWN" });
    expect(asDropdown.choices.every((c) => c.state === "NOT_STARTED")).toBe(true);
    const asText = await updateMilestone(w.ctx(), docs.id, { fieldType: "TEXT" });
    expect(asText.choices).toHaveLength(docs.choices.length);
  });

  it("applyChoicesTo copies labels/states by id and mints a new id on an archived collision", async () => {
    const adv = await milestoneByKey(w, "advance-invoice");
    const pre = await milestoneByKey(w, "pre-delivery-invoice");
    const arr = await milestoneByKey(w, "arrival-delivery-invoice");
    // pre has an archived "on-hold" id; adv gets a new choice with that id.
    await w.repo.milestones.update(pre.id, { choices: [...pre.choices, { id: "on-hold", label: "Parked", state: "WAITING", archived: true }] });
    await updateMilestone(w.ctx(), adv.id, {
      choices: [...adv.choices.map((c) => (c.id === "paid" ? { ...c, label: "Paid in full" } : c)), { label: "On hold", state: "WAITING" }],
    });
    const r0 = await revision();
    const { updatedIds } = await applyChoicesTo(w.ctx(), adv.id, [pre.id, arr.id]);
    expect(updatedIds.sort()).toEqual([pre.id, arr.id].sort());
    expect(await revision()).toBe(r0 + 1);
    const preAfter = await milestoneByKey(w, "pre-delivery-invoice");
    expect(preAfter.choices.find((c) => c.id === "paid")!.label).toBe("Paid in full");
    const onHold = preAfter.choices.filter((c) => c.label === "On hold");
    expect(onHold).toHaveLength(1);
    expect(onHold[0].id).not.toBe("on-hold");
    expect(preAfter.choices.find((c) => c.id === "on-hold")).toMatchObject({ label: "Parked", archived: true });
    const arrAfter = await milestoneByKey(w, "arrival-delivery-invoice");
    expect(arrAfter.choices.find((c) => c.label === "On hold")!.id).toBe("on-hold");
    expect(await historyOfType(w, EV.milestoneUpdated)).toHaveLength(2);
  });

  it("copyChoicesInto matches by label and archives what doesn't match", () => {
    const out = copyChoicesInto(
      [
        { id: "a", label: "Open", state: "IN_PROGRESS" },
        { id: "b", label: "Done", state: "DONE" },
      ],
      [
        { id: "x", label: "open", state: "NOT_STARTED" },
        { id: "y", label: "Gone", state: "BLOCKED" },
      ],
      "DROPDOWN",
    );
    expect(out).toEqual([
      { id: "x", label: "Open", state: "IN_PROGRESS" },
      { id: "b", label: "Done", state: "DONE" },
      { id: "y", label: "Gone", state: "BLOCKED", archived: true },
    ]);
  });

  it("reorderMilestone uses a fractional order, no revision bump, and says when arrows decide", async () => {
    const r0 = await revision();
    const bom = await milestoneByKey(w, "bom");
    const pm = await milestoneByKey(w, "pm-assigned");
    const r = await reorderMilestone(w.ctx(), bom.id, { afterId: pm.id });
    expect(r.milestone.order).toBe(2.5);
    expect(r.effective).toBe(false); // the chain decides the order
    expect(await revision()).toBe(r0);
    expect(await historyOfType(w, EV.milestoneReordered)).toHaveLength(1);
    // Two unconnected milestones: reorder is effective.
    const a = await createMilestone(w.ctx(), { name: "Loose A", fieldType: "TEXT" });
    const b = await createMilestone(w.ctx(), { name: "Loose B", fieldType: "TEXT" });
    const r2 = await reorderMilestone(w.ctx(), b.id, { beforeId: a.id });
    expect(r2.effective).toBe(true);
  });
});

describe("archive and restore", () => {
  it("archive with reconnect then restore returns the exact edge set", async () => {
    const before = await getTemplate(w.repo);
    const bom = await milestoneByKey(w, "bom");
    const { batchId, archivedEdgeIds, bridgeEdgeIds } = await archiveMilestone(w.ctx(), bom.id);
    expect(archivedEdgeIds).toHaveLength(2);
    expect(bridgeEdgeIds).toHaveLength(1);
    const mid = await getTemplate(w.repo);
    expect(mid.milestones.find((m) => m.id === bom.id)).toMatchObject({ archived: true, archiveBatch: batchId });
    expect(mid.revision).toBe(before.revision + 1);
    expect(activeEdgePairs(mid.flow.edges).some((p) => p.includes(bom.id))).toBe(false);
    expect(mid.flow.nodes[bom.id]).toEqual(before.flow.nodes[bom.id]); // position kept

    const r = await restoreBatch(w.ctx(), batchId);
    expect(r.restoredIds).toEqual([bom.id]);
    expect(r.skippedEdgeIds).toEqual([]);
    const after = await getTemplate(w.repo);
    const activeIds = (t: typeof after) => t.flow.edges.filter((e) => !e.archivedAt).map((e) => e.id).sort();
    expect(activeIds(after)).toEqual(activeIds(before));
    expect(activeEdgePairs(after.flow.edges)).toEqual(activeEdgePairs(before.flow.edges));
    const restored = after.milestones.find((m) => m.id === bom.id)!;
    expect(restored.archived).toBe(false);
    expect(restored.archivedAt).toBeUndefined();
    expect(restored.archiveBatch).toBeUndefined();
    expect(after.revision).toBe(before.revision + 2);
    expect(await historyOfType(w, EV.milestoneArchived)).toHaveLength(1);
    expect(await historyOfType(w, EV.milestoneRestored)).toHaveLength(1);
  });

  it("archive without reconnect leaves a gap; restoreMilestone restores via its batch", async () => {
    const bom = await milestoneByKey(w, "bom");
    const before = activeEdgePairs((await getTemplate(w.repo)).flow.edges);
    await archiveMilestone(w.ctx(), bom.id, { reconnect: false });
    expect(activeEdgePairs((await getTemplate(w.repo)).flow.edges)).toHaveLength(61);
    await restoreMilestone(w.ctx(), bom.id);
    expect(activeEdgePairs((await getTemplate(w.repo)).flow.edges)).toEqual(before);
  });

  it("archiving twice is harmless; restoring an unknown batch does nothing", async () => {
    const bom = await milestoneByKey(w, "bom");
    const a = await archiveMilestone(w.ctx(), bom.id);
    const b = await archiveMilestone(w.ctx(), bom.id);
    expect(b.batchId).toBe(a.batchId);
    expect((await restoreBatch(w.ctx(), randomUUID())).restoredIds).toEqual([]);
  });
});

describe("template flow", () => {
  it("adds and removes arrows (CYCLE, DUPLICATE), bumps the revision and logs", async () => {
    const pm = await milestoneByKey(w, "pm-assigned");
    const bom = await milestoneByKey(w, "bom");
    const r0 = await revision();
    const e = await addTemplateEdge(w.ctx(), pm.id, bom.id);
    expect(await revision()).toBe(r0 + 1);
    await expectAppError(addTemplateEdge(w.ctx(), pm.id, bom.id), "DUPLICATE");
    await expectAppError(addTemplateEdge(w.ctx(), bom.id, pm.id), "CYCLE", /loop/);
    await expectAppError(addTemplateEdge(w.ctx(), pm.id, pm.id), "CYCLE");
    await archiveTemplateEdge(w.ctx(), e.id);
    const t = await getTemplate(w.repo);
    expect(t.flow.edges.find((x) => x.id === e.id)).toMatchObject({ archivedReason: "USER" });
    expect(t.revision).toBe(r0 + 2);
    expect((await historyOfType(w, EV.templateEdgeAdded))[0].summary).toBe('Library · Arrow "PM assigned" → "BOM" added');
    expect(await historyOfType(w, EV.templateEdgeArchived)).toHaveLength(1);
  });

  it("moves and auto-layout don't bump the revision or log", async () => {
    const r0 = await revision();
    const rows = (await w.repo.history.listAll({ limit: 100 })).items.length;
    const pm = await milestoneByKey(w, "pm-assigned");
    await moveTemplateNodes(w.ctx(), { [pm.id]: { x: 1, y: 2 } });
    expect((await getTemplate(w.repo)).flow.nodes[pm.id]).toEqual({ x: 1, y: 2 });
    await layoutTemplate(w.ctx(), { wrap: true, viewportWidth: 1440 });
    expect(await revision()).toBe(r0);
    expect((await w.repo.history.listAll({ limit: 100 })).items.length).toBe(rows);
  });
});
