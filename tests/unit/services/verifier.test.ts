/**
 * Adversarial review tests: crashes at every write of the multi-write actions (resumed with the same opId), work done
 * between the start and the end of a job, and History coverage of changes made by sync.
 */
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { cellState } from "@/domain/cells";
import { EV } from "@/server/services/context";
import { addLink } from "@/server/services/attachments";
import { archiveMilestone, createMilestone, getTemplate, restoreBatch, updateMilestone } from "@/server/services/library";
import { listProjectFields, updateProjectField } from "@/server/services/projectFields";
import { continueCreateProject, startCreateProject } from "@/server/services/projects";
import {
  addProjectEdge,
  addProjectStep,
  archiveProjectStep,
  moveProjectNodes,
  restoreProjectBatch,
  setStepValue,
} from "@/server/services/steps";
import { continueSync, previewSync, startSync } from "@/server/services/sync";
import {
  activeEdgePairs,
  createProject,
  historyOfType,
  milestoneByKey,
  runSync,
  seedLibrary,
  stepByKey,
  stepsOf,
  TODAY,
  TZ,
  world,
  type World,
} from "./_helpers";

let w: World;
beforeEach(async () => {
  w = world();
  await seedLibrary(w);
});

/** Makes the n-th write of the given kind throw once (a dropped request / function timeout). */
function crashOn(op: string, nth = 1) {
  let n = 0;
  w.repo.beforeWrite = (o) => {
    if (o === op && ++n === nth) {
      w.repo.beforeWrite = null;
      throw new Error(`crash at ${op}`);
    }
  };
}

const day = { today: TODAY, timeZone: TZ };

describe("create project: crash before the Project row exists", () => {
  it("retrying start with the same opId creates the project instead of failing for good", async () => {
    const opId = randomUUID();
    crashOn("projects.create");
    await expect(startCreateProject(w.ctx({ opId }), { code: "C0902", name: "Crash" })).rejects.toThrow("crash");
    const { projectId } = await startCreateProject(w.ctx({ opId }), { code: "C0902", name: "Crash" });
    for (let i = 0; i < 20; i++) if ((await continueCreateProject(w.ctx({ opId }), opId)).done) break;
    const projects = await w.repo.projects.list();
    expect(projects.map((p) => [p.id, p.code, p.setup])).toEqual([[projectId, "C0902", "READY"]]);
    expect(await stepsOf(w, projectId)).toHaveLength(64);
  });

  it("continue alone (the browser resumes the job) also creates the project", async () => {
    const opId = randomUUID();
    crashOn("projects.create");
    await expect(startCreateProject(w.ctx({ opId }), { code: "C0903", name: "Crash", status: "ON_HOLD" })).rejects.toThrow("crash");
    let last;
    for (let i = 0; i < 20; i++) if ((last = await continueCreateProject(w.ctx({ opId }), opId)).done) break;
    expect(last?.done).toBe(true);
    const projects = await w.repo.projects.list();
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({ code: "C0903", status: "ON_HOLD", setup: "READY" });
  });

  it("a resumed finalize keeps attachment counts written after the project became READY", async () => {
    const opId = randomUUID();
    const { projectId } = await startCreateProject(w.ctx({ opId }), { code: "C0904", name: "X" });
    for (let i = 0; i < 7; i++) await continueCreateProject(w.ctx({ opId }), opId);
    crashOn("history.append"); // the finalize call dies after setting READY
    await expect(continueCreateProject(w.ctx({ opId }), opId)).rejects.toThrow("crash");
    const bom = await stepByKey(w, projectId, "bom");
    await addLink(w.ctx(), { projectId, stepId: bom.id, url: "https://example.com/bom" });
    expect((await continueCreateProject(w.ctx({ opId }), opId)).done).toBe(true);
    expect((await w.repo.projects.get(projectId))!.cells[bom.id].fc).toBe(1);
    expect(await historyOfType(w, EV.projectCreated)).toHaveLength(1);
  });
});

