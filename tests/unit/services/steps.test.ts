import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { cellState } from "@/domain/cells";
import { EV } from "@/server/services/context";
import {
  addProjectEdge,
  addProjectStep,
  archiveProjectEdge,
  archiveProjectStep,
  bulkSetNotApplicable,
  confirmStepDate,
  layoutProject,
  moveProjectNodes,
  restoreProjectBatch,
  setStepFlag,
  setStepNotApplicable,
  setStepValue,
  updateStepDefinition,
} from "@/server/services/steps";
import { updateProject } from "@/server/services/projects";
import {
  activeEdgePairs,
  createProject,
  expectAppError,
  historyOfType,
  NOW,
  seedLibrary,
  stepByKey,
  stepsOf,
  TODAY,
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

const later = (minutes: number) => new Date(Date.parse(NOW) + minutes * 60_000).toISOString();

describe("setStepValue", () => {
  it("writes one History row with old/new display and state, and updates the project cell and progress", async () => {
    const po = await stepByKey(w, projectId, "customer-po-loi");
    const r = await setStepValue(w.ctx(), { stepId: po.id, value: "awaiting", expectedRev: 0 });
    expect(r.changed).toBe(true);
    expect(r.step).toMatchObject({ value: { choiceId: "awaiting" }, rev: 1, valueSetAt: NOW, lastChangedAt: NOW, stateChangedAt: NOW });

    const r2 = await setStepValue(w.ctx({ now: later(5) }), { stepId: po.id, value: { choiceId: "full-po" }, expectedRev: 1 });
    const rows = await historyOfType(w, EV.stepValueChanged);
    expect(rows).toHaveLength(2);
    const row = rows[0];
    expect(row).toMatchObject({
      projectId,
      stepId: po.id,
      milestoneKey: "customer-po-loi",
      summary: "C0822 · Customer PO / LOI: Awaiting → Full PO",
      oldDisplay: "Awaiting",
      newDisplay: "Full PO",
      source: "MANUAL",
      actor: "Me",
    });
    expect(row.data).toMatchObject({
      stepName: "Customer PO / LOI",
      milestoneKey: "customer-po-loi",
      old: { raw: { choiceId: "awaiting" }, display: "Awaiting", state: "WAITING" },
      new: { raw: { choiceId: "full-po" }, display: "Full PO", state: "DONE" },
    });

    const p = (await w.repo.projects.get(projectId))!;
    expect(p.cells[po.id]).toMatchObject({ v: { choiceId: "full-po" }, ch: [{ id: "full-po", state: "DONE" }] });
    expect(cellState(p.cells[po.id], { today: TODAY, timeZone: "Asia/Singapore" }).state).toBe("DONE");
    expect(p.progress).toBe(1);
    expect(r2.project.progress).toBe(1);
    expect(r2.project.cells[po.id]).toEqual(p.cells[po.id]);
  });

  it("clears the flag when the value becomes Done (noted in History)", async () => {
    const bom = await stepByKey(w, projectId, "bom");
    const f = await setStepFlag(w.ctx(), { stepId: bom.id, flag: "BLOCKED", reason: "PE on leave", expectedRev: 0 });
    expect(f.step.flag).toBe("BLOCKED");
    const r = await setStepValue(w.ctx(), { stepId: bom.id, value: "released", expectedRev: f.step.rev });
    expect(r.flagCleared).toBe(true);
    expect(r.step.flag).toBeNull();
    const row = (await historyOfType(w, EV.stepValueChanged))[0];
    expect(row.summary).toContain("(flag cleared)");
    expect(row.data).toMatchObject({ flagCleared: "BLOCKED", old: { state: "BLOCKED" }, new: { state: "DONE" } });
  });

  it("keeps the flag when the value is not Done", async () => {
    const bom = await stepByKey(w, projectId, "bom");
    const f = await setStepFlag(w.ctx(), { stepId: bom.id, flag: "WAITING", expectedRev: 0 });
    const r = await setStepValue(w.ctx(), { stepId: bom.id, value: "requested", expectedRev: f.step.rev });
    expect(r.step.flag).toBe("WAITING");
    expect(r.flagCleared).toBeUndefined();
  });

  it("changes stateChangedAt only when the derived state changes", async () => {
    const po = await stepByKey(w, projectId, "customer-po-loi");
    const a = await setStepValue(w.ctx({ now: later(1) }), { stepId: po.id, value: "loi-received", expectedRev: 0 }); // IP
    expect(a.step.stateChangedAt).toBe(later(1));
    const b = await setStepValue(w.ctx({ now: later(2) }), { stepId: po.id, value: "partial-po", expectedRev: 1 }); // IP again
    expect(b.step.stateChangedAt).toBe(later(1));
    expect(b.step.lastChangedAt).toBe(later(2));
    expect(b.step.valueSetAt).toBe(later(2));
    const c = await setStepValue(w.ctx({ now: later(3) }), { stepId: po.id, value: "full-po", expectedRev: 2 }); // DONE
    expect(c.step.stateChangedAt).toBe(later(3));
  });

  it("refuses a stale expectedRev with CONFLICT", async () => {
    const po = await stepByKey(w, projectId, "customer-po-loi");
    await setStepValue(w.ctx(), { stepId: po.id, value: "awaiting", expectedRev: 0 });
    await expectAppError(
      setStepValue(w.ctx(), { stepId: po.id, value: "full-po", expectedRev: 0 }),
      "CONFLICT",
      /This milestone changed elsewhere; reloaded/,
    );
  });

  it("a repeated opId writes nothing a second time", async () => {
    const po = await stepByKey(w, projectId, "customer-po-loi");
    const opId = randomUUID();
    await setStepValue(w.ctx({ opId }), { stepId: po.id, value: "awaiting", expectedRev: 0 });
    const writes = w.repo.writeCount();
    // The retry carries the original expectedRev; it must not conflict and must not write.
    const again = await setStepValue(w.ctx({ opId }), { stepId: po.id, value: "awaiting", expectedRev: 0 });
    expect(again.changed).toBe(false);
    expect(again.step.rev).toBe(1);
    expect(w.repo.writeCount()).toBe(writes);
    expect(await historyOfType(w, EV.stepValueChanged)).toHaveLength(1);
  });

  it("a retry after a crash between the step write and History completes the row once", async () => {
    const po = await stepByKey(w, projectId, "customer-po-loi");
    const opId = randomUUID();
    w.repo.beforeWrite = (op) => {
      if (op === "history.append") throw new Error("crash");
    };
    await expect(setStepValue(w.ctx({ opId }), { stepId: po.id, value: "awaiting", expectedRev: 0 })).rejects.toThrow("crash");
    w.repo.beforeWrite = null;
    await setStepValue(w.ctx({ opId }), { stepId: po.id, value: "awaiting", expectedRev: 0 });
    await setStepValue(w.ctx({ opId }), { stepId: po.id, value: "awaiting", expectedRev: 0 });
    const rows = await historyOfType(w, EV.stepValueChanged);
    expect(rows).toHaveLength(1);
    expect(rows[0].data).toMatchObject({ resumed: true, new: { display: "Awaiting" } });
    expect((await w.repo.steps.get(po.id))!.rev).toBe(1);
  });

  it("the same value is a no-op", async () => {
    const po = await stepByKey(w, projectId, "customer-po-loi");
    await setStepValue(w.ctx(), { stepId: po.id, value: "awaiting", expectedRev: 0 });
    const writes = w.repo.writeCount();
    const r = await setStepValue(w.ctx(), { stepId: po.id, value: { choiceId: "awaiting" }, expectedRev: 1 });
    expect(r.changed).toBe(false);
    expect(w.repo.writeCount()).toBe(writes);
  });

  it("derives date states from ctx.day (planned, reached, passed by itself)", async () => {
    const fat = await stepByKey(w, projectId, "fat-date");
    const planned = await setStepValue(w.ctx(), { stepId: fat.id, value: "2026-11-12", expectedRev: 0 });
    const cell = () => w.repo.projects.get(projectId).then((p) => p!.cells[fat.id]);
    expect(cellState(await cell(), { today: TODAY, timeZone: "Asia/Singapore" })).toEqual({ state: "IN_PROGRESS", reason: "DATE_PLANNED" });
    expect((await historyOfType(w, EV.stepValueChanged))[0].data).toMatchObject({ new: { state: "IN_PROGRESS", display: "12 Nov 2026" } });
    // The same cell on a later day: green, with the clock marker.
    expect(cellState(await cell(), { today: "2026-11-12", timeZone: "Asia/Singapore" })).toEqual({ state: "DONE", reason: "DATE_PASSED_AUTO" });

    // A context whose day is after the date: the write itself derives DONE.
    const done = await setStepValue(w.ctx({ today: "2026-11-20" }), { stepId: fat.id, value: "2026-11-13", expectedRev: planned.step.rev });
    expect((await historyOfType(w, EV.stepValueChanged))[0].data).toMatchObject({ old: { state: "DONE" }, new: { state: "DONE" } });
    // Seen from the 20th the old date was already Done, so the state did not change and stateChangedAt stays.
    expect(done.step.stateChangedAt).toBe(NOW);
  });

  it("validates input: bad dates, unknown choices, retired choices, File fields", async () => {
    const fat = await stepByKey(w, projectId, "fat-date");
    await expectAppError(setStepValue(w.ctx(), { stepId: fat.id, value: "31/02/2026", expectedRev: 0 }), "VALIDATION");
    const po = await stepByKey(w, projectId, "customer-po-loi");
    await expectAppError(setStepValue(w.ctx(), { stepId: po.id, value: "nope", expectedRev: 0 }), "VALIDATION");
    await w.repo.steps.update(po.id, { choices: po.choices.map((c) => (c.id === "revised-po" ? { ...c, archived: true } : c)) });
    await expectAppError(setStepValue(w.ctx(), { stepId: po.id, value: "revised-po", expectedRev: 0 }), "VALIDATION", /retired/);
    const ins = await stepByKey(w, projectId, "installation-progress");
    await expectAppError(setStepValue(w.ctx(), { stepId: ins.id, value: 101, expectedRev: 0 }), "VALIDATION");
    const ok = await setStepValue(w.ctx(), { stepId: ins.id, value: "60", expectedRev: 0 });
    expect(ok.step.value).toEqual({ percent: 60 });
    await expectAppError(setStepValue(w.ctx(), { stepId: "missing", value: 1, expectedRev: 0 }), "NOT_FOUND");
  });

  it("suggests closing the project when 'Project closed' gets a date on or before today", async () => {
    const closed = await stepByKey(w, projectId, "project-closed");
    const r = await setStepValue(w.ctx(), { stepId: closed.id, value: TODAY, expectedRev: 0 });
    expect(r.suggestClose).toBe(true);
    await updateProject(w.ctx(), projectId, { status: "CLOSED" });
    const r2 = await setStepValue(w.ctx(), { stepId: closed.id, value: "2026-10-01", expectedRev: 1 });
    expect(r2.suggestClose).toBe(false);
    const fat = await stepByKey(w, projectId, "fat-date");
    expect((await setStepValue(w.ctx(), { stepId: fat.id, value: TODAY, expectedRev: 0 })).suggestClose).toBe(false);
  });
});

describe("N/A, flags, confirm", () => {
  it("setStepNotApplicable toggles N/A, logs once and excludes the step from progress", async () => {
    const po = await stepByKey(w, projectId, "customer-po-loi");
    const r = await setStepNotApplicable(w.ctx(), { stepId: po.id, notApplicable: true, expectedRev: 0 });
    expect(r.step).toMatchObject({ notApplicable: true, rev: 1, stateChangedAt: NOW });
    const p = (await w.repo.projects.get(projectId))!;
    expect(p.cells[po.id].na).toBe(true);
    const row = (await historyOfType(w, EV.stepNaChanged))[0];
    expect(row.data).toMatchObject({ old: { state: "NOT_STARTED" }, new: { state: "NOT_APPLICABLE" } });
    expect((await setStepNotApplicable(w.ctx(), { stepId: po.id, notApplicable: true, expectedRev: 1 })).changed).toBe(false);
    await expectAppError(setStepNotApplicable(w.ctx(), { stepId: po.id, notApplicable: false, expectedRev: 0 }), "CONFLICT");
  });

  it("setStepFlag saves the reason as a note and writes one row", async () => {
    const bom = await stepByKey(w, projectId, "bom");
    const r = await setStepFlag(w.ctx(), { stepId: bom.id, flag: "BLOCKED", reason: "Waiting for PE" });
    expect(r.noteId).toBeTruthy();
    const notes = await w.repo.notes.listByProject(projectId);
    expect(notes).toMatchObject([{ stepId: bom.id, body: "Blocked: Waiting for PE", author: "Me" }]);
    const rows = await historyOfType(w, EV.stepFlagChanged);
    expect(rows).toHaveLength(1);
    expect(rows[0].data).toMatchObject({ newFlag: "BLOCKED", reason: "Waiting for PE", noteId: r.noteId });
    expect(await historyOfType(w, EV.noteAdded)).toHaveLength(0);
    const cleared = await setStepFlag(w.ctx(), { stepId: bom.id, flag: null, expectedRev: r.step.rev });
    expect(cleared.step.flag).toBeNull();
    await expectAppError(setStepFlag(w.ctx(), { stepId: bom.id, flag: "LATE" as never }), "VALIDATION");
  });

  it("confirmStepDate clears the clock marker of a date that passed by itself", async () => {
    const fat = await stepByKey(w, projectId, "fat-date");
    await setStepValue(w.ctx(), { stepId: fat.id, value: "2026-11-12", expectedRev: 0 });
    const lateCtx = w.ctx({ today: "2026-11-15", now: "2026-11-15T03:00:00.000Z" });
    const r = await confirmStepDate(lateCtx, fat.id);
    expect(r.changed).toBe(true);
    expect(r.step.valueSetAt).toBe("2026-11-15T03:00:00.000Z");
    const p = (await w.repo.projects.get(projectId))!;
    expect(cellState(p.cells[fat.id], { today: "2026-11-15", timeZone: "Asia/Singapore" }).reason).toBe("DATE_REACHED");
    expect((await confirmStepDate(lateCtx, fat.id)).changed).toBe(false);
    expect(await historyOfType(w, EV.stepDateConfirmed)).toHaveLength(1);
  });
});

describe("bulkSetNotApplicable", () => {
  it("marks many steps in one project patch and ONE History row relating to all steps", async () => {
    const steps = (await stepsOf(w, projectId)).slice(0, 5);
    const projectWrites = () => w.repo.writeCount();
    const before = projectWrites();
    const r = await bulkSetNotApplicable(w.ctx(), { projectId, stepIds: steps.map((s) => s.id), notApplicable: true });
    expect(r.changedIds.sort()).toEqual(steps.map((s) => s.id).sort());
    // 5 step patches + 1 project patch + 1 history row
    expect(projectWrites() - before).toBe(7);
    const rows = await historyOfType(w, EV.stepNaChanged);
    expect(rows).toHaveLength(1);
    expect((rows[0].data as { stepIds: string[] }).stepIds.sort()).toEqual(steps.map((s) => s.id).sort());
    expect(rows[0].summary).toMatch(/^C0822 · 5 milestones marked not applicable/);
    // The row shows up in each step's history.
    for (const s of steps) expect((await w.repo.history.listByStep(s.id)).items.map((e) => e.id)).toContain(rows[0].id);
    const p = (await w.repo.projects.get(projectId))!;
    for (const s of steps) expect(p.cells[s.id].na).toBe(true);
  });

  it("is idempotent per opId and limited to 16 steps per call", async () => {
    const steps = await stepsOf(w, projectId);
    const opId = randomUUID();
    await bulkSetNotApplicable(w.ctx({ opId }), { projectId, stepIds: steps.slice(0, 3).map((s) => s.id), notApplicable: true });
    const writes = w.repo.writeCount();
    const again = await bulkSetNotApplicable(w.ctx({ opId }), { projectId, stepIds: steps.slice(0, 3).map((s) => s.id), notApplicable: true });
    expect(again.changedIds).toEqual([]);
    expect(w.repo.writeCount()).toBe(writes);
    await expectAppError(
      bulkSetNotApplicable(w.ctx(), { projectId, stepIds: steps.slice(0, 17).map((s) => s.id), notApplicable: true }),
      "VALIDATION",
    );
  });
});

describe("project-only steps and the project flow", () => {
  it("adds a project-only step after another (arrows spliced), archives it with reconnect and restores the exact edges", async () => {
    const bom = await stepByKey(w, projectId, "bom");
    const before = activeEdgePairs((await w.repo.projects.get(projectId))!.flow.edges);
    const opId = randomUUID();
    const added = await addProjectStep(w.ctx({ opId }), { projectId, name: "Factory visit", fieldType: "DATE", afterStepId: bom.id });
    // Retrying the same op does not add a second step.
    await addProjectStep(w.ctx({ opId }), { projectId, name: "Factory visit", fieldType: "DATE", afterStepId: bom.id });
    expect((await stepsOf(w, projectId)).filter((s) => s.name === "Factory visit")).toHaveLength(1);
    expect(await historyOfType(w, EV.stepAdded)).toHaveLength(1);

    const s = added.step;
    expect(s.milestoneId).toBeUndefined();
    expect(s).toMatchObject({ projectId, stepKey: `${projectId}:${opId}` });
    let p = (await w.repo.projects.get(projectId))!;
    expect(p.cells[s.id]).toMatchObject({ n: "Factory visit", t: "DATE" });
    const succ = p.flow.edges.filter((e) => !e.archivedAt && e.from === s.id).map((e) => e.to);
    expect(succ).toHaveLength(1);
    expect(p.flow.edges.some((e) => !e.archivedAt && e.from === bom.id && e.to === s.id)).toBe(true);
    expect(p.flow.edges.some((e) => !e.archivedAt && e.from === bom.id && e.to === succ[0])).toBe(false);
    const withStep = activeEdgePairs(p.flow.edges);

    const { batchId } = await archiveProjectStep(w.ctx(), s.id);
    p = (await w.repo.projects.get(projectId))!;
    expect(p.cells[s.id]).toBeUndefined();
    expect(activeEdgePairs(p.flow.edges)).toEqual(before); // reconnected bom -> next
    expect((await w.repo.steps.get(s.id))!).toMatchObject({ archived: true, archiveBatch: batchId });

    const restored = await restoreProjectBatch(w.ctx(), projectId, batchId);
    expect(restored.restoredIds).toEqual([s.id]);
    p = (await w.repo.projects.get(projectId))!;
    expect(activeEdgePairs(p.flow.edges)).toEqual(withStep);
    expect(p.cells[s.id]).toBeTruthy();
    expect(await historyOfType(w, EV.stepArchived)).toHaveLength(1);
    expect(await historyOfType(w, EV.stepRestored)).toHaveLength(1);
  });

  it("template-derived steps can't be archived or redefined (FORBIDDEN)", async () => {
    const bom = await stepByKey(w, projectId, "bom");
    await expectAppError(archiveProjectStep(w.ctx(), bom.id), "FORBIDDEN", /Not applicable/);
    await expectAppError(updateStepDefinition(w.ctx(), bom.id, { name: "Bill" }), "FORBIDDEN");
  });

  it("updateStepDefinition converts values losslessly, refuses lossy changes unless clearValue", async () => {
    const added = await addProjectStep(w.ctx(), { projectId, name: "Remarks", fieldType: "TEXT" });
    const v = await setStepValue(w.ctx(), { stepId: added.step.id, value: "https://example.com/x", expectedRev: 0 });
    const r = await updateStepDefinition(w.ctx(), added.step.id, { fieldType: "LINK" }, { expectedRev: v.step.rev });
    expect(r.step).toMatchObject({ fieldType: "LINK", value: { url: "https://example.com/x" } });
    await expectAppError(updateStepDefinition(w.ctx(), added.step.id, { fieldType: "NUMBER" }), "VALIDATION", /Clear the value first/);
    const cleared = await updateStepDefinition(w.ctx(), added.step.id, { fieldType: "NUMBER" }, { clearValue: true });
    expect(cleared.step).toMatchObject({ fieldType: "NUMBER", value: null });
    const row = (await historyOfType(w, EV.stepUpdated))[0];
    expect(row.data).toMatchObject({ old: { display: "example.com" }, new: { display: "—" } });
  });

  it("draws and removes project arrows (CYCLE / DUPLICATE) with History", async () => {
    const a = await stepByKey(w, projectId, "pm-assigned");
    const b = await stepByKey(w, projectId, "bom");
    const e = await addProjectEdge(w.ctx(), projectId, a.id, b.id);
    expect(e).toMatchObject({ from: a.id, to: b.id });
    await expectAppError(addProjectEdge(w.ctx(), projectId, a.id, b.id), "DUPLICATE");
    await expectAppError(addProjectEdge(w.ctx(), projectId, b.id, a.id), "CYCLE", /loop/);
    await archiveProjectEdge(w.ctx(), projectId, e.id);
    const p = (await w.repo.projects.get(projectId))!;
    expect(p.flow.edges.find((x) => x.id === e.id)).toMatchObject({ archivedReason: "USER" });
    expect(await historyOfType(w, EV.edgeAdded)).toHaveLength(1);
    expect(await historyOfType(w, EV.edgeArchived)).toHaveLength(1);
  });

  it("moves and lays out nodes without History", async () => {
    const a = await stepByKey(w, projectId, "pm-assigned");
    const rows = (await w.repo.history.listAll({ limit: 100 })).items.length;
    await moveProjectNodes(w.ctx(), projectId, { [a.id]: { x: 5, y: 7 }, unknown: { x: 1, y: 1 } });
    expect((await w.repo.projects.get(projectId))!.flow.nodes[a.id]).toEqual({ x: 5, y: 7 });
    const flow = await layoutProject(w.ctx(), projectId, { wrap: true });
    expect(Object.keys(flow.nodes)).toHaveLength(64);
    expect((await w.repo.history.listAll({ limit: 100 })).items.length).toBe(rows);
  });
});
