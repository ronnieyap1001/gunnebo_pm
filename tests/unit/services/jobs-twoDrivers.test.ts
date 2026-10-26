/**
 * DS-1 without the lease: one job driven by two tabs whose calls overlap all the time (calls without a driver id take
 * no lease, so this is the worst case two drivers that take a free job in the same moment can reach). Each tab
 * creates its own copies and saves its own record, but a save keeps what the other recorded, a copy that lost is
 * discarded at once, finalizing works from the record Notion has, and nothing a flow or record uses goes to the trash.
 * The end state is the same as with one tab. (Ported from the review's reproductions; queries lag 2 s.)
 */
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { getProjectPageData } from "@/server/queries/projects";
import type { Repo } from "@/server/repo/types";
import { JOB_LOOKUP } from "@/server/services/jobs";
import { createMilestone } from "@/server/services/library";
import { continueCreateProject, startCreateProject } from "@/server/services/projects";
import { setStepValue } from "@/server/services/steps";
import { continueSync, previewSync, startSync } from "@/server/services/sync";
import { continueImport, startSeed } from "@/server/services/templateIo";
import { driveTab, newProject, projectState, rng, seedLibrary, templateState, type Tab } from "../../support/jobDrivers";
import { LAG_TODAY, lagWorld, type LagWorld } from "./_lag";

afterEach(() => {
  JOB_LOOKUP.sleep = undefined;
});

async function world(): Promise<LagWorld> {
  const w = await lagWorld();
  JOB_LOOKUP.sleep = async (ms) => w.advance(ms);
  return w;
}

/** Both tabs without a driver id; tab B on a cold server instance joins after A's `joinAfter`-th call. */
async function twoTabs(w: LagWorld, cont: (t: Tab) => Promise<{ done: boolean }>, joinAfter: number, seed: number, gapMs = 500) {
  const rand = rng(seed);
  let aCalls = 0;
  let aDone = false;
  await Promise.all([
    driveTab(w, cont as never, { repo: w.repo }, { gapMs, jitterMs: seed ? 600 : 0, rand, onResult: (r) => ((aDone = r.done), aCalls++) }),
    driveTab(w, cont as never, { repo: w.coldRepo() }, { gapMs, jitterMs: seed ? 600 : 0, rand, startWhen: () => aDone || aCalls >= joinAfter }),
  ]);
}

