/**
 * DS-1: one job driven from two tabs, windows or server instances. The run that works on a job holds a lease in the job
 * row; another run gets RUNNING_ELSEWHERE (and creates nothing) until the job is finished or the lease runs out, then
 * finishes it or takes over. Whatever the timing, the job ends with one active row per planned step, milestone or
 * field, and no flow node pointing at a trashed or missing row. Queries lag (fake clock, see _lag.ts).
 */
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMilestone } from "@/server/services/library";
import {
  claimJob,
  getJobStatus,
  JOB_LOOKUP,
  LEASE_MAX_MS,
  LEASE_MS,
  listOpenJobs,
  loadJob,
  RUNNING_ELSEWHERE,
  RUNNING_ELSEWHERE_MESSAGE,
  saveRunningJob,
  type JobBase,
  type JobCall,
} from "@/server/services/jobs";
import { continueCreateProject, startCreateProject } from "@/server/services/projects";
import { continueSync, previewSync, startSync } from "@/server/services/sync";
import { continueImport, exportTemplate, startImport, startSeed } from "@/server/services/templateIo";
import { driveTab, newProject, projectState, rng, seedLibrary, templateState, trashedCount, type Tab } from "../../support/jobDrivers";
import { lagWorld, type LagWorld } from "./_lag";

afterEach(() => {
  JOB_LOOKUP.sleep = undefined;
  vi.restoreAllMocks();
});

async function world(queryLagMs = 2_000): Promise<LagWorld> {
  const w = await lagWorld({ queryLagMs });
  JOB_LOOKUP.sleep = async (ms) => w.advance(ms);
  return w;
}

const tabA = (w: LagWorld): Tab => ({ driver: `tab-a-${randomUUID()}`, repo: w.repo });
const tabB = (w: LagWorld): Tab => ({ driver: `tab-b-${randomUUID()}`, repo: w.coldRepo() });

