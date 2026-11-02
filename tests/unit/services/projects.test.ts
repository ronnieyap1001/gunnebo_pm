import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { seedTemplateFile } from "@/domain/seed";
import { EV } from "@/server/services/context";
import {
  archiveProject,
  continueCreateProject,
  normalizeProjectCode,
  reconcileProject,
  restoreProject,
  startCreateProject,
  updateProject,
  type CreateProjectJob,
} from "@/server/services/projects";
import { listProjectFields } from "@/server/services/projectFields";
import { loadJob } from "@/server/services/jobs";
import {
  createProject,
  expectAppError,
  historyOfType,
  seedLibrary,
  stepByKey,
  stepsOf,
  world,
  type World,
} from "./_helpers";

describe("template -> project copy", () => {
  let w: World;
  beforeEach(async () => {
    w = world();
    await seedLibrary(w);
  });

  it("copies the seed template: 64 steps, 63 active edges, cells for every step, READY, one project.created row", async () => {
    const opId = randomUUID();
    const { projectId, total } = await startCreateProject(w.ctx({ opId }), { code: " c0822 ", name: "Heathrow T5 gates" });
    expect(total).toBe(64);
    let p = await w.repo.projects.get(projectId);
    expect(p).toMatchObject({ code: "C0822", setup: "CREATING", cells: {} });

    const calls: boolean[] = [];
    for (let i = 0; i < 20; i++) {
      const r = await continueCreateProject(w.ctx(), opId);
      calls.push(r.done);
      if (r.done) {
        expect(r).toMatchObject({ created: 64, total: 64, fraction: 1, projectId });
        break;
      }
      expect(r.created).toBe((i + 1) * 8);
    }
    expect(calls).toHaveLength(8);

    const steps = await stepsOf(w, projectId);
    expect(steps).toHaveLength(64);
    expect(new Set(steps.map((s) => s.stepKey)).size).toBe(64);
    expect(steps.every((s) => s.value === null && !s.notApplicable && s.flag === null && s.rev === 0)).toBe(true);

    p = (await w.repo.projects.get(projectId))!;
    expect(p.setup).toBe("READY");
    expect(p.progress).toBe(0);
    const ids = new Set(steps.map((s) => s.id));
    expect(Object.keys(p.cells).sort()).toEqual([...ids].sort());
    const active = p.flow.edges.filter((e) => !e.archivedAt);
    expect(active).toHaveLength(63);
    expect(active.every((e) => ids.has(e.from) && ids.has(e.to) && !!e.templateEdgeId)).toBe(true);
    expect(Object.keys(p.flow.nodes).sort()).toEqual([...ids].sort());
    const template = await w.repo.settings.get<number>("template.revision");
    expect(p.templateRevision).toBe(template);

    const created = await historyOfType(w, EV.projectCreated);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ projectId, data: { nodeCount: 64, edgeCount: 63, revision: template } });

    // The chain: first step is the only current one.
    const first = await stepByKey(w, projectId, "enquiry-rfq-received");
    expect(p.cells[first.id]).toMatchObject({ n: "Enquiry / RFQ received", t: "DATE", k: "enquiry-rfq-received" });
  });

  it("re-running continue after done is a no-op", async () => {
    const opId = randomUUID();
    const projectId = await createProject(w, {}, opId);
    const writes = w.repo.writeCount();
    const r = await continueCreateProject(w.ctx(), opId);
    expect(r).toMatchObject({ done: true, created: 64, projectId });
    expect(w.repo.writeCount()).toBe(writes);
    expect(await historyOfType(w, EV.projectCreated)).toHaveLength(1);
  });

  it("repeating start with the same opId returns the same project", async () => {
    const opId = randomUUID();
    const a = await startCreateProject(w.ctx({ opId }), { code: "C0822", name: "A" });
    const b = await startCreateProject(w.ctx({ opId }), { code: "C0822", name: "A" });
    expect(b.projectId).toBe(a.projectId);
    expect((await w.repo.projects.list()).length).toBe(1);
  });

  it("an interrupted batch resumes without duplicates (stepKey)", async () => {
    const opId = randomUUID();
    const { projectId } = await startCreateProject(w.ctx({ opId }), { code: "C0900", name: "Crash test" });
    await continueCreateProject(w.ctx(), opId); // 8 steps

    let creates = 0;
    w.repo.beforeWrite = (op) => {
      if (op === "steps.create" && ++creates === 4) throw new Error("network dropped");
    };
    await expect(continueCreateProject(w.ctx(), opId)).rejects.toThrow("network dropped");
    w.repo.beforeWrite = null;
    expect((await stepsOf(w, projectId)).length).toBe(15); // 8 + 7 of the batch made it

    for (let i = 0; i < 20; i++) if ((await continueCreateProject(w.ctx(), opId)).done) break;
    const steps = await stepsOf(w, projectId);
    expect(steps).toHaveLength(64);
    expect(new Set(steps.map((s) => s.milestoneId)).size).toBe(64);
    expect(await historyOfType(w, EV.projectCreated)).toHaveLength(1);
    expect((await w.repo.projects.get(projectId))!.setup).toBe("READY");
  });

  it("a crash before the project id was recorded is resumed by code", async () => {
    const opId = randomUUID();
    let saves = 0;
    w.repo.beforeWrite = (op) => {
      if (op === "settings.set" && ++saves === 2) throw new Error("timeout");
    };
    await expect(startCreateProject(w.ctx({ opId }), { code: "C0901", name: "X" })).rejects.toThrow("timeout");
    w.repo.beforeWrite = null;
    const job = await loadJob<CreateProjectJob>(w.repo, opId);
    expect(job?.projectId).toBeUndefined();
    for (let i = 0; i < 20; i++) if ((await continueCreateProject(w.ctx(), opId)).done) break;
    const projects = await w.repo.projects.list();
    expect(projects).toHaveLength(1);
    expect(projects[0].setup).toBe("READY");
  });

  it("finished job leaves a tombstone without the drafts", async () => {
    const opId = randomUUID();
    await createProject(w, {}, opId);
    const job = await loadJob<CreateProjectJob>(w.repo, opId);
    expect(job).toMatchObject({ status: "done", kind: "createProject" });
    expect(job).not.toHaveProperty("drafts");
  });
});