describe("archive / restore resumed after a crash", () => {
  let projectId: string;
  beforeEach(async () => {
    projectId = await createProject(w);
  });

  it("archiveProjectStep: a retry finishes the arrows, the cell and the History row", async () => {
    const bom = await stepByKey(w, projectId, "bom");
    const beforeAdd = activeEdgePairs((await w.repo.projects.get(projectId))!.flow.edges);
    const { step } = await addProjectStep(w.ctx(), { projectId, name: "Factory visit", fieldType: "DATE", afterStepId: bom.id });
    const withStep = activeEdgePairs((await w.repo.projects.get(projectId))!.flow.edges);
    const opId = randomUUID();
    crashOn("projects.update");
    await expect(archiveProjectStep(w.ctx({ opId }), step.id)).rejects.toThrow("crash");
    const { batchId } = await archiveProjectStep(w.ctx({ opId }), step.id);
    const p = (await w.repo.projects.get(projectId))!;
    expect(p.cells[step.id]).toBeUndefined();
    expect(activeEdgePairs(p.flow.edges)).toEqual(beforeAdd);
    expect(await historyOfType(w, EV.stepArchived)).toHaveLength(1);
    // Undo is still exact.
    await restoreProjectBatch(w.ctx(), projectId, batchId);
    expect(activeEdgePairs((await w.repo.projects.get(projectId))!.flow.edges)).toEqual(withStep);
  });

  it("restoreProjectBatch: a retry finishes the arrows, the cell and the History row", async () => {
    const bom = await stepByKey(w, projectId, "bom");
    const { step } = await addProjectStep(w.ctx(), { projectId, name: "Factory visit", fieldType: "DATE", afterStepId: bom.id });
    const withStep = activeEdgePairs((await w.repo.projects.get(projectId))!.flow.edges);
    const { batchId } = await archiveProjectStep(w.ctx(), step.id);
    const opId = randomUUID();
    crashOn("projects.update");
    await expect(restoreProjectBatch(w.ctx({ opId }), projectId, batchId)).rejects.toThrow("crash");
    await restoreProjectBatch(w.ctx({ opId }), projectId, batchId);
    const p = (await w.repo.projects.get(projectId))!;
    expect((await w.repo.steps.get(step.id))!.archived).toBe(false);
    expect(p.cells[step.id]).toBeTruthy();
    expect(activeEdgePairs(p.flow.edges)).toEqual(withStep);
    expect(await historyOfType(w, EV.stepRestored)).toHaveLength(1);
  });

  it("restoreProjectBatch: a crash while un-archiving the steps is finished by the retry", async () => {
    const bom = await stepByKey(w, projectId, "bom");
    const { step } = await addProjectStep(w.ctx(), { projectId, name: "Factory visit", fieldType: "DATE", afterStepId: bom.id });
    const withStep = activeEdgePairs((await w.repo.projects.get(projectId))!.flow.edges);
    const { batchId } = await archiveProjectStep(w.ctx(), step.id);
    const opId = randomUUID();
    crashOn("steps.update");
    await expect(restoreProjectBatch(w.ctx({ opId }), projectId, batchId)).rejects.toThrow("crash");
    await restoreProjectBatch(w.ctx({ opId }), projectId, batchId);
    const p = (await w.repo.projects.get(projectId))!;
    expect((await w.repo.steps.get(step.id))!.archived).toBe(false);
    expect(p.cells[step.id]).toBeTruthy();
    expect(activeEdgePairs(p.flow.edges)).toEqual(withStep);
    expect(await historyOfType(w, EV.stepRestored)).toHaveLength(1);
  });

  it("archiveMilestone: a retry finishes the template arrows, the revision and the History row", async () => {
    const before = await getTemplate(w.repo);
    const bom = await milestoneByKey(w, "bom");
    const opId = randomUUID();
    crashOn("settings.set"); // the template flow save
    await expect(archiveMilestone(w.ctx({ opId }), bom.id)).rejects.toThrow("crash");
    const r = await archiveMilestone(w.ctx({ opId }), bom.id);
    const mid = await getTemplate(w.repo);
    expect(activeEdgePairs(mid.flow.edges).some((p) => p.includes(bom.id))).toBe(false);
    expect(activeEdgePairs(mid.flow.edges)).toHaveLength(62); // 63 - 2 + 1 bridge
    expect(r.bridgeEdgeIds).toHaveLength(1);
    expect(mid.revision).toBeGreaterThan(before.revision);
    expect(await historyOfType(w, EV.milestoneArchived)).toHaveLength(1);
    await restoreBatch(w.ctx(), r.batchId);
    expect(activeEdgePairs((await getTemplate(w.repo)).flow.edges)).toEqual(activeEdgePairs(before.flow.edges));
  });

  it("restoreBatch: a retry restores the arrows when the first attempt died after the milestones", async () => {
    const before = await getTemplate(w.repo);
    const bom = await milestoneByKey(w, "bom");
    const { batchId } = await archiveMilestone(w.ctx(), bom.id);
    const opId = randomUUID();
    crashOn("milestones.update");
    await expect(restoreBatch(w.ctx({ opId }), batchId)).rejects.toThrow("crash");
    await restoreBatch(w.ctx({ opId }), batchId);
    const after = await getTemplate(w.repo);
    expect(after.milestones.find((m) => m.id === bom.id)!.archived).toBe(false);
    expect(activeEdgePairs(after.flow.edges)).toEqual(activeEdgePairs(before.flow.edges));
    expect(await historyOfType(w, EV.milestoneRestored)).toHaveLength(1);
  });

  it("restoreBatch: a crash at the template flow save is finished by the retry", async () => {
    const before = await getTemplate(w.repo);
    const bom = await milestoneByKey(w, "bom");
    const { batchId } = await archiveMilestone(w.ctx(), bom.id);
    const opId = randomUUID();
    crashOn("settings.set");
    await expect(restoreBatch(w.ctx({ opId }), batchId)).rejects.toThrow("crash");
    await restoreBatch(w.ctx({ opId }), batchId);
    const after = await getTemplate(w.repo);
    expect(after.milestones.find((m) => m.id === bom.id)!.archived).toBe(false);
    expect(activeEdgePairs(after.flow.edges)).toEqual(activeEdgePairs(before.flow.edges));
    expect(await historyOfType(w, EV.milestoneRestored)).toHaveLength(1);
  });
});

