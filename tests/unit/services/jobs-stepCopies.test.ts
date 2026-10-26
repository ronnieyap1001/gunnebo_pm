/**
 * Second copies of steps (a create retried while Notion's query did not show the first one):
 * - DS-3: a copy someone added a link, file or note to is never "untouched": it is not discarded, and a sync keeps it
 *   in the flow instead of the untouched copy it recorded.
 * - UI-2 / JC-3: the project page never shows an untouched second copy, also before reconcile has moved it to the trash.
 * Queries lag (fake clock, see _lag.ts).
 */
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { getProjectPageData } from "@/server/queries/projects";
import { addLink } from "@/server/services/attachments";
import { JOB_LOOKUP, loadJob } from "@/server/services/jobs";
import { createMilestone } from "@/server/services/library";
import { addNote } from "@/server/services/notes";
import { continueCreateProject, reconcileProject, startCreateProject } from "@/server/services/projects";
import { continueSync, previewSync, startSync, type SyncJob } from "@/server/services/sync";
import { driveTab, newProject, projectState, seedLibrary, trashedCount } from "../../support/jobDrivers";
import { LAG_TODAY, lagWorld, type LagWorld } from "./_lag";

afterEach(() => {
  JOB_LOOKUP.sleep = undefined;
});

const day = { today: LAG_TODAY, timeZone: "Asia/Singapore" };

async function world(queryLagMs = 2_000): Promise<LagWorld> {
  const w = await lagWorld({ queryLagMs });
  JOB_LOOKUP.sleep = async (ms) => w.advance(ms);
  return w;
}

/** A project, then 10 new FILE milestones and a sync whose job save after the first 8 new steps fails twice. */
async function syncWithCopies(w: LagWorld) {
  await seedLibrary(w);
  const projectId = await newProject(w, "C0500");
  for (let i = 0; i < 10; i++) {
    w.advance(3_000);
    await createMilestone(w.ctx(), { name: `Signed drawings ${i}`, fieldType: "FILE" });
  }
  w.advance(10_000);
  const preview = await previewSync(w.ctx(), projectId);
  const opId = randomUUID();
  await startSync(w.ctx(opId), { projectId, selectedIds: preview.items.filter((i) => i.selectable).map((i) => i.id) });
  w.raw.fake.injectFault({ status: 500, method: "pages.update", count: 2 });
  w.advance(500);
  await expect(continueSync(w.ctx(opId), opId)).rejects.toThrow();
  w.advance(500);
  expect((await continueSync(w.ctx(opId), opId)).done).toBe(false); // creates the 8 again (lag) and records those
  w.advance(10_000);
  const job = (await loadJob<SyncJob>(w.repo, opId))!;
  const recorded = new Set(Object.values(job.createdStepIds ?? {}));
  const copies = (await w.repo.steps.listByProject(projectId)).filter((s) => s.name === "Signed drawings 0");
  expect(copies).toHaveLength(2);
  const unrecorded = copies.find((s) => !recorded.has(s.id))!;
  const recordedCopy = copies.find((s) => recorded.has(s.id))!;
  return { projectId, opId, unrecorded, recordedCopy };
}