describe("a job runs in one tab at a time", { timeout: 60_000 }, () => {
  it("a second tab gets RUNNING_ELSEWHERE and creates nothing while the first runs the job, then sees it finished", async () => {
    const w = await world();
    await seedLibrary(w);
    const opId = randomUUID();
    const { projectId } = await startCreateProject(w.ctx(opId), { code: "C0100", name: "Two tabs" });
    const a = tabA(w);
    const b = tabB(w);
    w.advance(300);
    expect((await continueCreateProject(w.ctx(opId, a.repo), opId, { driver: a.driver })).doneCount).toBe(8);

    const creates = w.raw.fake.callCount("pages.create");
    w.advance(300);
    const waiting = await continueCreateProject(w.ctx(opId, b.repo), opId, { driver: b.driver });
    expect(waiting).toMatchObject({ done: false, code: RUNNING_ELSEWHERE, message: RUNNING_ELSEWHERE_MESSAGE, doneCount: 8, projectId });
    expect(waiting.retryInMs).toBeGreaterThan(0);
    expect(w.raw.fake.callCount("pages.create")).toBe(creates);

    // Setup's Unfinished tasks know the job is running elsewhere, not interrupted.
    const open = (await listOpenJobs(w.repo)).find((j) => j.opId === opId)!;
    expect(Date.parse(open.leaseUntil!)).toBeGreaterThan(w.now());
    expect((await getJobStatus(w.repo, opId))!.leaseUntil).toBe(open.leaseUntil);

    await driveTab(w, (t) => continueCreateProject(w.ctx(opId, t.repo), opId, { driver: t.driver }), a);
    w.advance(300);
    expect((await continueCreateProject(w.ctx(opId, b.repo), opId, { driver: b.driver })).done).toBe(true);
    expect(await projectState(w, projectId)).toEqual({ steps: 64, keys: 64, dangling: 0, cellsMatch: true, setup: "READY" });
    expect(await trashedCount(w, "steps")).toBe(0);
  });

  it("the same run carries on at once after a failed call; another tab still waits", async () => {
    const w = await world();
    await seedLibrary(w);
    const opId = randomUUID();
    await startCreateProject(w.ctx(opId), { code: "C0101", name: "Retry" });
    const a = tabA(w);
    const b = tabB(w);
    w.advance(300);
    await continueCreateProject(w.ctx(opId), opId, { driver: a.driver });
    w.raw.fake.injectFault({ status: 500, method: "pages.create" });
    w.advance(300);
    await expect(continueCreateProject(w.ctx(opId), opId, { driver: a.driver })).rejects.toThrow();
    w.advance(2_000);
    expect((await continueCreateProject(w.ctx(opId, b.repo), opId, { driver: b.driver })).code).toBe(RUNNING_ELSEWHERE);
    w.advance(300);
    const again = await continueCreateProject(w.ctx(opId), opId, { driver: a.driver });
    expect(again.code).toBeUndefined();
    expect(again.doneCount).toBeGreaterThanOrEqual(16);
  });

  it("a tab closed part-way is taken over once its lease has run out", async () => {
    const w = await world();
    await seedLibrary(w);
    const opId = randomUUID();
    const { projectId } = await startCreateProject(w.ctx(opId), { code: "C0102", name: "Closed tab" });
    const a = tabA(w);
    const b = tabB(w);
    await driveTab(w, (t) => continueCreateProject(w.ctx(opId, t.repo), opId, { driver: t.driver }), a, { stopAfter: 3 });
    const closedAt = w.now();
    let firstWork = 0;
    const run = await driveTab(w, (t) => continueCreateProject(w.ctx(opId, t.repo), opId, { driver: t.driver }), b, {
      onResult: (r) => {
        if (!r.code && !firstWork) firstWork = w.now();
      },
    });
    expect(run.done).toBe(true);
    expect(run.waits).toBeGreaterThan(0);
    expect(firstWork - closedAt).toBeGreaterThanOrEqual(LEASE_MS - 5_000);
    expect(await projectState(w, projectId)).toEqual({ steps: 64, keys: 64, dangling: 0, cellsMatch: true, setup: "READY" });
  });

  /**
   * An import of 10 new milestones driven by two open tabs while every Notion call takes `callMs`, so one call takes
   * about a minute or more. A lease that only lasted LEASE_MS ran out mid-call: the other tab took the job over, its claim wrote back
   * the record it had read (undoing the save of the call it interrupted), and the two tabs kept taking the job from
   * each other without either finishing it. `serverClock`: a call's own clock moves with Notion's, as on a server.
   */
  async function slowImport(seed: number, serverClock: boolean, callMs: number) {
    const w = await world();
    await seedLibrary(w);
    w.advance(30_000);
    const file = await exportTemplate(w.repo);
    const last = file.milestones[file.milestones.length - 1];
    for (let i = 0; i < 10; i++) {
      file.milestones.push({ key: `extra-${i}`, name: `Extra ${i}`, fieldType: "TEXT", order: last.order + 1 + i, choices: [] });
    }
    const opId = randomUUID();
    await startImport(w.ctx(opId), JSON.parse(JSON.stringify(file)), { reason: "import" });
    w.beforeCall = () => w.advance(callMs - 100);
    if (serverClock) vi.spyOn(Date, "now").mockImplementation(() => w.now());
    const cont = (t: Tab) => continueImport(w.ctx(opId, t.repo), opId, { driver: t.driver });
    const rand = rng(seed);
    let aCalls = 0;
    const runs = await Promise.all([
      driveTab(w, cont, tabA(w), { gapMs: 200, jitterMs: 800, rand, maxCalls: 120, onResult: () => aCalls++ }),
      driveTab(w, cont, tabB(w), { gapMs: 200, jitterMs: 800, rand, maxCalls: 120, startWhen: () => aCalls >= 1 }),
    ]);
    vi.restoreAllMocks();
    w.beforeCall = null;
    expect(runs.map((r) => r.done)).toEqual([true, true]);
    expect(await templateState(w)).toMatchObject({ milestones: 74, keys: 74, dangling: 0, fields: 7 });
    return runs;
  }

  it("on a slow Notion (one call takes longer than LEASE_MS) two open tabs still finish the job", async () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) await slowImport(seed, true, 5_000);
    // Without a server clock a call's own time does not show how slow it was: only a lease taken over grows.
    for (const seed of [1, 2, 3, 4, 5, 6]) await slowImport(seed, false, 3_000);
  });

  it("a save renews the lease for twice as long as its call took; a lease taken over lasts twice as long as the one that ran out", async () => {
    const w = await world();
    await seedLibrary(w);
    const opId = randomUUID();
    await startCreateProject(w.ctx(opId), { code: "C0103", name: "Lease length" });
    const call = (driver: string, elapsed: number): JobCall => {
      const ctx = w.ctx(opId);
      return { ctx, driver, now: () => new Date(Date.parse(ctx.now) + elapsed).toISOString(), elapsedMs: () => elapsed };
    };
    const leaseAfterSave = async (c: JobCall) => {
      await saveRunningJob(c, (await loadJob<JobBase>(w.repo, opId))!);
      const { lease } = (await loadJob<JobBase>(w.repo, opId))!;
      return { ms: lease!.ms, from: Date.parse(lease!.until) - Date.parse(c.now()) };
    };
    expect(await leaseAfterSave(call("tab-a-0001", 5_000))).toEqual({ ms: LEASE_MS, from: LEASE_MS });
    expect(await leaseAfterSave(call("tab-a-0001", 50_000))).toEqual({ ms: 100_000, from: 100_000 });
    expect(await leaseAfterSave(call("tab-a-0001", 400_000))).toEqual({ ms: LEASE_MAX_MS, from: LEASE_MAX_MS });

    // Tab A's lease of 100 s (saved 50 s into its call) runs out; tab B takes the job over for 200 s.
    await leaseAfterSave(call("tab-a-0001", 50_000));
    w.advance(151_000);
    const b = call("tab-b-0001", 0);
    const claim = await claimJob(b, (await loadJob<JobBase>(w.repo, opId))!);
    expect(claim.wait).toBeUndefined();
    expect(claim.job!.lease).toMatchObject({ driver: "tab-b-0001", ms: 200_000 });
  });
});

