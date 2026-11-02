import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { seedTemplateFile } from "@/domain/seed";
import type { TemplateFile } from "@/domain/templateFile";
import { EV, SETTINGS } from "@/server/services/context";
import { createMilestone, getTemplate, updateMilestone } from "@/server/services/library";
import { addProjectFieldChoice, listProjectFields, updateProjectField } from "@/server/services/projectFields";
import {
  continueImport,
  exportTemplate,
  previewImport,
  startImport,
  startResetTemplate,
  startSeed,
} from "@/server/services/templateIo";
import { createProject, expectAppError, historyOfType, milestoneByKey, NOW, runImport, seedLibrary, world, type World } from "./_helpers";

let w: World;
beforeEach(() => {
  w = world();
});

describe("seed", () => {
  it("loads 64 milestones, a 63-arrow chain with positions, 7 project fields; no snapshot; seed.appliedAt", async () => {
    await seedLibrary(w);
    const t = await getTemplate(w.repo);
    expect(t.milestones).toHaveLength(64);
    expect(t.flow.edges.filter((e) => !e.archivedAt)).toHaveLength(63);
    expect(Object.keys(t.flow.nodes).sort()).toEqual(t.milestones.map((m) => m.id).sort());
    expect(t.revision).toBe(1);
    expect(await listProjectFields(w.repo)).toHaveLength(7);
    expect(await historyOfType(w, EV.templateSnapshot)).toHaveLength(0);
    expect(await historyOfType(w, EV.templateSeeded)).toHaveLength(1);
    expect(await w.repo.settings.get(SETTINGS.seedAppliedAt)).toBe(NOW);
    await expectAppError(startSeed(w.ctx()), "VALIDATION", /already loaded/);
  });

  it("runs in batches of 8 and an interrupted batch resumes without duplicates", async () => {
    const opId = randomUUID();
    await startSeed(w.ctx({ opId }));
    await continueImport(w.ctx(), opId);
    expect((await w.repo.milestones.list()).length).toBe(8);
    let n = 0;
    w.repo.beforeWrite = (op) => {
      if (op === "milestones.create" && ++n === 5) throw new Error("boom");
    };
    await expect(continueImport(w.ctx(), opId)).rejects.toThrow("boom");
    w.repo.beforeWrite = null;
    let calls = 0;
    while (!(await continueImport(w.ctx(), opId)).done) calls++;
    expect(calls).toBeGreaterThan(5);
    const ms = await w.repo.milestones.list();
    expect(ms).toHaveLength(64);
    expect(new Set(ms.map((m) => m.key)).size).toBe(64);
    expect((await continueImport(w.ctx(), opId)).done).toBe(true);
    expect(await historyOfType(w, EV.templateSeeded)).toHaveLength(1);
  });
});

