/**
 * Import, seed and reset jobs on a lagging Notion (fake clock, see _lag.ts):
 * - JC-1: when the job save after the last creates fails, the retry creates them again; finalizing waits until the
 *   query shows every recorded row and moves the first copies to the trash.
 * - JC-2: a write that fails late in a call is dated at the failure, not at the call's start.
 * - DS-2: two imports that run at the same time never trash each other's rows, and the template flow never points at
 *   a trashed row; a second import, seed or reset is refused while one runs, and a second seed once one finished
 *   (UI-3), each checked against Notion as it is now.
 * - DS-3: a copy someone changed is not discarded.
 */
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TemplateFile } from "@/domain/templateFile";
import type { Repo } from "@/server/repo/types";
import { JOB_LOOKUP, loadJob } from "@/server/services/jobs";
import { getTemplate, updateMilestone } from "@/server/services/library";
import { continueImport, exportTemplate, startImport, startResetTemplate, startSeed, type ImportJob } from "@/server/services/templateIo";
import { driveTab, seedLibrary, templateState, trashedCount } from "../../support/jobDrivers";
import { lagWorld, type LagWorld } from "./_lag";

afterEach(() => {
  JOB_LOOKUP.sleep = undefined;
  vi.restoreAllMocks();
});

async function world(queryLagMs = 2_000, perCallMs = 100): Promise<LagWorld> {
  const w = await lagWorld({ queryLagMs, perCallMs });
  JOB_LOOKUP.sleep = async (ms) => w.advance(ms);
  return w;
}

/** The current template plus `n` new milestones (keys extra-0…). */
async function fileWithExtras(w: LagWorld, n: number, description = ""): Promise<TemplateFile> {
  const file = await exportTemplate(w.repo);
  const last = file.milestones[file.milestones.length - 1];
  for (let i = 0; i < n; i++) {
    file.milestones.push({ key: `extra-${i}`, name: `Extra ${i}`, fieldType: "TEXT", order: last.order + 1 + i, choices: [], ...(description ? { description } : {}) });
  }
  return JSON.parse(JSON.stringify(file)) as TemplateFile;
}

const runImport = (w: LagWorld, opId: string, repo: Repo = w.repo) =>
  driveTab(w, (t) => continueImport(w.ctx(opId, t.repo), opId), { repo }, { gapMs: 0 });

describe("an import whose job save fails after its last creates (JC-1)", { timeout: 60_000 }, () => {
  for (const lag of [3_000, 5_000]) {
    it(`leaves each new milestone once (queries lag ${lag / 1000} s)`, async () => {
      const w = await world(lag);
      await seedLibrary(w);
      w.advance(30_000);
      const opId = randomUUID();
      await startImport(w.ctx(opId), await fileWithExtras(w, 3), { reason: "import" });
      w.advance(1_000);
      // The only pages.update of the first call is the job save after the 3 creates: it fails, and so does its retry.
      w.raw.fake.injectFault({ status: 503, method: "pages.update", count: 2 });
      await expect(continueImport(w.ctx(opId), opId)).rejects.toThrow();
      w.raw.fake.clearFaults();
      w.advance(2_000); // runJob's BUSY backoff; the query does not show the 3 rows yet
      await runImport(w, opId);
      const state = await templateState(w);
      expect(state).toMatchObject({ milestones: 67, keys: 67, flowNodes: 67, dangling: 0 });
      expect(await trashedCount(w, "milestones")).toBe(3);
    });
  }
});

describe("a create that fails late in its call (JC-2)", { timeout: 60_000 }, () => {
  it("is dated at the failure, and the copy Notion saved goes to the trash", async () => {
    const w = await world(5_000);
    const opId = randomUUID();
    await startSeed(w.ctx(opId));
    for (let call = 1; call < 8; call++) {
      w.advance(100);
      await continueImport(w.ctx(opId), opId);
    }
    // In call 8 the last create is saved by Notion and answered with a 504 after the client's 20 s timeout.
    const realNow = Date.now.bind(Date);
    let offset = 0;
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + offset);
    let creates = 0;
    w.beforeCall = (method) => {
      if (method === "pages.create" && ++creates === 8) {
        w.advance(20_000);
        offset += 20_000;
        w.raw.fake.injectFault({ status: 504, method: "pages.create", afterCommit: true, reportCommittedId: false });
      }
    };
    w.advance(100);
    const callStart = w.now();
    await expect(continueImport(w.ctx(opId), opId)).rejects.toThrow();
    w.beforeCall = null;
    const failedAt = (await loadJob<ImportJob>(w.repo, opId))!.failedAt!;
    expect(Date.parse(failedAt) - callStart).toBeGreaterThanOrEqual(20_000);
    w.advance(2_000);
    await driveTab(w, (t) => continueImport(w.ctx(opId, t.repo), opId), { repo: w.repo }, { gapMs: 100 });
    expect(await templateState(w)).toMatchObject({ milestones: 64, keys: 64, flowNodes: 64, dangling: 0, fields: 7 });
    expect(await trashedCount(w, "milestones")).toBe(1);
  });
});