describe("two tabs at any timing end with one row per planned item and a whole flow", { timeout: 120_000 }, () => {
  const timings = [
    { lag: 500, joinAfter: 0, seed: 1 },
    { lag: 2_000, joinAfter: 1, seed: 2 },
    { lag: 5_000, joinAfter: 3, seed: 3 },
    { lag: 2_000, joinAfter: 0, seed: 4 },
  ];

  /** Tab B joins after tab A's `joinAfter`-th call; both run until done (gaps 200–1,000 ms of fake time). */
  async function twoTabs(w: LagWorld, cont: (t: Tab) => Promise<{ done: boolean }>, joinAfter: number, seed: number) {
    const rand = rng(seed);
    const a = tabA(w);
    const b = tabB(w);
    let aCalls = 0;
    let aDone = false;
    await Promise.all([
      driveTab(w, cont as never, a, { gapMs: 200, jitterMs: 800, rand, onResult: (r) => ((aDone = r.done), aCalls++) }),
      driveTab(w, cont as never, b, { gapMs: 200, jitterMs: 800, rand, startWhen: () => aDone || aCalls >= joinAfter }),
    ]);
  }

  it("create project", async () => {
    for (const t of timings) {
      const w = await world(t.lag);
      await seedLibrary(w);
      const opId = randomUUID();
      const { projectId } = await startCreateProject(w.ctx(opId), { code: `C1${t.seed}`, name: "Two tabs" });
      await twoTabs(w, (tab) => continueCreateProject(w.ctx(opId, tab.repo), opId, { driver: tab.driver }), t.joinAfter, t.seed);
      expect({ ...t, ...(await projectState(w, projectId)) }).toEqual({ ...t, steps: 64, keys: 64, dangling: 0, cellsMatch: true, setup: "READY" });
    }
  });

  it("seed", async () => {
    for (const t of timings) {
      const w = await world(t.lag);
      const opId = randomUUID();
      await startSeed(w.ctx(opId));
      await twoTabs(w, (tab) => continueImport(w.ctx(opId, tab.repo), opId, { driver: tab.driver }), t.joinAfter, t.seed);
      expect({ ...t, ...(await templateState(w)) }).toEqual({
        ...t,
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

  it("sync", async () => {
    for (const t of timings.slice(0, 2)) {
      const w = await world(t.lag);
      await seedLibrary(w);
      const projectId = await newProject(w, `C2${t.seed}`);
      for (let i = 0; i < 12; i++) {
        w.advance(3_000);
        await createMilestone(w.ctx(), { name: `Extra ${i}`, fieldType: "TEXT" });
      }
      w.advance(10_000);
      const preview = await previewSync(w.ctx(), projectId);
      const opId = randomUUID();
      await startSync(w.ctx(opId), { projectId, selectedIds: preview.items.filter((i) => i.selectable).map((i) => i.id) });
      await twoTabs(w, (tab) => continueSync(w.ctx(opId, tab.repo), opId, { driver: tab.driver }), t.joinAfter, t.seed);
      expect({ ...t, ...(await projectState(w, projectId)) }).toEqual({ ...t, steps: 76, keys: 76, dangling: 0, cellsMatch: true, setup: "READY" });
    }
  });
});