describe("a copy someone added a link or note to is kept (DS-3)", { timeout: 60_000 }, () => {
  it("resuming the sync keeps the copy with the link and the note in the flow and discards the untouched one", async () => {
    const w = await world();
    const { projectId, opId, unrecorded, recordedCopy } = await syncWithCopies(w);
    // The user attaches the signed drawings to the copy the job did not record, and writes a note on it.
    await addLink(w.ctx(), { projectId, stepId: unrecorded.id, url: "https://example.com/signed.pdf" });
    await addNote(w.ctx(), { projectId, stepId: unrecorded.id, body: "Customer signed on 24 Oct" });
    w.advance(10_000);
    await reconcileProject(w.ctx(), projectId); // a page view before the sync is resumed
    expect(await w.repo.steps.get(unrecorded.id)).not.toBeNull();
    await driveTab(w, (t) => continueSync(w.ctx(opId, t.repo), opId), { repo: w.repo }, { gapMs: 500 });

    expect(await projectState(w, projectId)).toEqual({ steps: 74, keys: 74, dangling: 0, cellsMatch: true, setup: "READY" });
    const page = (await getProjectPageData(w.repo, day, projectId))!;
    const shown = page.steps.filter((s) => s.name === "Signed drawings 0");
    expect(shown.map((s) => s.id)).toEqual([unrecorded.id]);
    expect(page.flow.nodes[unrecorded.id]).toBeDefined();
    expect(shown[0]).toMatchObject({ state: "DONE", attachmentCount: 1, noteCount: 1 });
    expect(await w.repo.steps.get(recordedCopy.id)).toBeNull(); // the untouched copy went to the trash
  });

  it("reconcile never discards a copy outside the flow that has a note, even when it is otherwise untouched", async () => {
    const w = await world();
    await seedLibrary(w);
    const projectId = await newProject(w, "C0501");
    w.advance(10_000);
    const [step] = await w.repo.steps.listByProject(projectId);
    // A second copy of that step (a retried create), with a note someone wrote on it.
    const { id: _id, createdAt: _c, updatedAt: _u, ...input } = step;
    const copy = await w.repo.steps.create({ ...input, lastOp: step.lastOp });
    await addNote(w.ctx(), { projectId, stepId: copy.id, body: "Spoke to the site manager" });
    w.advance(10_000);
    await reconcileProject(w.ctx(), projectId);
    expect(await w.repo.steps.get(copy.id)).not.toBeNull();
    // Without the note the same copy is discarded.
    const bare = await w.repo.steps.create({ ...input, lastOp: step.lastOp });
    w.advance(10_000);
    await reconcileProject(w.ctx(), projectId);
    expect(await w.repo.steps.get(bare.id)).toBeNull();
  });
});

describe("the project page shows each step once (UI-2, JC-3)", { timeout: 60_000 }, () => {
  it("a step create in the last batch saved by Notion but answered with a 503: the page shows 64 steps right after", async () => {
    for (const lag of [5_000, 9_000, 13_000]) {
      const w = await world(lag);
      await seedLibrary(w);
      const opId = randomUUID();
      const { projectId } = await startCreateProject(w.ctx(opId), { code: "C0502", name: "Lost answer" });
      for (let call = 1; call <= 7; call++) {
        w.advance(300);
        await continueCreateProject(w.ctx(opId), opId);
      }
      w.raw.fake.injectFault({ status: 503, method: "pages.create", afterCommit: true, reportCommittedId: false });
      w.advance(300);
      await expect(continueCreateProject(w.ctx(opId), opId)).rejects.toThrow();
      w.advance(2_000); // runJob's BUSY backoff
      expect((await continueCreateProject(w.ctx(opId), opId)).done).toBe(true);
      for (const wait of [300, 2_000, 5_000, 10_000]) {
        w.advance(wait);
        const page = (await getProjectPageData(w.repo, day, projectId))!;
        const names = page.steps.map((s) => s.name);
        expect({ lag, wait, steps: page.steps.length, twice: names.filter((n, i) => names.indexOf(n) !== i) }).toEqual({ lag, wait, steps: 64, twice: [] });
        expect(page.progress.applicable).toBe(64);
      }
      expect(await projectState(w, projectId)).toEqual({ steps: 64, keys: 64, dangling: 0, cellsMatch: true, setup: "READY" });
      expect(await trashedCount(w, "steps")).toBe(1);
    }
  });

  it("the sync preview does not plan changes for an untouched second copy either", async () => {
    const w = await world();
    await seedLibrary(w);
    const projectId = await newProject(w, "C0503");
    w.advance(10_000);
    // Steps in the middle of the flow (arrows in and out), each with a second copy outside the flow (a retried create
    // the query did not show), not cleaned up yet.
    const { flow } = (await w.repo.projects.get(projectId))!;
    const into = new Set(flow.edges.filter((e) => !e.archivedAt).map((e) => e.to));
    const outOf = new Set(flow.edges.filter((e) => !e.archivedAt).map((e) => e.from));
    const middle = (await w.repo.steps.listByProject(projectId)).filter((s) => into.has(s.id) && outOf.has(s.id));
    for (const step of middle.slice(0, 16)) {
      const { id: _id, createdAt: _c, updatedAt: _u, ...input } = step;
      await w.repo.steps.create({ ...input, lastOp: step.lastOp });
    }
    w.advance(10_000);
    expect((await getProjectPageData(w.repo, day, projectId))!.steps).toHaveLength(64);
    const preview = await previewSync(w.ctx(), projectId);
    expect(preview.items.map((i) => i.kind)).toEqual([]);
  });
});