describe("project field retype resumed after a crash", () => {
  it("never leaves values in the old shape and never clears them", async () => {
    const product = (await listProjectFields(w.repo)).find((f) => f.key === "product")!;
    const p1 = await createProject(w, { code: "C1", details: { product: "afl" } });
    const p2 = await createProject(w, { code: "C2", details: { product: "abcs" } });
    const opId = randomUUID();
    crashOn("projects.update", 2); // C1 converted, C2 not
    await expect(updateProjectField(w.ctx({ opId }), product.id, { fieldType: "MULTIPLE" })).rejects.toThrow("crash");
    await updateProjectField(w.ctx({ opId }), product.id, { fieldType: "MULTIPLE" });
    expect((await listProjectFields(w.repo)).find((f) => f.key === "product")!.fieldType).toBe("MULTIPLE");
    expect((await w.repo.projects.get(p1))!.details[product.id]).toEqual({ choiceIds: ["afl"] });
    expect((await w.repo.projects.get(p2))!.details[product.id]).toEqual({ choiceIds: ["abcs"] });
    expect(await historyOfType(w, EV.projectFieldUpdated)).toHaveLength(1);
  });

  it("a value that is invalid for the field's type blocks a retype instead of being cleared", async () => {
    const product = (await listProjectFields(w.repo)).find((f) => f.key === "product")!;
    const id = await createProject(w, { code: "C3" });
    await w.repo.projects.update(id, { details: { [product.id]: { text: "AFL x2" } as never } }); // edited by hand in Notion
    await expect(updateProjectField(w.ctx(), product.id, { fieldType: "MULTIPLE" })).rejects.toMatchObject({ code: "VALIDATION" });
    expect((await w.repo.projects.get(id))!.details[product.id]).toEqual({ text: "AFL x2" });
  });
});