describe("project codes and details", () => {
  let w: World;
  beforeEach(async () => {
    w = world();
    await seedLibrary(w);
  });

  it("normalises and validates codes", () => {
    expect(normalizeProjectCode(" c0822-sp1 ")).toBe("C0822-SP1");
    expect(() => normalizeProjectCode("-C1")).toThrow(/project code/);
    expect(() => normalizeProjectCode("C")).toThrow();
    expect(() => normalizeProjectCode("C08 22")).toThrow();
    expect(() => normalizeProjectCode("A".repeat(21))).toThrow();
  });

  it("refuses a code used by an active or archived project (case-insensitive)", async () => {
    const id = await createProject(w, { code: "C0822" });
    await expectAppError(startCreateProject(w.ctx(), { code: "c0822", name: "Dup" }), "CODE_TAKEN", /already used/);
    await archiveProject(w.ctx(), id);
    await expectAppError(
      startCreateProject(w.ctx(), { code: "C0822", name: "Dup" }),
      "CODE_TAKEN",
      /C0822 is used by an archived project\. Restore it from the Archive/,
    );
  });

  it("normalises details per field and refuses unknown fields and unknown choices", async () => {
    const fields = await listProjectFields(w.repo);
    const customer = fields.find((f) => f.systemKey === "customer")!;
    const qty = fields.find((f) => f.key === "quantity")!;
    const id = await createProject(w, { code: "C1", details: { [customer.id]: "sita", quantity: "24" } });
    const p = (await w.repo.projects.get(id))!;
    expect(p.details).toEqual({ [customer.id]: { choiceId: "sita" }, [qty.id]: { number: 24 } });
    await expectAppError(startCreateProject(w.ctx(), { code: "C2", name: "x", details: { nope: 1 } }), "VALIDATION", /Unknown project field/);
    await expectAppError(startCreateProject(w.ctx(), { code: "C3", name: "x", details: { [customer.id]: "acme" } }), "VALIDATION");
  });

  it("updateProject logs changed fields old -> new; a code change logs project.code_changed", async () => {
    const fields = await listProjectFields(w.repo);
    const customer = fields.find((f) => f.systemKey === "customer")!;
    const id = await createProject(w, { code: "C0822", details: { [customer.id]: "sita" } });
    const r = await updateProject(w.ctx(), id, { name: "Heathrow T5", details: { [customer.id]: "nec" }, status: "ON_HOLD" });
    expect(r.changes.map((c) => `${c.label}: ${c.old} → ${c.new}`)).toEqual([
      "Name: Heathrow T5 gates → Heathrow T5",
      "Status: Active → On hold",
      "Customer: SITA → NEC",
    ]);
    const rows = await historyOfType(w, EV.projectUpdated);
    expect(rows).toHaveLength(1);
    expect(rows[0].summary).toContain("C0822 · Name: Heathrow T5 gates → Heathrow T5");

    // No change: no write, no row.
    const writes = w.repo.writeCount();
    expect((await updateProject(w.ctx(), id, { name: "Heathrow T5" })).changes).toEqual([]);
    expect(w.repo.writeCount()).toBe(writes);

    await updateProject(w.ctx(), id, { code: "c0822-sp1" });
    const codeRows = await historyOfType(w, EV.projectCodeChanged);
    expect(codeRows[0].data).toMatchObject({ oldCode: "C0822", newCode: "C0822-SP1" });
    expect((await w.repo.projects.get(id))!.code).toBe("C0822-SP1");
  });

  it("a retired detail choice may be kept but not newly chosen", async () => {
    const fields = await listProjectFields(w.repo);
    const customer = fields.find((f) => f.systemKey === "customer")!;
    const id = await createProject(w, { code: "C5", details: { [customer.id]: "nec" } });
    await w.repo.projectFields.update(customer.id, {
      choices: customer.choices.map((c) => (c.id === "nec" || c.id === "sita" ? { ...c, archived: true } : c)),
    });
    // keeping nec is fine
    await updateProject(w.ctx(), id, { details: { [customer.id]: "nec" } });
    await expectAppError(updateProject(w.ctx(), id, { details: { [customer.id]: "sita" } }), "VALIDATION", /retired/);
  });

  it("archive and restore a project", async () => {
    const id = await createProject(w);
    const a = await archiveProject(w.ctx(), id);
    expect(a).toMatchObject({ archived: true });
    expect(await w.repo.projects.list()).toHaveLength(0);
    expect(await w.repo.projects.list({ includeArchived: true })).toHaveLength(1);
    const r = await restoreProject(w.ctx(), id);
    expect(r.archived).toBe(false);
    expect(r.archivedAt).toBeUndefined();
    expect((await historyOfType(w, EV.projectArchived)).length).toBe(1);
    expect((await historyOfType(w, EV.projectRestored)).length).toBe(1);
  });

  it("reconcileProject patches only when the mirrors differ", async () => {
    const id = await createProject(w);
    expect(await reconcileProject(w.ctx(), id)).toEqual({ changed: false });
    const step = await stepByKey(w, id, "bom");
    await w.repo.steps.update(step.id, { value: { choiceId: "released" } }); // a write that skipped the mirrors
    const writes = w.repo.writeCount();
    expect(await reconcileProject(w.ctx(), id)).toEqual({ changed: true });
    expect(w.repo.writeCount()).toBe(writes + 1);
    const p = (await w.repo.projects.get(id))!;
    expect(p.cells[step.id].v).toEqual({ choiceId: "released" });
    expect(p.progress).toBe(1); // 1 of 64
  });

  it("refuses to create a project from an empty template", async () => {
    const empty = world();
    await expectAppError(startCreateProject(empty.ctx(), { code: "C1", name: "x" }), "VALIDATION", /no milestones/);
  });

  it("the seed file keeps working as the template source", () => {
    expect(seedTemplateFile().milestones).toHaveLength(64);
  });
});
