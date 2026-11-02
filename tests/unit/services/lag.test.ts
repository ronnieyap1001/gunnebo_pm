/**
 * Notion's queries can lag a few seconds behind writes. These tests drive the real services through the real Notion
 * repo on a fake Notion whose queries lag 2 s (each request takes 100 ms of the fake clock, 3 in flight, and the
 * browser calls the next batch 0.5 s after the last one returned): what a job created must come from its own record,
 * not from a fresh query, and screens must not lose rows a query does not show yet.
 */
import { randomUUID } from "node:crypto";
import { RequestTimeoutError } from "@notionhq/client";
import { afterEach, describe, expect, it } from "vitest";
import { cellState } from "@/domain/cells";
import { discoverRegistry } from "@/server/notion/registry";
import type { Repo, StoredStep } from "@/server/repo/types";
import { addLink, archiveAttachment } from "@/server/services/attachments";
import { JOB_LOOKUP, loadJob } from "@/server/services/jobs";
import { createMilestone, getTemplate } from "@/server/services/library";
import { continueCreateProject, reconcileProject, startCreateProject } from "@/server/services/projects";
import { addProjectEdge, addProjectStep } from "@/server/services/steps";
import { continueSync, previewSync, startSync, type SyncJob } from "@/server/services/sync";
import { continueImport, startSeed } from "@/server/services/templateIo";
import { FAKE_OPTS } from "../notion/helpers";
import { driveJob, LAG_TODAY, lagWorld, type LagWorld } from "./_lag";

const day = { today: LAG_TODAY, timeZone: "Asia/Singapore" };

async function seed(w: LagWorld, gapMs = 500): Promise<void> {
  const opId = randomUUID();
  await startSeed(w.ctx(opId));
  await driveJob(w, () => continueImport(w.ctx(opId), opId), gapMs);
}

async function createProject(w: LagWorld, code = "C0822", gapMs = 500): Promise<string> {
  const opId = randomUUID();
  const { projectId } = await startCreateProject(w.ctx(opId), { code, name: "Heathrow T5 gates" });
  await driveJob(w, () => continueCreateProject(w.ctx(opId), opId), gapMs);
  return projectId;
}

/** After the lag has passed: every row as Notion has it. */
async function settled(w: LagWorld, projectId?: string) {
  w.advance(10_000);
  const milestones = await w.repo.milestones.list({ includeArchived: true });
  const fields = await w.repo.projectFields.list({ includeArchived: true });
  const steps: StoredStep[] = projectId ? await w.repo.steps.listByProject(projectId, { includeArchived: true }) : [];
  const project = projectId ? await w.repo.projects.get(projectId) : null;
  return { milestones, fields, steps, project };
}

const unique = (xs: string[]) => new Set(xs).size;

afterEach(() => {
  JOB_LOOKUP.sleep = undefined;
});