describe("sync: work done between startSync and the last continueSync", () => {
  let projectId: string;
  beforeEach(async () => {
    projectId = await createProject(w);
  });

  it("a value changed after the preview is converted from its current value, never overwritten by the planned one", async () => {
    const fat = await stepByKey(w, projectId, "fat-date");
    await setStepValue(w.ctx(), { stepId: fat.id, value: "2026-11-12", expectedRev: 0 });
    await updateMilestone(w.ctx(), (await milestoneByKey(w, "fat-date")).id, { fieldType: "DATE_RANGE" });
    const item = (await previewSync(w.ctx(), projectId)).items.find((i) => i.kind === "changeType")!;
    expect(item.selectable).toBe(true);
    const opId = randomUUID();
    await startSync(w.ctx({ opId }), { projectId, selectedIds: [item.id] });
    await setStepValue(w.ctx(), { stepId: fat.id, value: "2026-12-01", expectedRev: 1 });
    while (!(await continueSync(w.ctx(), opId)).done);
    const after = (await w.repo.steps.get(fat.id))!;
    expect(after).toMatchObject({ fieldType: "DATE_RANGE", value: { start: "2026-12-01" } });
    expect((await w.repo.projects.get(projectId))!.cells[fat.id]).toMatchObject({ t: "DATE_RANGE", v: { start: "2026-12-01" } });
  });

  it("a type change planned while the step was empty is not applied over a value entered meanwhile", async () => {
    const lessons = await stepByKey(w, projectId, "lessons-learned");
    await updateMilestone(w.ctx(), (await milestoneByKey(w, "lessons-learned")).id, { fieldType: "NUMBER" });
    const item = (await previewSync(w.ctx(), projectId)).items.find((i) => i.kind === "changeType")!;
    const opId = randomUUID();
    await startSync(w.ctx({ opId }), { projectId, selectedIds: [item.id] });
    await setStepValue(w.ctx(), { stepId: lessons.id, value: "Pack early", expectedRev: 0 });
    while (!(await continueSync(w.ctx(), opId)).done);
    const after = (await w.repo.steps.get(lessons.id))!;
    expect(after).toMatchObject({ fieldType: "TEXT", value: { text: "Pack early" } });
    const p = (await w.repo.projects.get(projectId))!;
    expect(cellState(p.cells[lessons.id], day).state).toBe("DONE");
    // The type change waits (the value can't be converted), shown as "type differs".
    const again = await previewSync(w.ctx(), projectId);
    expect(again.items.find((i) => i.kind === "changeType")).toMatchObject({ selectable: false });
  });

  it("an older sync job resumed after a newer one never removes a choice", async () => {
    const bom = await milestoneByKey(w, "bom");
    await updateMilestone(w.ctx(), bom.id, { choices: [...bom.choices, { label: "Escalated", state: "BLOCKED" }] });
    const older = randomUUID();
    await startSync(w.ctx({ opId: older }), { projectId, selectedIds: (await previewSync(w.ctx(), projectId)).items.map((i) => i.id) });
    const bom2 = await milestoneByKey(w, "bom");
    await updateMilestone(w.ctx(), bom2.id, { choices: [...bom2.choices, { label: "Waiting for PE", state: "WAITING" }] });
    await runSync(w, projectId, (await previewSync(w.ctx(), projectId)).items.map((i) => i.id));
    const step = await stepByKey(w, projectId, "bom");
    const pe = step.choices.find((c) => c.label === "Waiting for PE")!;
    await setStepValue(w.ctx(), { stepId: step.id, value: pe.id, expectedRev: step.rev });
    while (!(await continueSync(w.ctx(), older)).done);
    const after = await stepByKey(w, projectId, "bom");
    expect(after.choices.map((c) => c.id)).toEqual(expect.arrayContaining(step.choices.map((c) => c.id)));
    expect(after.value).toEqual({ choiceId: pe.id });
    expect(cellState((await w.repo.projects.get(projectId))!.cells[step.id], day).state).toBe("WAITING");
  });

  it("arrows drawn and nodes moved meanwhile are kept; the sync's own arrows still land", async () => {
    const bom = await milestoneByKey(w, "bom");
    const audit = await createMilestone(w.ctx(), { name: "Factory audit", fieldType: "DATE", afterMilestoneId: bom.id });
    const preview = await previewSync(w.ctx(), projectId);
    const opId = randomUUID();
    await startSync(w.ctx({ opId }), { projectId, selectedIds: preview.items.map((i) => i.id) });
    const pm = await stepByKey(w, projectId, "pm-assigned");
    const lessons = await stepByKey(w, projectId, "lessons-learned");
    const drawn = await addProjectEdge(w.ctx(), projectId, pm.id, lessons.id);
    await moveProjectNodes(w.ctx(), projectId, { [pm.id]: { x: 999, y: 777 } });
    while (!(await continueSync(w.ctx(), opId)).done);
    const p = (await w.repo.projects.get(projectId))!;
    expect(p.flow.edges.find((e) => e.id === drawn.id && !e.archivedAt)).toBeTruthy();
    expect(p.flow.nodes[pm.id]).toEqual({ x: 999, y: 777 });
    const bomStep = await stepByKey(w, projectId, "bom");
    const auditStep = (await stepsOf(w, projectId)).find((s) => s.milestoneId === audit.id)!;
    const drawings = await stepByKey(w, projectId, "customer-drawings-approval");
    const pairs = activeEdgePairs(p.flow.edges);
    expect(pairs).toContain(`${bomStep.id}->${auditStep.id}`);
    expect(pairs).toContain(`${auditStep.id}->${drawings.id}`);
    expect(pairs).not.toContain(`${bomStep.id}->${drawings.id}`);
    expect(p.flow.nodes[auditStep.id]).toBeTruthy();
    expect((await previewSync(w.ctx(), projectId)).items).toEqual([]);
  });
});

