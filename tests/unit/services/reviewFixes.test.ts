/**
 * Review fixes on the in-memory repo: Notion mirrors that follow arrows and field changes (DI-6), the unique
 * project-field name on restore and import (DI-7), and reconcile cleaning up second copies of a step (DI-1 safety net).
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { TemplateFile } from "@/domain/templateFile";
import type { ProjectInput, ProjectMirrors } from "@/server/repo/types";
import { repairMirrorsBatch } from "@/server/services/admin";
import { currentMirror } from "@/server/services/mirrors";
import {
  archiveProjectField,
  createProjectField,
  listProjectFields,
  MIRROR_REFRESH_LIMIT,
  restoreProjectField,
  updateProjectField,
} from "@/server/services/projectFields";
import { reconcileProject } from "@/server/services/projects";
import { addProjectEdge, addProjectStep, archiveProjectEdge } from "@/server/services/steps";
import { exportTemplate, previewImport } from "@/server/services/templateIo";
import { createProject, expectAppError, NOW, runImport, seedLibrary, stepsOf, TODAY, TZ, world, type World } from "./_helpers";

let w: World;
beforeEach(async () => {
  w = world();
  await seedLibrary(w);
});

const day = { today: TODAY, timeZone: TZ };
const mirrorsOf = (id: string) => (w.repo.store.mirrors.get(id) ?? {}) as ProjectMirrors;
const field = async (key: string) => (await listProjectFields(w.repo, { includeArchived: true })).find((f) => f.key === key)!;

describe("Notion mirrors follow arrows, Repair mirrors and field changes (DI-6)", () => {
  it("drawing or removing an arrow updates the Current mirror", async () => {
    const projectId = await createProject(w);
    const { step } = await addProjectStep(w.ctx(), { projectId, name: "Site survey", fieldType: "TEXT" });
    expect(mirrorsOf(projectId).current).toContain("Site survey"); // no arrow in: current
    const first = (await stepsOf(w, projectId)).find((s) => s.order === 1)!;

    const edge = await addProjectEdge(w.ctx(), projectId, first.id, step.id);
    let p = (await w.repo.projects.get(projectId))!;
    expect(mirrorsOf(projectId).current).toBe(currentMirror(p.cells, p.flow, day));
    expect(mirrorsOf(projectId).current).not.toContain("Site survey");

    await archiveProjectEdge(w.ctx(), projectId, edge.id);
    p = (await w.repo.projects.get(projectId))!;
    expect(mirrorsOf(projectId).current).toBe(currentMirror(p.cells, p.flow, day));
    expect(mirrorsOf(projectId).current).toContain("Site survey");
  });

  it("Repair mirrors rewrites Current and the Customer / Project type / Summary mirrors even when the cells are right", async () => {
    const customer = await field("customer");
    const projectId = await createProject(w, { details: { [customer.id]: "sita", quantity: "24" } });
    w.repo.store.mirrors.set(projectId, { current: "stale", customer: "Old name", summary: "stale" });
    const r = await repairMirrorsBatch(w.ctx(), [projectId]);
    expect(r).toEqual({ checked: 1, repaired: [] }); // the cells were right
    const p = (await w.repo.projects.get(projectId))!;
    expect(mirrorsOf(projectId)).toMatchObject({ customer: "SITA", current: currentMirror(p.cells, p.flow, day) });
    expect(mirrorsOf(projectId).summary).toContain("SITA");
  });

  it("renaming a Customer choice rewrites the Customer select and Summary of the projects that use it", async () => {
    const customer = await field("customer");
    const a = await createProject(w, { code: "C1", details: { [customer.id]: "sita" } });
    const b = await createProject(w, { code: "C2", details: { [customer.id]: "nec" } });
    const untouched = mirrorsOf(b);
    const r = await updateProjectField(w.ctx(), customer.id, {
      choices: customer.choices.map((c) => (c.id === "sita" ? { ...c, label: "SITA Group" } : c)),
    });
    expect(r.mirrorsUpdated).toBe(1);
    expect(r.mirrorsNote).toBeUndefined();
    expect(mirrorsOf(a).customer).toBe("SITA Group");
    expect(mirrorsOf(a).summary).toContain("SITA Group");
    expect(mirrorsOf(b)).toEqual(untouched);
    // A label change alone shows nowhere in the mirrors: nothing to rewrite.
    expect((await updateProjectField(w.ctx(), customer.id, { label: "Client" })).mirrorsUpdated).toBeUndefined();
  });

  it(`more than ${MIRROR_REFRESH_LIMIT} affected projects: the mirrors are left to Repair mirrors and the result says so`, async () => {
    const customer = await field("customer");
    const base: Omit<ProjectInput, "code"> = {
      name: "x",
      status: "ACTIVE",
      details: { [customer.id]: { choiceId: "sita" } },
      flow: { nodes: {}, edges: [] },
      cells: {},
      progress: 0,
      templateRevision: 1,
      syncDismissed: {},
      setup: "READY",
      archived: false,
      mirrors: { customer: "SITA" },
    };
    const ids: string[] = [];
    for (let i = 0; i <= MIRROR_REFRESH_LIMIT; i++) ids.push((await w.repo.projects.create({ ...base, code: `P${i}` })).id);
    const writes = w.repo.writeCount();
    const r = await updateProjectField(w.ctx(), customer.id, {
      choices: customer.choices.map((c) => (c.id === "sita" ? { ...c, label: "SITA Group" } : c)),
    });
    expect(r.mirrorsNote).toMatch(/31 projects.*Repair mirrors/);
    expect(w.repo.writeCount() - writes).toBe(2); // History row + the field; no project writes
    expect(mirrorsOf(ids[0]).customer).toBe("SITA");
  });
});

describe("two active project fields never share a name (DI-7)", () => {
  it("restoring a field refuses a name an active field took meanwhile", async () => {
    const notes = await field("notes");
    await archiveProjectField(w.ctx(), notes.id);
    await createProjectField(w.ctx(), { label: notes.label, fieldType: "TEXT" });
    await expectAppError(restoreProjectField(w.ctx(), notes.id), "VALIDATION", /Rename that field first/);
    expect((await field("notes")).archived).toBe(true);
  });

  it("an import keeps an archived field archived when an active field already has its name, and says so", async () => {
    const file = await exportTemplate(w.repo, NOW);
    const notes = await field("notes");
    await archiveProjectField(w.ctx(), notes.id);
    await createProjectField(w.ctx(), { label: notes.label, fieldType: "TEXT" });
    const summary = await previewImport(w.ctx(), file);
    expect(summary.projectFieldsUpdated.join(" | ")).toMatch(/stays archived/);
    await runImport(w, file);
    const active = (await listProjectFields(w.repo)).filter((f) => f.label.toLowerCase() === notes.label.toLowerCase());
    expect(active).toHaveLength(1);
    expect((await field("notes")).archived).toBe(true);
  });

  it("an import does not rename a field to a taken name, and numbers a new field whose name is taken", async () => {
    const file = await exportTemplate(w.repo, NOW);
    const edited: TemplateFile = {
      ...file,
      projectFields: [
        ...(file.projectFields ?? []).map((f) => (f.key === "end-user" ? { ...f, label: "Customer" } : f)),
        { key: "region", label: "Product", fieldType: "TEXT", choices: [], order: 50, showInSummary: false },
      ],
    };
    await runImport(w, edited);
    const fields = await listProjectFields(w.repo);
    const labels = fields.map((f) => f.label.toLowerCase());
    expect(new Set(labels).size).toBe(labels.length);
    expect((await field("end-user")).label).not.toBe("Customer");
    expect((await field("region")).label).toBe("Product (2)");
  });
});

describe("reconcile cleans up second copies of a step (DI-1 safety net)", () => {
  it("moves untouched copies to the trash and out of the cells; keeps a copy someone edited", async () => {
    const projectId = await createProject(w);
    const [s] = await stepsOf(w, projectId);
    const { id: _id, createdAt: _c, updatedAt: _u, ...input } = s;
    const copy = await w.repo.steps.create({ ...input, lastOp: "retried-op" });
    const edited = await w.repo.steps.create({ ...input, lastOp: "retried-op" });
    await w.repo.steps.update(edited.id, { value: { text: "typed into the copy" }, rev: 1 });
    // Before the fix, reconcile put both copies into the cells (they are in the query).
    const r = await reconcileProject(w.ctx(), projectId);
    expect(r.changed).toBe(true);
    const p = (await w.repo.projects.get(projectId))!;
    expect(p.cells[s.id]).toBeDefined();
    expect(p.cells[copy.id]).toBeUndefined();
    expect(w.repo.store.trash.has(copy.id)).toBe(true);
    expect(p.cells[edited.id]).toBeDefined();
    expect(w.repo.store.trash.has(edited.id)).toBe(false);
  });
});