describe("jobs record what they created (queries lag 2 s behind writes)", { timeout: 60_000 }, () => {
  it("seed creates exactly 64 milestones and 7 fields", async () => {
    const w = await lagWorld();
    await seed(w);
    const { milestones, fields } = await settled(w);
    expect(milestones).toHaveLength(64);
    expect(unique(milestones.map((m) => m.key))).toBe(64);
    expect(fields).toHaveLength(7);
    expect(unique(fields.map((f) => f.key))).toBe(7);
  });

  it("creating a project creates exactly 64 steps and 64 cells", async () => {
    const w = await lagWorld();
    await seed(w);
    w.advance(10_000);
    const projectId = await createProject(w);
    const { steps, project } = await settled(w, projectId);
    expect(steps).toHaveLength(64);
    expect(unique(steps.map((s) => s.stepKey))).toBe(64);
    expect(Object.keys(project!.cells)).toHaveLength(64);
    expect(new Set(Object.keys(project!.cells))).toEqual(new Set(steps.map((s) => s.id)));
    expect(project!.setup).toBe("READY");
    // Every node of the flow is a real step (the flow was remapped with the recorded ids).
    expect(Object.keys(project!.flow.nodes).every((id) => steps.some((s) => s.id === id))).toBe(true);
  });

  it("sync adding 10 milestones creates exactly 10 steps", async () => {
    const w = await lagWorld();
    await seed(w);
    w.advance(10_000);
    const projectId = await createProject(w);
    for (let i = 0; i < 10; i++) {
      w.advance(3_000);
      await createMilestone(w.ctx(), { name: `Extra ${i}`, fieldType: "TEXT" });
    }
    w.advance(10_000);
    const preview = await previewSync(w.ctx(), projectId);
    const adds = preview.items.filter((i) => i.kind === "addNode" && i.selectable);
    expect(adds).toHaveLength(10);
    const opId = randomUUID();
    await startSync(w.ctx(opId), { projectId, selectedIds: preview.items.filter((i) => i.selectable).map((i) => i.id) });
    await driveJob(w, () => continueSync(w.ctx(opId), opId));
    const { steps, project } = await settled(w, projectId);
    expect(steps).toHaveLength(74);
    expect(unique(steps.map((s) => s.stepKey))).toBe(74);
    expect(Object.keys(project!.cells)).toHaveLength(74);
  });

  it("a batch that lands on another server instance right after the start finds the job (read by id, waits for the query)", async () => {
    const w = await lagWorld();
    await seed(w);
    w.advance(10_000);
    JOB_LOOKUP.sleep = async (ms) => w.advance(ms);
    const opId = randomUUID();
    const { projectId } = await startCreateProject(w.ctx(opId), { code: "C0900", name: "Other instance" });
    // Each call is served by a fresh, cold instance: none of them remembers the job row's id.
    await driveJob(w, () => {
      const cold: Repo = w.coldRepo();
      return continueCreateProject(w.ctx(opId, cold), opId);
    });
    const { steps, project } = await settled(w, projectId);
    expect(steps).toHaveLength(64);
    expect(Object.keys(project!.cells)).toHaveLength(64);
  });

  it("the same when Notion's query lags 5 s: the continue call waits for the job row instead of reporting 'not found'", async () => {
    const w = await lagWorld({ queryLagMs: 5_000 });
    await seed(w);
    w.advance(10_000);
    JOB_LOOKUP.sleep = async (ms) => w.advance(ms);
    const opId = randomUUID();
    const { projectId } = await startCreateProject(w.ctx(opId), { code: "C0902", name: "Slow index" });
    await driveJob(w, () => continueCreateProject(w.ctx(opId, w.coldRepo()), opId), 0);
    const { steps, project } = await settled(w, projectId);
    expect(steps).toHaveLength(64);
    expect(Object.keys(project!.cells)).toHaveLength(64);
  });

  it("a crash between creating steps and saving the job: the retry may duplicate them, finalize moves the extra copies to the trash", async () => {
    const w = await lagWorld();
    await seed(w);
    w.advance(10_000);
    const opId = randomUUID();
    const { projectId } = await startCreateProject(w.ctx(opId), { code: "C0901", name: "Crash" });
    // The first batch creates 8 steps; saving the job afterwards fails twice (it is sent once more after a 5xx).
    w.raw.fake.injectFault({ status: 500, method: "pages.update", count: 2 });
    w.advance(500);
    await expect(continueCreateProject(w.ctx(opId), opId)).rejects.toThrow();
    await driveJob(w, () => continueCreateProject(w.ctx(opId), opId));
    const { steps, project } = await settled(w, projectId);
    expect(steps).toHaveLength(64);
    expect(unique(steps.map((s) => s.stepKey))).toBe(64);
    expect(new Set(Object.keys(project!.cells))).toEqual(new Set(steps.map((s) => s.id)));
    // Nothing was hard-deleted: the extra copies are in Notion's trash, and they are copies of recorded steps.
    const reg = await discoverRegistry(w.raw, FAKE_OPTS);
    const trashed = await w.raw.dataSources.query({ data_source_id: reg.dbs.steps!.dataSourceId, in_trash: true } as never);
    expect(trashed.results.length).toBe(8);
  });

  it("the same for the seed: a crash before the job is saved leaves no second milestone", async () => {
    const w = await lagWorld();
    const opId = randomUUID();
    await startSeed(w.ctx(opId));
    w.raw.fake.injectFault({ status: 500, method: "pages.update", count: 2 }); // saving the job after the first 8 milestones (and its second try)
    w.advance(500);
    await expect(continueImport(w.ctx(opId), opId)).rejects.toThrow();
    await driveJob(w, () => continueImport(w.ctx(opId), opId));
    const { milestones, fields } = await settled(w);
    expect(milestones).toHaveLength(64);
    expect(unique(milestones.map((m) => m.key))).toBe(64);
    expect(fields).toHaveLength(7);
    const reg = await discoverRegistry(w.raw, FAKE_OPTS);
    const trashed = await w.raw.dataSources.query({ data_source_id: reg.dbs.milestones!.dataSourceId, in_trash: true } as never);
    expect(trashed.results.length).toBe(8);
  });

  it("a job save that Notion answers with a 5xx once is sent again, so the seed leaves no second milestone (queries lag 5 s)", async () => {
    const w = await lagWorld({ queryLagMs: 5_000 });
    const opId = randomUUID();
    await startSeed(w.ctx(opId));
    for (let call = 1; call < 8; call++) {
      w.advance(100);
      await continueImport(w.ctx(opId), opId);
    }
    // The 8th call creates the last 8 milestones; saving the job afterwards gets a 502 the first time. Like runJob,
    // the browser calls again 2 s after an error ("Notion is busy").
    w.raw.fake.injectFault({ status: 502, method: "pages.update" });
    await driveJob(w, async () => {
      try {
        return await continueImport(w.ctx(opId), opId);
      } catch {
        w.advance(2_000);
        return { done: false };
      }
    }, 100);
    const { milestones, fields } = await settled(w);
    expect(milestones).toHaveLength(64);
    expect(fields).toHaveLength(7);
  });

  it("the same when the job save times out or the connection drops once (no answer from Notion)", async () => {
    for (const failure of [() => new RequestTimeoutError(), () => new TypeError("fetch failed")]) {
      const w = await lagWorld({ queryLagMs: 5_000 });
      const opId = randomUUID();
      await startSeed(w.ctx(opId));
      for (let call = 1; call < 8; call++) {
        w.advance(100);
        await continueImport(w.ctx(opId), opId);
      }
      let failed = false;
      w.beforeCall = (method) => {
        if (method === "pages.update" && !failed) {
          failed = true; // the 8th call's job save, after its 8 milestones
          throw failure();
        }
      };
      await driveJob(w, async () => {
        try {
          return await continueImport(w.ctx(opId), opId);
        } catch {
          w.advance(2_000);
          return { done: false };
        }
      }, 100);
      w.beforeCall = null;
      expect(failed).toBe(true);
      const { milestones } = await settled(w);
      expect(milestones).toHaveLength(64);
    }
  });

  it("a milestone Notion saved but answered with a 503: the import waits out the lag before it finalizes and trashes the second copy", async () => {
    const w = await lagWorld({ queryLagMs: 5_000 });
    JOB_LOOKUP.sleep = async (ms) => w.advance(ms);
    const opId = randomUUID();
    await startSeed(w.ctx(opId));
    for (let call = 1; call < 8; call++) {
      w.advance(100);
      await continueImport(w.ctx(opId), opId);
    }
    // In the last milestone batch one create is saved by Notion, but the answer is a 503 (nothing names the page).
    w.raw.fake.injectFault({ status: 503, method: "pages.create", afterCommit: true, reportCommittedId: false });
    await driveJob(w, async () => {
      try {
        return await continueImport(w.ctx(opId), opId);
      } catch {
        w.advance(2_000); // runJob: "Notion is busy, retrying"
        return { done: false };
      }
    }, 100);
    const { milestones, fields } = await settled(w);
    expect(milestones).toHaveLength(64);
    expect(unique(milestones.map((m) => m.key))).toBe(64);
    expect(fields).toHaveLength(7);
    const t = await getTemplate(w.repo);
    expect(Object.keys(t.flow.nodes).every((id) => milestones.some((m) => m.id === id))).toBe(true);
    const reg = await discoverRegistry(w.raw, FAKE_OPTS);
    const trashed = await w.raw.dataSources.query({ data_source_id: reg.dbs.milestones!.dataSourceId, in_trash: true } as never);
    expect(trashed.results.length).toBe(1);
  });

  it("the seed's last call records what it created before it finalizes: a failure while finalizing leaves no second project field", async () => {
    const w = await lagWorld({ queryLagMs: 5_000 });
    JOB_LOOKUP.sleep = async (ms) => w.advance(ms);
    const opId = randomUUID();
    await startSeed(w.ctx(opId));
    for (let call = 1; call <= 8; call++) {
      w.advance(100);
      await continueImport(w.ctx(opId), opId); // 8 milestones per call
    }
    // The 9th call creates the 7 project fields and then finalizes; its first finalize write (the template flow row,
    // the 8th page it creates) fails: the connection drops.
    let creates = 0;
    w.beforeCall = (method) => {
      if (method === "pages.create" && ++creates === 8) throw new Error("fetch failed: connection reset");
    };
    await expect(continueImport(w.ctx(opId), opId)).rejects.toThrow(/connection reset/);
    w.beforeCall = null;
    w.advance(2_000);
    await driveJob(w, () => continueImport(w.ctx(opId), opId), 100);
    const { milestones, fields } = await settled(w);
    expect(milestones).toHaveLength(64);
    expect(fields).toHaveLength(7);
    expect(unique(fields.map((f) => f.key))).toBe(7);
  });

  it("finalizing writes its History row last: a failure on the seed marker does not log the seed twice", async () => {
    const w = await lagWorld({ queryLagMs: 5_000 });
    JOB_LOOKUP.sleep = async (ms) => w.advance(ms);
    const opId = randomUUID();
    await startSeed(w.ctx(opId));
    let failed = false;
    w.beforeCall = (method, args) => {
      if (!failed && method === "pages.create" && JSON.stringify(args).includes("seed.appliedAt")) {
        failed = true;
        throw new Error("the server instance stopped");
      }
    };
    await driveJob(w, async () => {
      try {
        return await continueImport(w.ctx(opId), opId);
      } catch {
        w.advance(2_000);
        return { done: false };
      }
    }, 100);
    w.beforeCall = null;
    expect(failed).toBe(true);
    w.advance(10_000);
    const seeded = (await w.repo.history.listAll({ type: "template.seeded", limit: 10 })).items;
    expect(seeded).toHaveLength(1);
    expect(await w.repo.settings.get("seed.appliedAt")).toBeTruthy();
  });

  it("the same for a sync", async () => {
    const w = await lagWorld();
    await seed(w);
    w.advance(10_000);
    const projectId = await createProject(w);
    for (let i = 0; i < 10; i++) {
      w.advance(3_000);
      await createMilestone(w.ctx(), { name: `Extra ${i}`, fieldType: "TEXT" });
    }
    w.advance(10_000);
    const preview = await previewSync(w.ctx(), projectId);
    const opId = randomUUID();
    await startSync(w.ctx(opId), { projectId, selectedIds: preview.items.filter((i) => i.selectable).map((i) => i.id) });
    w.raw.fake.injectFault({ status: 500, method: "pages.update", count: 2 }); // saving the job after the first 8 new steps (and its second try)
    w.advance(500);
    await expect(continueSync(w.ctx(opId), opId)).rejects.toThrow();
    await driveJob(w, () => continueSync(w.ctx(opId), opId));
    const { steps, project } = await settled(w, projectId);
    expect(steps).toHaveLength(74);
    expect(unique(steps.map((s) => s.stepKey))).toBe(74);
    expect(new Set(Object.keys(project!.cells))).toEqual(new Set(steps.map((s) => s.id)));
  });

  it("a reconcile while a sync is unfinished (copies from a crashed batch exist) never trashes a step the sync recorded", async () => {
    const w = await lagWorld();
    await seed(w);
    w.advance(10_000);
    const projectId = await createProject(w);
    for (let i = 0; i < 10; i++) {
      w.advance(3_000);
      await createMilestone(w.ctx(), { name: `Extra ${i}`, fieldType: "TEXT" });
    }
    w.advance(10_000);
    const preview = await previewSync(w.ctx(), projectId);
    const opId = randomUUID();
    await startSync(w.ctx(opId), { projectId, selectedIds: preview.items.filter((i) => i.selectable).map((i) => i.id) });
    w.raw.fake.injectFault({ status: 500, method: "pages.update", count: 2 }); // saving the job after the first 8 new steps (and its second try)
    w.advance(500);
    await expect(continueSync(w.ctx(opId), opId)).rejects.toThrow();
    w.advance(500);
    await continueSync(w.ctx(opId), opId); // creates the 8 again (the query does not show them yet) and records those
    // The tab is closed. Later the project page is opened (it reconciles), then the sync is resumed.
    w.advance(10_000);
    await reconcileProject(w.ctx(), projectId);
    const job = await loadJob<SyncJob>(w.repo, opId);
    const recorded = Object.values(job!.createdStepIds ?? {});
    expect(recorded).toHaveLength(8);
    for (const id of recorded) expect(await w.repo.steps.get(id)).not.toBeNull();
    // Meanwhile the cells count each milestone once.
    const mid = (await w.repo.projects.get(projectId))!;
    const keys = (await w.repo.steps.listByProject(projectId)).filter((s) => mid.cells[s.id]).map((s) => s.stepKey);
    expect(new Set(keys).size).toBe(keys.length);

    await driveJob(w, () => continueSync(w.ctx(opId), opId));
    w.advance(10_000);
    await reconcileProject(w.ctx(), projectId);
    const { steps, project } = await settled(w, projectId);
    expect(steps).toHaveLength(74);
    expect(unique(steps.map((s) => s.stepKey))).toBe(74);
    expect(new Set(Object.keys(project!.cells))).toEqual(new Set(steps.map((s) => s.id)));
    for (const id of recorded) expect(project!.flow.nodes[id]).toBeDefined();
    const reg = await discoverRegistry(w.raw, FAKE_OPTS);
    const trashed = await w.raw.dataSources.query({ data_source_id: reg.dbs.steps!.dataSourceId, in_trash: true } as never);
    expect(trashed.results.length).toBe(8); // only the unrecorded copies, nothing created a third time
  });

  it("a Settings row found through a query is read again by its page id; later reads go by id only", async () => {
    const w = await lagWorld();
    await w.repo.settings.set("job:x", { n: 1 });
    w.advance(10_000);
    const cold = w.coldRepo();
    await cold.settings.get("warm-up");
    w.raw.fake.resetCalls();
    expect(await cold.settings.get("job:x", { fresh: true })).toEqual({ n: 1 });
    expect(w.raw.fake.callCount("dataSources.query")).toBe(1);
    expect(w.raw.fake.callCount("pages.retrieve")).toBe(1);
    w.raw.fake.resetCalls();
    await w.repo.settings.set("job:x", { n: 2 });
    expect(await cold.settings.get("job:x", { fresh: true })).toEqual({ n: 2 });
    expect(w.raw.fake.callCount("dataSources.query")).toBe(0);
  });
});