describe("edits keep the old value in History when a write is interrupted and retried", () => {
  it("editNote: the original text reaches History whichever write failed", async () => {
    const { addNote, editNote } = await import("@/server/services/notes");
    const projectId = await createProject(w);
    const note = await addNote(w.ctx(), { projectId, body: "Kick-off on Monday" });
    for (const op of ["history.append", "notes.update"]) {
      const before = (await w.repo.notes.listByProject(projectId))[0].body;
      const body = `${before}!`;
      const opId = randomUUID();
      crashOn(op);
      await expect(editNote(w.ctx({ opId }), { projectId, noteId: note.id, body })).rejects.toThrow("crash");
      await editNote(w.ctx({ opId }), { projectId, noteId: note.id, body });
      const rows = (await historyOfType(w, EV.noteEdited)).filter((r) => r.opId === opId);
      expect(rows).toHaveLength(1);
      expect(rows[0].data).toMatchObject({ oldBody: before, newBody: body });
      expect((await w.repo.notes.listByProject(projectId))[0].body).toBe(body);
    }
  });

  it("updateProject: an old project code always reaches History (Phase 2 maps old codes)", async () => {
    const { updateProject } = await import("@/server/services/projects");
    const projectId = await createProject(w, { code: "C0822" });
    let code = "C0822";
    for (const op of ["history.append", "projects.update"]) {
      const next = `${code}-X`;
      const opId = randomUUID();
      crashOn(op);
      await expect(updateProject(w.ctx({ opId }), projectId, { code: next })).rejects.toThrow("crash");
      await updateProject(w.ctx({ opId }), projectId, { code: next });
      const rows = (await historyOfType(w, EV.projectCodeChanged)).filter((r) => r.opId === opId);
      expect(rows).toHaveLength(1);
      expect(rows[0].data).toMatchObject({ oldCode: code, newCode: next });
      expect((await w.repo.projects.get(projectId))!.code).toBe(next);
      code = next;
    }
  });

  it("updateMilestone: the old definition reaches History and the revision goes up", async () => {
    for (const op of ["history.append", "milestones.update"]) {
      const bom = await milestoneByKey(w, "bom");
      const r0 = (await getTemplate(w.repo)).revision;
      const name = `${bom.name} (rev)`;
      const opId = randomUUID();
      crashOn(op);
      await expect(updateMilestone(w.ctx({ opId }), bom.id, { name })).rejects.toThrow("crash");
      await updateMilestone(w.ctx({ opId }), bom.id, { name });
      const rows = (await historyOfType(w, EV.milestoneUpdated)).filter((r) => r.opId === opId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ oldDisplay: bom.name, newDisplay: name });
      expect((await milestoneByKey(w, "bom")).name).toBe(name);
      expect((await getTemplate(w.repo)).revision).toBeGreaterThan(r0);
    }
  });
});

