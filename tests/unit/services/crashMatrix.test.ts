/**
 * Crash at every write of a job (create project, sync, import), resume with the same opId, and compare the end state
 * with an uninterrupted run: no duplicates, nothing skipped, exactly one History row for the job.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { seedTemplateFile } from "@/domain/seed";
import type { TemplateFile } from "@/domain/templateFile";
import { EV } from "@/server/services/context";
import { createMilestone, getTemplate, updateMilestone } from "@/server/services/library";
import { continueCreateProject, startCreateProject } from "@/server/services/projects";
import { bulkSetNotApplicable, setStepValue } from "@/server/services/steps";
import { continueSync, previewSync, startSync } from "@/server/services/sync";
import { continueImport, exportTemplate, startImport } from "@/server/services/templateIo";
import { createProject, historyOfType, milestoneByKey, NOW, seedLibrary, stepByKey, stepsOf, world, type World } from "./_helpers";

/** Runs start/continue to the end, re-calling whichever call crashed (same opId), at most `limit` calls. */
async function drive(start: () => Promise<unknown>, cont: () => Promise<{ done: boolean }>, limit = 200): Promise<void> {
  let started = false;
  for (let i = 0; i < limit; i++) {
    try {
      if (!started) {
        await start();
        started = true;
      }
      if ((await cont()).done) return;
    } catch (e) {
      if (!(e instanceof Error) || !e.message.startsWith("crash")) throw e;
    }
  }
  throw new Error("job did not finish");
}

/** Makes the k-th write from now throw once. */
function crashAt(w: World, k: number) {
  let n = 0;
  w.repo.beforeWrite = (op) => {
    if (++n === k) {
      w.repo.beforeWrite = null;
      throw new Error(`crash at write ${k} (${op})`);
    }
  };
}

async function projectState(w: World, projectId: string) {
  const steps = await stepsOf(w, projectId, true);
  const keyOf = new Map(steps.map((s) => [s.id, s.milestoneKey ?? s.name]));
  const p = (await w.repo.projects.get(projectId))!;
  const msKey = new Map((await w.repo.milestones.list({ includeArchived: true })).map((m) => [m.id, m.key]));
  return {
    setup: p.setup,
    templateRevision: p.templateRevision,
    syncDismissed: Object.entries(p.syncDismissed)
      .map(([k, h]) => `${k.replace(/[0-9a-f-]{36}/g, (id) => msKey.get(id) ?? id)}=${h}`)
      .sort(),
    progress: p.progress,
    steps: steps
      .map((s) => ({ k: s.milestoneKey ?? s.name, t: s.fieldType, v: s.value, na: s.notApplicable, ch: s.choices.map((c) => `${c.id}:${c.label}:${c.state ?? ""}:${c.archived ? 1 : 0}`) }))
      .sort((a, b) => a.k.localeCompare(b.k)),
    edges: p.flow.edges
      .filter((e) => !e.archivedAt)
      .map((e) => `${keyOf.get(e.from)}->${keyOf.get(e.to)}`)
      .sort(),
    cells: Object.keys(p.cells).map((id) => keyOf.get(id)).sort(),
    nodes: Object.keys(p.flow.nodes).length,
  };
}