describe("screens do not lose rows a lagging query does not show yet", { timeout: 60_000 }, () => {
  async function readyProject() {
    const w = await lagWorld();
    await seed(w);
    w.advance(10_000);
    const projectId = await createProject(w);
    return { w, projectId };
  }

  it("reconcile right after creating a project keeps all 64 cells", async () => {
    const w = await lagWorld({ perCallMs: 50 });
    await seed(w);
    w.advance(10_000);
    const projectId = await createProject(w);
    // The browser opens the project page straight away; the page reconciles after rendering.
    w.advance(300);
    await reconcileProject(w.ctx(), projectId);
    expect(Object.keys((await w.repo.projects.get(projectId))!.cells)).toHaveLength(64);
  });

  it("a sync preview right after creating a project does not offer milestones the project already has", async () => {
    const w = await lagWorld({ perCallMs: 50 });
    await seed(w);
    w.advance(10_000);
    const projectId = await createProject(w);
    w.advance(300);
    const preview = await previewSync(w.ctx(), projectId);
    expect(preview.items.filter((i) => i.kind === "addNode")).toEqual([]);
  });

  it("reconcile right after addProjectStep keeps the new cell", async () => {
    const { w, projectId } = await readyProject();
    w.advance(10_000);
    const r = await addProjectStep(w.ctx(), { projectId, name: "Extra check", fieldType: "TEXT" });
    expect(r.project.cells[r.step.id]).toBeDefined();
    w.advance(500);
    const rc = await reconcileProject(w.ctx(), projectId);
    expect(rc.changed).toBe(false);
    const p = (await w.repo.projects.get(projectId))!;
    expect(p.cells[r.step.id]).toBeDefined();
    expect(Object.keys(p.cells)).toHaveLength(65);
    // An arrow to the new step can be drawn straight away too.
    const first = Object.keys(p.cells).find((id) => id !== r.step.id)!;
    await expect(addProjectEdge(w.ctx(), projectId, first, r.step.id)).resolves.toMatchObject({ to: r.step.id });
  });

  it("reconcile still drops the cell of a step archived in Notion", async () => {
    const { w, projectId } = await readyProject();
    const p0 = (await w.repo.projects.get(projectId))!;
    const victim = Object.keys(p0.cells)[3];
    await w.repo.steps.update(victim, { archived: true });
    w.advance(10_000);
    expect((await reconcileProject(w.ctx(), projectId)).changed).toBe(true);
    expect((await w.repo.projects.get(projectId))!.cells[victim]).toBeUndefined();
  });

  it("addLink on a FILE step makes it Done immediately (cell, stateChangedAt and the State mirror)", async () => {
    const { w, projectId } = await readyProject();
    w.advance(10_000);
    const { step } = await addProjectStep(w.ctx(), { projectId, name: "Signed drawings", fieldType: "FILE" });
    w.advance(10_000);
    const added = await addLink(w.ctx(), { projectId, stepId: step.id, url: "https://example.com/drawings.pdf" });
    expect(added.project.cells[step.id].fc).toBe(1);
    expect(cellState(added.project.cells[step.id], day).state).toBe("DONE");
    const s1 = (await w.repo.steps.get(step.id))!;
    expect(s1.stateChangedAt).toBeDefined();
    expect(await stateMirror(w, step.id)).toBe("Done");
    // The page reconciles right after: the link is not in the query yet, the count stays.
    w.advance(500);
    await reconcileProject(w.ctx(), projectId);
    expect((await w.repo.projects.get(projectId))!.cells[step.id].fc).toBe(1);

    // Removing the only link makes it Not started again, also straight away.
    w.advance(500);
    const removed = await archiveAttachment(w.ctx(), added.attachment.id);
    expect(removed.project.cells[step.id].fc).toBeUndefined();
    expect(cellState(removed.project.cells[step.id], day).state).toBe("NOT_STARTED");
    expect(await stateMirror(w, step.id)).toBe("Not started");
  });
});

async function stateMirror(w: LagWorld, stepId: string): Promise<string | null> {
  const page = await w.raw.pages.retrieve({ page_id: stepId });
  const props = (page as { properties: Record<string, { type: string; select?: { name: string } | null }> }).properties;
  const state = Object.entries(props).find(([name]) => name === "State")?.[1];
  return state?.select?.name ?? null;
}