describe("positions from the browser are validated", () => {
  const finite = (nodes: Record<string, { x: number; y: number }>) =>
    Object.values(nodes).every((p) => Number.isFinite(p.x) && Number.isFinite(p.y));

  it("createMilestone / addProjectStep ignore a malformed position (with or without 'insert after')", async () => {
    const { layoutProject, layoutTemplate } = await import("@/server/services/library").then(async (lib) => ({
      layoutTemplate: lib.layoutTemplate,
      layoutProject: (await import("@/server/services/steps")).layoutProject,
    }));
    const bad = { x: "left", y: Number.NaN } as never;
    const bom = await milestoneByKey(w, "bom");
    await createMilestone(w.ctx(), { name: "Loose", fieldType: "TEXT", position: bad });
    await createMilestone(w.ctx(), { name: "After BOM", fieldType: "TEXT", afterMilestoneId: bom.id, position: bad });
    expect(finite((await getTemplate(w.repo)).flow.nodes)).toBe(true);
    const projectId = await createProject(w);
    const bomStep = await stepByKey(w, projectId, "bom");
    await addProjectStep(w.ctx(), { projectId, name: "Visit", fieldType: "DATE", afterStepId: bomStep.id, position: bad });
    expect(finite((await w.repo.projects.get(projectId))!.flow.nodes)).toBe(true);
    // A bad viewport width falls back to the default.
    expect(finite((await layoutTemplate(w.ctx(), { wrap: true, viewportWidth: Number.NaN })).nodes)).toBe(true);
    expect(finite((await layoutProject(w.ctx(), projectId, { wrap: true, viewportWidth: -5 })).nodes)).toBe(true);
  });
});

describe("small consistency rules", () => {
  it("an N/A 'Project closed' never prompts 'Set status to Closed?' (same rule as the project page)", async () => {
    const { setStepNotApplicable } = await import("@/server/services/steps");
    const { getProjectPageData } = await import("@/server/queries/projects");
    const projectId = await createProject(w);
    const closed = await stepByKey(w, projectId, "project-closed");
    const na = await setStepNotApplicable(w.ctx(), { stepId: closed.id, notApplicable: true, expectedRev: 0 });
    const r = await setStepValue(w.ctx(), { stepId: closed.id, value: TODAY, expectedRev: na.step.rev });
    expect(r.suggestClose).toBe(false);
    expect((await getProjectPageData(w.repo, day, projectId))!.suggestClose).toBe(false);
  });

  it("a file that turns a FILE step Done also refreshes the step's readable State mirror", async () => {
    const { addFile } = await import("@/server/services/attachments");
    const projectId = await createProject(w);
    const { step } = await addProjectStep(w.ctx(), { projectId, name: "FAT photos", fieldType: "FILE" });
    await addFile(w.ctx(), { projectId, stepId: step.id, name: "a.jpg", contentType: "image/jpeg", size: 1, data: new Blob([new Uint8Array([1])]) });
    expect(w.repo.store.mirrors.get(step.id)).toMatchObject({ state: "DONE", display: "1 file" });
  });
});