describe("one job, two tabs at once, no lease", { timeout: 120_000 }, () => {
  it("create project: 64 steps, a whole flow, cells for exactly those steps", async () => {
    for (const [joinAfter, seed] of [
      [0, 0],
      [1, 7],
      [3, 0],
      [2, 11],
    ]) {
      const w = await world();
      await seedLibrary(w);
      const opId = randomUUID();
      const { projectId } = await startCreateProject(w.ctx(opId), { code: `C3${joinAfter}${seed}`, name: "Two tabs" });
      await twoTabs(w, (t) => continueCreateProject(w.ctx(opId, t.repo), opId), joinAfter, seed);
      expect({ joinAfter, seed, ...(await projectState(w, projectId)) }).toEqual({
        joinAfter,
        seed,
        steps: 64,
        keys: 64,
        dangling: 0,
        cellsMatch: true,
        setup: "READY",
      });
    }
  });

  it("seed: 64 milestones and 7 fields, each once, and a template flow made of them", async () => {
    for (const [joinAfter, seed] of [
      [0, 0],
      [1, 3],
      [3, 0],
    ]) {
      const w = await world();
      const opId = randomUUID();
      await startSeed(w.ctx(opId));
      await twoTabs(w, (t) => continueImport(w.ctx(opId, t.repo), opId), joinAfter, seed);
      expect({ joinAfter, seed, ...(await templateState(w)) }).toEqual({
        joinAfter,
        seed,
        milestones: 64,
        keys: 64,
        flowNodes: 64,
        dangling: 0,
        liveEdges: 63,
        fields: 7,
        fieldKeys: 7,
      });
    }
  });

  it("sync adding 24 milestones: each new step once and in the flow; a value set meanwhile is kept", async () => {
    const w = await world();
    await seedLibrary(w);
    const projectId = await newProject(w, "C0400");
    for (let i = 0; i < 24; i++) {
      w.advance(3_000);
      await createMilestone(w.ctx(), { name: `Extra ${i}`, fieldType: "TEXT" });
    }
    w.advance(10_000);
    const preview = await previewSync(w.ctx(), projectId);
    const opId = randomUUID();
    await startSync(w.ctx(opId), { projectId, selectedIds: preview.items.filter((i) => i.selectable).map((i) => i.id) });
    let aCalls = 0;
    let edited: string | null = null;
    const user = (async () => {
      // After the first batch the user opens the project page and fills in one of the new milestones.
      while (aCalls < 1) await new Promise((r) => setTimeout(r, 1));
      const page = (await getProjectPageData(w.repo, { today: LAG_TODAY, timeZone: "Asia/Singapore" }, projectId))!;
      const step = page.steps.find((s) => s.name.startsWith("Extra"))!;
      await setStepValue(w.ctx(), { stepId: step.id, value: "Signed", expectedRev: step.rev });
      edited = step.id;
    })();
    await Promise.all([
      driveTab(w, (t) => continueSync(w.ctx(opId, t.repo), opId), { repo: w.repo }, { gapMs: 200, onResult: () => aCalls++ }),
      driveTab(w, (t) => continueSync(w.ctx(opId, t.repo), opId), { repo: w.coldRepo() }, { gapMs: 200 }),
      user,
    ]);
    const state = await projectState(w, projectId);
    expect(state).toMatchObject({ keys: 88, dangling: 0, cellsMatch: true });
    expect(state.steps).toBeLessThanOrEqual(89); // a copy someone filled in stays, as a step of its own
    const kept = await w.repo.steps.get(edited!);
    expect(kept?.value).toEqual({ text: "Signed" });
    const steps = await w.repo.steps.listByProject(projectId);
    const extras = steps.filter((s) => s.name.startsWith("Extra"));
    expect(new Set(extras.map((s) => s.name)).size).toBe(24);
  });

  it("sync: a call whose save takes over the new steps another call recorded puts those steps in the flow", async () => {
    const w = await lagWorld({ queryLagMs: 5_000 });
    JOB_LOOKUP.sleep = async (ms) => w.advance(ms);
    await seedLibrary(w);
    const projectId = await newProject(w, "C0401");
    for (let i = 0; i < 12; i++) {
      w.advance(3_000);
      await createMilestone(w.ctx(), { name: `Extra ${i}`, fieldType: "TEXT" });
    }
    w.advance(10_000);
    const preview = await previewSync(w.ctx(), projectId);
    const opId = randomUUID();
    await startSync(w.ctx(opId), { projectId, selectedIds: preview.items.filter((i) => i.selectable).map((i) => i.id) });
    const driver = "tab-a-0001";
    w.advance(500);
    await continueSync(w.ctx(opId), opId, { driver }); // the first 8 new steps
    w.advance(500);
    // The browser stopped waiting for the next call and sent it again, and the server ran both. Call X creates the last
    // 4 new steps, saves its record and then stops; call Y created its own 4 meanwhile and saves after X, so it takes
    // over X's steps (which it never read: the query does not show them yet) and finalizes with them.
    let xStopped!: () => void;
    const xDone = new Promise<void>((r) => (xStopped = r));
    const x = w.coldRepo();
    const repoX: Repo = { ...x, projects: { ...x.projects, get: () => Promise.reject(new Error("The function stopped.")) } };
    const y = w.coldRepo();
    const repoY: Repo = {
      ...y,
      steps: { ...y.steps, create: async (input) => y.steps.create(input).then(async (s) => (await xDone, s)) },
    };
    const [callX, callY] = await Promise.allSettled([
      continueSync(w.ctx(opId, repoX), opId, { driver }).finally(() => xStopped()),
      continueSync(w.ctx(opId, repoY), opId, { driver }),
    ]);
    expect(callX.status).toBe("rejected");
    expect(callY.status).toBe("fulfilled");
    await driveTab(w, (t) => continueSync(w.ctx(opId, t.repo), opId, { driver }), { repo: w.repo });
    expect(await projectState(w, projectId)).toEqual({ steps: 76, keys: 76, dangling: 0, cellsMatch: true, setup: "READY" });
  });

  it("sync: a new step archived in Notion before the sync finishes keeps its own node (never a milestone's id)", async () => {
    const w = await lagWorld();
    JOB_LOOKUP.sleep = async (ms) => w.advance(ms);
    await seedLibrary(w);
    const projectId = await newProject(w, "C0402");
    for (let i = 0; i < 10; i++) {
      w.advance(3_000);
      await createMilestone(w.ctx(), { name: `Extra ${i}`, fieldType: "TEXT" });
    }
    w.advance(10_000);
    const preview = await previewSync(w.ctx(), projectId);
    const opId = randomUUID();
    await startSync(w.ctx(opId), { projectId, selectedIds: preview.items.filter((i) => i.selectable).map((i) => i.id) });
    w.advance(500);
    await continueSync(w.ctx(opId), opId); // the first 8 new steps
    w.advance(5_000);
    const archived = (await w.repo.steps.listByProject(projectId)).find((s) => s.name === "Extra 0")!;
    await w.repo.steps.update(archived.id, { archived: true, archivedAt: w.ctx().now }); // ticked in Notion
    await driveTab(w, (t) => continueSync(w.ctx(opId, t.repo), opId), { repo: w.repo });
    const { flow } = (await w.repo.projects.get(projectId))!;
    const milestoneIds = new Set((await w.repo.milestones.list({ includeArchived: true })).map((m) => m.id));
    expect(Object.keys(flow.nodes).filter((id) => milestoneIds.has(id))).toEqual([]);
    expect(flow.nodes[archived.id]).toBeDefined();
  });
});