describe("crash at every write, then resume", { timeout: 120_000 }, () => {
  it("create project", async () => {
    const run = async (k: number | null) => {
      const w = world();
      await seedLibrary(w);
      const opId = randomUUID();
      const before = w.repo.writeCount();
      if (k !== null) crashAt(w, k);
      await drive(
        () => startCreateProject(w.ctx({ opId }), { code: "C0822", name: "Heathrow" }),
        () => continueCreateProject(w.ctx({ opId }), opId),
      );
      const projects = await w.repo.projects.list({ includeArchived: true });
      expect(projects).toHaveLength(1);
      expect(await historyOfType(w, EV.projectCreated)).toHaveLength(1);
      return { state: await projectState(w, projects[0].id), writes: w.repo.writeCount() - before };
    };
    const clean = await run(null);
    expect(clean.state.steps).toHaveLength(64);
    expect(clean.state.edges).toHaveLength(63);
    for (let k = 1; k <= clean.writes; k++) expect((await run(k)).state, `crash at write ${k}`).toEqual(clean.state);
  });

  it("sync", async () => {
    const run = async (k: number | null) => {
      const w = world();
      await seedLibrary(w);
      const projectId = await createProject(w);
      const fat = await stepByKey(w, projectId, "fat-date");
      await setStepValue(w.ctx(), { stepId: fat.id, value: "2026-11-12", expectedRev: 0 });
      const po = await stepByKey(w, projectId, "customer-po-loi");
      await setStepValue(w.ctx(), { stepId: po.id, value: "awaiting", expectedRev: 0 });
      const bom = await milestoneByKey(w, "bom");
      await createMilestone(w.ctx(), { name: "Factory audit", fieldType: "DATE", afterMilestoneId: bom.id });
      for (let i = 0; i < 9; i++) await createMilestone(w.ctx(), { name: `Extra ${i}`, fieldType: "TEXT" });
      const poM = await milestoneByKey(w, "customer-po-loi");
      await updateMilestone(w.ctx(), poM.id, { choices: poM.choices.map((c) => (c.id === "awaiting" ? { ...c, label: "Awaiting PO" } : c)) });
      await updateMilestone(w.ctx(), (await milestoneByKey(w, "fat-date")).id, { fieldType: "DATE_RANGE" });
      for (const m of (await w.repo.milestones.list()).filter((x) => x.fieldType === "DROPDOWN").slice(0, 9)) {
        await updateMilestone(w.ctx(), m.id, { choices: [...m.choices, { label: "Escalated", state: "BLOCKED" }] });
      }
      const preview = await previewSync(w.ctx(), projectId);
      const declined = preview.items.find((i) => i.kind === "updateChoices" && i.milestoneId !== poM.id)!;
      const selected = preview.items.filter((i) => i.selectable && i.id !== declined.id).map((i) => i.id);
      const opId = randomUUID();
      const before = w.repo.writeCount();
      if (k !== null) crashAt(w, k);
      await drive(
        () => startSync(w.ctx({ opId }), { projectId, selectedIds: selected }),
        () => continueSync(w.ctx({ opId }), opId),
      );
      expect(await historyOfType(w, EV.projectSynced)).toHaveLength(1);
      const again = await previewSync(w.ctx(), projectId);
      expect(again.pendingCount).toBe(0);
      return { state: await projectState(w, projectId), writes: w.repo.writeCount() - before };
    };
    const clean = await run(null);
    expect(clean.state.steps).toHaveLength(74);
    expect(clean.state.steps.find((s) => s.k === "fat-date")).toMatchObject({ t: "DATE_RANGE", v: { start: "2026-11-12" } });
    expect(Object.keys(clean.state.syncDismissed)).toHaveLength(1);
    for (let k = 1; k <= clean.writes; k++) expect((await run(k)).state, `crash at write ${k}`).toEqual(clean.state);
  });

  it("import (with a milestone left out and one added)", async () => {
    const run = async (k: number | null) => {
      const w = world();
      await seedLibrary(w);
      const file = await exportTemplate(w.repo, NOW);
      const edited: TemplateFile = {
        ...file,
        milestones: [
          ...file.milestones.filter((m) => m.key !== "training").map((m) => (m.key === "bom" ? { ...m, name: "Bill of materials" } : m)),
          ...Array.from({ length: 10 }, (_, i) => ({ key: `extra-${i}`, name: `Extra ${i}`, fieldType: "TEXT" as const, order: 100 + i, choices: [] })),
        ],
        edges: [
          ...file.edges.filter((e) => e.from !== "training" && e.to !== "training"),
          { from: "installation-progress", to: "sat-commissioning" },
        ],
      };
      const opId = randomUUID();
      const r0 = (await getTemplate(w.repo)).revision;
      const before = w.repo.writeCount();
      if (k !== null) crashAt(w, k);
      await drive(
        () => startImport(w.ctx({ opId }), edited, { reason: "import" }),
        () => continueImport(w.ctx({ opId }), opId),
      );
      expect(await historyOfType(w, EV.templateImported)).toHaveLength(1);
      expect(await historyOfType(w, EV.templateSnapshot)).toHaveLength(1);
      const t = await getTemplate(w.repo);
      const keyOf = new Map(t.milestones.map((m) => [m.id, m.key]));
      return {
        state: {
          revision: t.revision - r0,
          milestones: t.milestones.map((m) => `${m.key}:${m.name}:${m.archived ? 1 : 0}`).sort(),
          edges: t.flow.edges.filter((e) => !e.archivedAt).map((e) => `${keyOf.get(e.from)}->${keyOf.get(e.to)}`).sort(),
          nodes: Object.keys(t.flow.nodes).length,
        },
        writes: w.repo.writeCount() - before,
      };
    };
    const clean = await run(null);
    expect(clean.state.milestones.filter((m) => m.endsWith(":0"))).toHaveLength(73);
    expect(clean.state.milestones).toContain("training:Training:1");
    for (let k = 1; k <= clean.writes; k++) expect((await run(k)).state, `crash at write ${k}`).toEqual(clean.state);
  });

  it("bulk N/A", async () => {
    const run = async (k: number | null) => {
      const w = world();
      await seedLibrary(w);
      const projectId = await createProject(w);
      const ids = (await stepsOf(w, projectId)).slice(0, 6).map((s) => s.id);
      const opId = randomUUID();
      const before = w.repo.writeCount();
      if (k !== null) crashAt(w, k);
      for (let i = 0; i < 5; i++) {
        try {
          await bulkSetNotApplicable(w.ctx({ opId }), { projectId, stepIds: ids, notApplicable: true });
          break;
        } catch (e) {
          if (!(e instanceof Error) || !e.message.startsWith("crash")) throw e;
        }
      }
      const rows = await historyOfType(w, EV.stepNaChanged);
      expect(rows).toHaveLength(1);
      expect((rows[0].data as { stepIds: string[] }).stepIds.sort()).toEqual([...ids].sort());
      return { state: await projectState(w, projectId), writes: w.repo.writeCount() - before };
    };
    const clean = await run(null);
    for (let k = 1; k <= clean.writes; k++) expect((await run(k)).state, `crash at write ${k}`).toEqual(clean.state);
  });

  it("the seed file is the import source used above", () => {
    expect(seedTemplateFile().milestones.length).toBe(64);
  });
});