describe("read models and service results are plain JSON (serialisable to Client Components)", () => {
  /** A JSON round trip gives back an equal value only when there is no Map, Set, Date, function or undefined-in-array. */
  const plain = (x: unknown) => expect(JSON.parse(JSON.stringify(x))).toStrictEqual(stripUndefined(x));
  function stripUndefined(x: unknown): unknown {
    if (Array.isArray(x)) return x.map(stripUndefined);
    if (x && typeof x === "object" && Object.getPrototypeOf(x) === Object.prototype) {
      return Object.fromEntries(Object.entries(x).filter(([, v]) => v !== undefined).map(([k, v]) => [k, stripUndefined(v)]));
    }
    return x;
  }

  it("every query DTO and write result survives a JSON round trip unchanged", async () => {
    const { getPortfolioData } = await import("@/server/queries/portfolio");
    const { getCellDetails, getProjectPageData, getProjectsList } = await import("@/server/queries/projects");
    const { getLibraryView, getTemplateView } = await import("@/server/queries/library");
    const { getArchiveData } = await import("@/server/queries/archive");
    const { getAllHistory, getProjectHistory, getStepHistory, getTemplateSnapshots } = await import("@/server/queries/history");
    const { getSettingsData } = await import("@/server/queries/setup");
    const projectId = await createProject(w);
    const bom = await stepByKey(w, projectId, "bom");
    const v = await setStepValue(w.ctx(), { stepId: bom.id, value: "requested", expectedRev: 0 });
    await createMilestone(w.ctx(), { name: "Extra", fieldType: "TEXT" });
    plain(v);
    plain(await previewSync(w.ctx(), projectId));
    plain(await getPortfolioData(w.repo, day, { includeDateDriven: true, includeWaiting: true }));
    plain(await getProjectPageData(w.repo, day, projectId));
    plain(await getProjectsList(w.repo, day));
    plain(await getCellDetails(w.repo, day, bom.id));
    plain(await getLibraryView(w.repo));
    plain(await getTemplateView(w.repo));
    plain(await getArchiveData(w.repo, { projectId }));
    plain(await getStepHistory(w.repo, bom.id));
    plain(await getProjectHistory(w.repo, projectId));
    plain(await getAllHistory(w.repo));
    plain(await getTemplateSnapshots(w.repo));
    plain(await getSettingsData(w.repo, new Date("2026-10-25T02:00:00.000Z")));
  });

  it("every History type the services write is a known option of the Notion Type select", async () => {
    const { KNOWN_EVENT_TYPES } = await import("@/server/notion/schema");
    for (const t of Object.values(EV)) expect(KNOWN_EVENT_TYPES).toContain(t);
  });
});

describe("sync History relates to the steps it changed", () => {
  it("the project.synced row shows in each changed step's history with old/new snapshots", async () => {
    const projectId = await createProject(w);
    const fat = await stepByKey(w, projectId, "fat-date");
    await setStepValue(w.ctx(), { stepId: fat.id, value: "2026-11-12", expectedRev: 0 });
    await updateMilestone(w.ctx(), (await milestoneByKey(w, "fat-date")).id, { fieldType: "DATE_RANGE" });
    await archiveMilestone(w.ctx(), (await milestoneByKey(w, "training")).id);
    const preview = await previewSync(w.ctx(), projectId);
    expect(preview.items.some((i) => i.kind === "markNA")).toBe(true);
    await runSync(w, projectId, preview.items.filter((i) => i.selectable).map((i) => i.id));
    const row = (await historyOfType(w, EV.projectSynced))[0];
    const training = await stepByKey(w, projectId, "training");
    expect(training.notApplicable).toBe(true);
    for (const id of [fat.id, training.id]) expect((await w.repo.history.listByStep(id)).items.map((e) => e.id)).toContain(row.id);
    const detail = (row.data as { steps: { stepId: string; old: unknown; new: unknown }[] }).steps;
    expect(detail.find((d) => d.stepId === fat.id)).toMatchObject({
      old: { raw: { date: "2026-11-12" }, state: "IN_PROGRESS" },
      new: { raw: { start: "2026-11-12" }, state: "IN_PROGRESS" },
    });
    expect(detail.find((d) => d.stepId === training.id)).toMatchObject({ old: { state: "NOT_STARTED" }, new: { state: "NOT_APPLICABLE" } });
  });
});
