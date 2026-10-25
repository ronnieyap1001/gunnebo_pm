import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { dismissKeyOf } from "@/domain/syncPlan";
import type { Choice } from "@/domain/types";
import { EV } from "@/server/services/context";
import { archiveMilestone, createMilestone, getTemplate, updateMilestone } from "@/server/services/library";
import { setStepValue } from "@/server/services/steps";
import { continueSync, listSyncTargets, previewSync, startSync, startSyncDefaults } from "@/server/services/sync";
import {
  activeEdgePairs,
  createProject,
  expectAppError,
  historyOfType,
  milestoneByKey,
  runSync,
  seedLibrary,
  stepByKey,
  stepsOf,
  world,
  type World,
} from "./_helpers";

let w: World;
let projectId: string;

beforeEach(async () => {
  w = world();
  await seedLibrary(w);
  projectId = await createProject(w);
});

const relabel = (choices: Choice[], id: string, patch: Partial<Choice>) => choices.map((c) => (c.id === id ? { ...c, ...patch } : c));

async function valuesById(): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const s of await stepsOf(w, projectId)) out[s.id] = s.value;
  return out;
}

describe("sync from template", () => {
  it("a fresh project has nothing to sync", async () => {
    const p = await previewSync(w.ctx(), projectId);
    expect(p.items).toEqual([]);
    expect(p.pendingCount).toBe(0);
  });

  it("applies template changes without touching values; new step spliced in; revision updated; re-preview empty", async () => {
    // Values entered before the template changes.
    const po = await stepByKey(w, projectId, "customer-po-loi");
    const bomStep = await stepByKey(w, projectId, "bom");
    const lessons = await stepByKey(w, projectId, "lessons-learned");
    await setStepValue(w.ctx(), { stepId: po.id, value: "awaiting", expectedRev: 0 });
    await setStepValue(w.ctx(), { stepId: bomStep.id, value: "requested", expectedRev: 0 });
    await setStepValue(w.ctx(), { stepId: lessons.id, value: "Check packing early", expectedRev: 0 });
    const valuesBefore = await valuesById();

    // Template changes.
    const bom = await milestoneByKey(w, "bom");
    const drawings = await milestoneByKey(w, "customer-drawings-approval");
    const audit = await createMilestone(w.ctx(), {
      name: "Factory audit",
      fieldType: "DROPDOWN",
      choices: [
        { label: "Planned", state: "IN_PROGRESS" },
        { label: "Passed", state: "DONE" },
      ],
      afterMilestoneId: bom.id,
    });
    const poM = await milestoneByKey(w, "customer-po-loi");
    await updateMilestone(w.ctx(), poM.id, { choices: relabel(poM.choices, "awaiting", { label: "Awaiting PO" }) }); // rename
    await updateMilestone(w.ctx(), bom.id, { choices: relabel(bom.choices, "requested", { state: "BLOCKED" }) }); // retag
    const offer = await milestoneByKey(w, "proposal-offer");
    await updateMilestone(w.ctx(), offer.id, { choices: [...offer.choices, { label: "On hold", state: "WAITING" }] }); // add
    const lessonsM = await milestoneByKey(w, "lessons-learned");
    await updateMilestone(w.ctx(), lessonsM.id, { fieldType: "LONG_TEXT" }); // lossless type change
    const template = await getTemplate(w.repo);

    // Preview.
    const preview = await previewSync(w.ctx(), projectId);
    const kinds = preview.items.map((i) => `${i.kind}:${i.milestoneId ?? ""}`);
    expect(kinds).toContain(`addNode:${audit.id}`);
    expect(kinds).toContain(`updateChoices:${poM.id}`);
    expect(kinds).toContain(`updateChoices:${bom.id}`);
    expect(kinds).toContain(`updateChoices:${offer.id}`);
    expect(kinds).toContain(`changeType:${lessonsM.id}`);
    expect(preview.items.filter((i) => i.kind === "addEdge")).toHaveLength(2);
    expect(preview.items.filter((i) => i.kind === "removeEdge")).toHaveLength(1);
    expect(preview.items.every((i) => i.defaultChecked && i.selectable && !i.dismissed)).toBe(true);
    expect(preview.pendingCount).toBe(preview.items.length);
    const retag = preview.items.find((i) => i.kind === "updateChoices" && i.milestoneId === bom.id)!;
    expect(retag.stateChange).toEqual({ from: "WAITING", to: "BLOCKED" });
    expect(preview.templateRevision).toBe(template.revision);

    // Apply through the job.
    const opId = randomUUID();
    const { total } = await startSync(w.ctx({ opId }), { projectId, selectedIds: preview.items.map((i) => i.id) });
    expect(total).toBeGreaterThan(1);
    let calls = 0;
    for (;;) {
      calls++;
      const r = await continueSync(w.ctx(), opId);
      if (r.done) break;
    }
    expect(calls).toBeGreaterThanOrEqual(1);
    // Done again is a no-op.
    const writes = w.repo.writeCount();
    expect((await continueSync(w.ctx(), opId)).done).toBe(true);
    expect(w.repo.writeCount()).toBe(writes);

    // Values never change.
    const valuesAfter = await valuesById();
    for (const [id, v] of Object.entries(valuesBefore)) expect(valuesAfter[id]).toEqual(v);

    // The new step and its arrows.
    const steps = await stepsOf(w, projectId);
    expect(steps).toHaveLength(65);
    const auditStep = steps.find((s) => s.milestoneId === audit.id)!;
    expect(auditStep).toMatchObject({ name: "Factory audit", value: null, stepKey: `${projectId}:${audit.id}` });
    const p = (await w.repo.projects.get(projectId))!;
    const pairs = activeEdgePairs(p.flow.edges);
    expect(pairs).toContain(`${bomStep.id}->${auditStep.id}`);
    expect(pairs).toContain(`${auditStep.id}->${(await stepByKey(w, projectId, "customer-drawings-approval")).id}`);
    expect(pairs).not.toContain(`${bomStep.id}->${(await stepByKey(w, projectId, "customer-drawings-approval")).id}`);
    expect(drawings).toBeTruthy();
    expect(p.flow.nodes[auditStep.id]).toBeTruthy();
    expect(p.cells[auditStep.id]).toMatchObject({ n: "Factory audit", m: audit.id });
    expect(Object.keys(p.cells)).toHaveLength(65);
    expect(p.templateRevision).toBe(template.revision);

    // Definitions followed the template.
    expect((await stepByKey(w, projectId, "customer-po-loi")).choices.find((c) => c.id === "awaiting")!.label).toBe("Awaiting PO");
    expect((await stepByKey(w, projectId, "bom")).choices.find((c) => c.id === "requested")!.state).toBe("BLOCKED");
    expect((await stepByKey(w, projectId, "proposal-offer")).choices.map((c) => c.label)).toContain("On hold");
    expect((await stepByKey(w, projectId, "lessons-learned"))).toMatchObject({ fieldType: "LONG_TEXT", value: { text: "Check packing early" } });
    // The retag recoloured the BOM cell.
    expect(p.cells[bomStep.id].ch).toEqual([{ id: "requested", label: "Requested", state: "BLOCKED" }]);

    // One History row, as SYSTEM.
    const rows = await historyOfType(w, EV.projectSynced);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: "SYSTEM", projectId, summary: `C0822 · Synced from template (${preview.items.length} changes)` });
    expect((rows[0].data as { appliedItemIds: string[] }).appliedItemIds.sort()).toEqual(preview.items.map((i) => i.id).sort());

    // Re-preview is empty.
    const again = await previewSync(w.ctx(), projectId);
    expect(again.items).toEqual([]);
    expect(again.pendingCount).toBe(0);
  });

  it("stores unticked items in syncDismissed; they come back only when the change itself changes", async () => {
    const poM = await milestoneByKey(w, "customer-po-loi");
    await updateMilestone(w.ctx(), poM.id, { choices: relabel(poM.choices, "awaiting", { label: "Awaiting PO" }) });
    const first = await previewSync(w.ctx(), projectId);
    expect(first.items).toHaveLength(1);
    const item = first.items[0];

    await runSync(w, projectId, []); // unticked
    let p = (await w.repo.projects.get(projectId))!;
    expect(Object.keys(p.syncDismissed)).toEqual([dismissKeyOf(item.id)]);
    expect(p.templateRevision).toBe((await getTemplate(w.repo)).revision);
    expect((await stepByKey(w, projectId, "customer-po-loi")).choices.find((c) => c.id === "awaiting")!.label).toBe("Awaiting");
    expect(await historyOfType(w, EV.projectSynced)).toHaveLength(1);

    // Still listed, but declined: unticked and not pending.
    const second = await previewSync(w.ctx(), projectId);
    expect(second.items).toHaveLength(1);
    expect(second.items[0]).toMatchObject({ id: item.id, dismissed: true, defaultChecked: false });
    expect(second.pendingCount).toBe(0);

    // An unrelated template change leaves the decline alone.
    const bom = await milestoneByKey(w, "bom");
    await updateMilestone(w.ctx(), bom.id, { description: "Bill of materials" });
    const third = await previewSync(w.ctx(), projectId);
    expect(third.items.find((i) => i.kind === "updateChoices")).toMatchObject({ dismissed: true, defaultChecked: false });
    expect(third.pendingCount).toBe(1); // only the description

    // The declined change itself changes: it comes back ticked.
    const po2 = await milestoneByKey(w, "customer-po-loi");
    await updateMilestone(w.ctx(), po2.id, { choices: relabel(po2.choices, "awaiting", { label: "Awaiting customer PO" }) });
    const fourth = await previewSync(w.ctx(), projectId);
    const back = fourth.items.find((i) => i.kind === "updateChoices")!;
    expect(back.id).not.toBe(item.id);
    expect(back).toMatchObject({ dismissed: false, defaultChecked: true });
    expect(fourth.pendingCount).toBe(2);

    // Applying it clears the old dismissal.
    await runSync(w, projectId, fourth.items.map((i) => i.id));
    p = (await w.repo.projects.get(projectId))!;
    expect(p.syncDismissed).toEqual({});
    expect((await previewSync(w.ctx(), projectId)).items).toEqual([]);
  });

  it("refuses a selection that is no longer in the plan (STALE_PLAN)", async () => {
    const poM = await milestoneByKey(w, "customer-po-loi");
    await updateMilestone(w.ctx(), poM.id, { choices: relabel(poM.choices, "awaiting", { label: "Awaiting PO" }) });
    const preview = await previewSync(w.ctx(), projectId);
    const po2 = await milestoneByKey(w, "customer-po-loi");
    await updateMilestone(w.ctx(), po2.id, { choices: relabel(po2.choices, "awaiting", { label: "Waiting for PO" }) });
    await expectAppError(startSync(w.ctx(), { projectId, selectedIds: preview.items.map((i) => i.id) }), "STALE_PLAN");
  });

  it("insert a milestone, sync, archive it, sync: the project returns to a -> b", async () => {
    const bom = await milestoneByKey(w, "bom");
    const before = activeEdgePairs((await w.repo.projects.get(projectId))!.flow.edges);
    const audit = await createMilestone(w.ctx(), { name: "Factory audit", fieldType: "DATE", afterMilestoneId: bom.id });
    await runSync(w, projectId, (await previewSync(w.ctx(), projectId)).items.map((i) => i.id));
    await archiveMilestone(w.ctx(), audit.id);
    const preview = await previewSync(w.ctx(), projectId);
    const markNA = preview.items.find((i) => i.kind === "markNA")!;
    expect(markNA.defaultChecked).toBe(false);
    await runSync(w, projectId, preview.items.filter((i) => i.defaultChecked).map((i) => i.id));
    const p = (await w.repo.projects.get(projectId))!;
    const auditStep = (await stepsOf(w, projectId)).find((s) => s.milestoneId === audit.id)!;
    const without = activeEdgePairs(p.flow.edges.filter((e) => e.from !== auditStep.id && e.to !== auditStep.id));
    expect(without).toEqual(before);
    expect(auditStep.archived).toBe(false); // template-derived steps are never archived by sync
  });

  it("an interrupted sync resumes without duplicate steps or patches", async () => {
    const milestones = await w.repo.milestones.list();
    // 12 new milestones (2 create batches) + 10 choice edits.
    for (let i = 0; i < 12; i++) await createMilestone(w.ctx(), { name: `Extra ${i}`, fieldType: "TEXT" });
    for (const m of milestones.filter((x) => x.fieldType === "DROPDOWN").slice(0, 10)) {
      await updateMilestone(w.ctx(), m.id, { choices: [...m.choices, { label: "Escalated", state: "BLOCKED" }] });
    }
    const preview = await previewSync(w.ctx(), projectId);
    const opId = randomUUID();
    await startSync(w.ctx({ opId }), { projectId, selectedIds: preview.items.filter((i) => i.defaultChecked).map((i) => i.id) });
    await continueSync(w.ctx(), opId); // first 8 creates
    let n = 0;
    w.repo.beforeWrite = (op) => {
      if (op === "steps.update" && ++n === 3) throw new Error("dropped");
    };
    // Second call: the remaining 4 creates + 4 patches, the third patch fails (the others are written).
    await expect(continueSync(w.ctx(), opId)).rejects.toThrow("dropped");
    w.repo.beforeWrite = null;
    for (let i = 0; i < 20; i++) if ((await continueSync(w.ctx(), opId)).done) break;
    const steps = await stepsOf(w, projectId);
    expect(steps).toHaveLength(76);
    expect(new Set(steps.map((s) => s.stepKey)).size).toBe(76);
    const revs = steps.filter((s) => s.choices.some((c) => c.label === "Escalated")).map((s) => s.rev);
    expect(revs).toHaveLength(10);
    expect(revs.every((r) => r === 1)).toBe(true); // each patch applied exactly once
    expect(await historyOfType(w, EV.projectSynced)).toHaveLength(1);
    expect((await previewSync(w.ctx(), projectId)).pendingCount).toBe(0);
  });

  it("sync-all defaults apply ticked items only and store nothing as declined", async () => {
    const other = await createProject(w, { code: "C0900", name: "Other" });
    const bom = await milestoneByKey(w, "bom");
    await createMilestone(w.ctx(), { name: "Factory audit", fieldType: "DATE", afterMilestoneId: bom.id });
    const targets = await listSyncTargets(w.repo);
    expect(targets.map((t) => t.code)).toEqual(["C0822", "C0900"]);
    expect(targets.every((t) => t.templateChanged)).toBe(true);
    for (const t of targets) {
      const opId = randomUUID();
      const r = await startSyncDefaults(w.ctx({ opId }), t.projectId);
      expect(r.itemCount).toBeGreaterThan(0);
      for (let i = 0; i < 20; i++) if ((await continueSync(w.ctx(), opId)).done) break;
    }
    for (const id of [projectId, other]) {
      const p = (await w.repo.projects.get(id))!;
      expect(p.syncDismissed).toEqual({});
      expect((await stepsOf(w, id))).toHaveLength(65);
    }
    expect((await listSyncTargets(w.repo)).every((t) => !t.templateChanged)).toBe(true);
  });
});