describe("imports that overlap (DS-2, UI-3)", { timeout: 120_000 }, () => {
  it("a second seed is refused while one is loading and once one has loaded, also on another server instance", async () => {
    const w = await world();
    const a = randomUUID();
    await startSeed(w.ctx(a));
    w.advance(300);
    await continueImport(w.ctx(a), a);
    await expect(startSeed(w.ctx(randomUUID()))).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringContaining("already being loaded") });
    w.advance(5_000);
    await expect(startSeed(w.ctx(randomUUID(), w.coldRepo()))).rejects.toMatchObject({ code: expect.stringMatching(/CONFLICT|VALIDATION/) });
    await expect(startResetTemplate(w.ctx(randomUUID(), w.coldRepo()))).rejects.toMatchObject({ code: "CONFLICT" });
    await runImport(w, a);
    // Right after: another instance's query does not show the seed marker yet, but the milestones are there.
    w.advance(500);
    const cold = w.coldRepo();
    await expect(startSeed(w.ctx(randomUUID(), cold))).rejects.toMatchObject({ code: "VALIDATION", message: expect.stringContaining("already loaded") });
    const history = await w.repo.history.listAll({ type: "template.snapshot", limit: 10 });
    expect(history.items).toHaveLength(0);
    expect(await templateState(w)).toMatchObject({ milestones: 64, keys: 64, dangling: 0, fields: 7 });
  });

  it("two seeds that both got started (two server instances within the lag) keep one row per key and a whole flow", async () => {
    for (const [lag, joinAfter] of [
      [2_000, 0],
      [4_000, 1],
    ]) {
      const w = await world(lag);
      const repoA = w.coldRepo();
      const repoB = w.coldRepo();
      const a = randomUUID();
      const b = randomUUID();
      await startSeed(w.ctx(a, repoA));
      let aCalls = 0;
      let aDone = false;
      await Promise.all([
        driveTab(w, (t) => continueImport(w.ctx(a, t.repo), a), { repo: repoA }, { gapMs: 200, onResult: (r) => ((aDone = r.done), aCalls++) }),
        (async () => {
          while (!aDone && aCalls < joinAfter) await new Promise((r) => setTimeout(r, 1));
          await startSeed(w.ctx(b, repoB));
          await driveTab(w, (t) => continueImport(w.ctx(b, t.repo), b), { repo: repoB }, { gapMs: 200 });
        })(),
      ]);
      expect({ lag, joinAfter, ...(await templateState(w)) }).toEqual({
        lag,
        joinAfter,
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

  it("two different files adding the same keys: neither import trashes the other's milestones", async () => {
    const w = await world(4_000);
    await seedLibrary(w);
    w.advance(30_000);
    const fileX = await fileWithExtras(w, 12, "From file X");
    const fileY = await fileWithExtras(w, 12, "From file Y");
    const x = randomUUID();
    const y = randomUUID();
    const repoX = w.coldRepo();
    const repoY = w.coldRepo();
    await startImport(w.ctx(x, repoX), fileX, { reason: "import" });
    await startImport(w.ctx(y, repoY), fileY, { reason: "import" });
    // Both create the first 8 new milestones before either shows in the query; by their next calls they do.
    w.advance(300);
    await continueImport(w.ctx(x, repoX), x);
    w.advance(300);
    await continueImport(w.ctx(y, repoY), y);
    w.advance(5_000);
    await runImport(w, x, repoX);
    await runImport(w, y, repoY);
    w.advance(15_000);
    const extras = (await w.repo.milestones.list()).filter((m) => m.key.startsWith("extra-"));
    // X created all 12; Y created the first 8 (the other 8 were not in the query yet) and found X's 4 others.
    expect(extras.filter((m) => m.description === "From file X")).toHaveLength(12);
    expect(extras.filter((m) => m.description === "From file Y")).toHaveLength(8);
    expect(await trashedCount(w, "milestones")).toBe(0);
    const t = await getTemplate(w.repo);
    const active = new Set(t.milestones.filter((m) => !m.archived).map((m) => m.id));
    expect(Object.keys(t.flow.nodes).filter((id) => !active.has(id))).toEqual([]);
  });
});

describe("a copy someone changed stays (DS-3)", { timeout: 60_000 }, () => {
  it("an unrecorded copy whose description was edited is not discarded", async () => {
    const w = await world(5_000);
    await seedLibrary(w);
    w.advance(30_000);
    const opId = randomUUID();
    await startImport(w.ctx(opId), await fileWithExtras(w, 1), { reason: "import" });
    w.advance(1_000);
    w.raw.fake.injectFault({ status: 503, method: "pages.update", count: 2 });
    await expect(continueImport(w.ctx(opId), opId)).rejects.toThrow();
    w.raw.fake.clearFaults();
    w.advance(2_000);
    w.advance(300);
    expect((await continueImport(w.ctx(opId), opId)).done).toBe(false); // created again, waits for the query
    w.advance(6_000);
    const copies = (await w.repo.milestones.list()).filter((m) => m.key === "extra-0");
    expect(copies).toHaveLength(2);
    const recorded = (await loadJob<ImportJob>(w.repo, opId))!.createdMilestones!["extra-0"];
    const first = copies.find((m) => m.id !== recorded)!;
    await updateMilestone(w.ctx(), first.id, { description: "Checked with the customer" });
    await runImport(w, opId);
    expect(await w.repo.milestones.get(first.id)).toMatchObject({ description: "Checked with the customer", archived: false });
    const t = await getTemplate(w.repo);
    expect(t.flow.nodes[recorded]).toBeDefined();
  });
});