describe("import", () => {
  beforeEach(async () => {
    await seedLibrary(w);
  });

  it("export -> import round trip keeps ids and changes nothing but the revision", async () => {
    const before = await getTemplate(w.repo);
    const file = await exportTemplate(w.repo, NOW);
    expect(file.milestones).toHaveLength(64);
    expect(file.edges).toHaveLength(63);
    const summary = await previewImport(w.ctx(), JSON.parse(JSON.stringify(file)));
    expect(summary).toMatchObject({ added: [], updated: [], archived: [], choiceChanges: [], edgesAdded: 0, edgesRemoved: 0 });
    await runImport(w, JSON.stringify(file));
    const after = await getTemplate(w.repo);
    expect(after.milestones.map((m) => m.id).sort()).toEqual(before.milestones.map((m) => m.id).sort());
    expect(after.flow.edges.map((e) => e.id).sort()).toEqual(before.flow.edges.map((e) => e.id).sort());
    expect(after.flow.nodes).toEqual(before.flow.nodes);
    expect(after.revision).toBe(before.revision + 1);
  });

  it("writes a template.snapshot History row (the current export) before importing", async () => {
    const current = await exportTemplate(w.repo, NOW);
    const file = seedTemplateFile();
    await runImport(w, file);
    const rows = (await w.repo.history.listAll({ limit: 100 })).items;
    const snapshot = rows.find((r) => r.type === EV.templateSnapshot)!;
    const imported = rows.find((r) => r.type === EV.templateImported)!;
    expect(snapshot).toBeTruthy();
    expect(imported).toBeTruthy();
    expect(snapshot.seq).toBeLessThan(imported.seq);
    expect((snapshot.data as { file: TemplateFile }).file).toEqual({ ...current, exportedAt: NOW });
    expect(snapshot.source).toBe("SYSTEM");
  });

  it("a milestone missing from the file is archived, not deleted; a returning one is restored with its id", async () => {
    const file = await exportTemplate(w.repo, NOW);
    const bom = await milestoneByKey(w, "bom");
    const trimmed: TemplateFile = {
      ...file,
      milestones: file.milestones.filter((m) => m.key !== "bom"),
      edges: [
        ...file.edges.filter((e) => e.from !== "bom" && e.to !== "bom"),
        { from: "specification-freeze", to: "customer-drawings-approval" },
      ],
    };
    const summary = await previewImport(w.ctx(), trimmed);
    expect(summary.archived).toEqual(["BOM"]);
    await runImport(w, trimmed);
    const archived = (await w.repo.milestones.list({ includeArchived: true })).find((m) => m.id === bom.id)!;
    expect(archived).toMatchObject({ archived: true, archivedAt: NOW });
    expect(await w.repo.milestones.list()).toHaveLength(63);
    const t = await getTemplate(w.repo);
    expect(t.flow.edges.filter((e) => !e.archivedAt && (e.from === bom.id || e.to === bom.id))).toEqual([]);
    expect(t.flow.edges.filter((e) => e.archivedReason === "IMPORT")).toHaveLength(2);

    // Importing the full file again restores the same milestone (same id) and its arrows.
    await runImport(w, file);
    const back = (await w.repo.milestones.list()).find((m) => m.key === "bom")!;
    expect(back.id).toBe(bom.id);
    expect(back.archived).toBe(false);
    expect(back.archivedAt).toBeUndefined();
    expect((await getTemplate(w.repo)).flow.edges.filter((e) => !e.archivedAt)).toHaveLength(63);
  });

  it("merges choices by id (missing ones archived) and adds new milestones", async () => {
    const file = await exportTemplate(w.repo, NOW);
    const edited: TemplateFile = {
      ...file,
      milestones: [
        ...file.milestones.map((m) =>
          m.key === "bom" ? { ...m, name: "Bill of materials", choices: m.choices.filter((c) => c.id !== "revised") } : m,
        ),
        { key: "factory-audit", name: "Factory audit", fieldType: "DATE" as const, order: 23.5, choices: [] },
      ],
    };
    await runImport(w, edited);
    const bom = await milestoneByKey(w, "bom");
    expect(bom.name).toBe("Bill of materials");
    expect(bom.choices.find((c) => c.id === "revised")).toMatchObject({ archived: true });
    expect(await milestoneByKey(w, "factory-audit")).toMatchObject({ fieldType: "DATE", archived: false });
  });

  it("rejects an invalid file with plain-English errors", async () => {
    await expectAppError(previewImport(w.ctx(), { format: "nope" }), "VALIDATION", /not a Gunnebo PM template/);
    const file = await exportTemplate(w.repo, NOW);
    const looped = { ...file, edges: [...file.edges, { from: "project-closed", to: "enquiry-rfq-received" }] };
    await expect(startImport(w.ctx(), looped, { reason: "import" })).rejects.toMatchObject({
      code: "VALIDATION",
      details: { errors: [expect.stringMatching(/loop/)] },
    });
  });

  it("never breaks project-field values: a choice added locally survives an import of the seed", async () => {
    const customer = (await listProjectFields(w.repo)).find((f) => f.systemKey === "customer")!;
    const { choiceId } = await addProjectFieldChoice(w.ctx(), customer.id, "Thales");
    const id = await createProject(w, { code: "C1", details: { [customer.id]: choiceId } });
    await runImport(w, seedTemplateFile());
    const after = (await listProjectFields(w.repo)).find((f) => f.systemKey === "customer")!;
    expect(after.choices.find((c) => c.id === choiceId)).toMatchObject({ label: "Thales", archived: true });
    expect((await w.repo.projects.get(id))!.details[customer.id]).toEqual({ choiceId });
  });
});

describe("reset template to seed", () => {
  it("snapshots first, restores the seed milestones, keeps projects and existing project fields", async () => {
    await seedLibrary(w);
    const projectId = await createProject(w);
    const extra = await createMilestone(w.ctx(), { name: "Local step", fieldType: "TEXT" });
    const bom = await milestoneByKey(w, "bom");
    await updateMilestone(w.ctx(), bom.id, { name: "Bill of materials" });
    const product = (await listProjectFields(w.repo)).find((f) => f.key === "product")!;
    await updateProjectField(w.ctx(), product.id, { label: "Gate model" });

    const opId = randomUUID();
    await startResetTemplate(w.ctx({ opId }));
    const snapshot = await historyOfType(w, EV.templateSnapshot);
    expect(snapshot).toHaveLength(1);
    expect((snapshot[0].data as { reason: string }).reason).toBe("reset");
    while (!(await continueImport(w.ctx(), opId)).done);

    expect((await milestoneByKey(w, "bom")).name).toBe("BOM");
    expect((await w.repo.milestones.list({ includeArchived: true })).find((m) => m.id === extra.id)).toMatchObject({ archived: true });
    expect((await listProjectFields(w.repo)).find((f) => f.key === "product")!.label).toBe("Gate model");
    expect(await w.repo.projects.get(projectId)).toBeTruthy();
    expect((await w.repo.steps.listByProject(projectId)).length).toBe(64);
    expect(await historyOfType(w, EV.templateImported)).toHaveLength(1);
  });
});
