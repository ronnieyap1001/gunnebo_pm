/**
 * Job saves:
 * - JC-4: only the save that creates a job's row is never sent twice; every later save (e.g. the one recording the new
 *   project's id) gets its one retry after a 5xx, so a single 503 no longer leads to a second project with the code.
 * - JC-5: a job that could outgrow what Notion stores in one value is refused at the start, before anything is
 *   written, instead of failing half-way on every later call.
 */
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { TemplateFile } from "@/domain/templateFile";
import { discoverRegistry } from "@/server/notion/registry";
import { JOB_LOOKUP, jobKey } from "@/server/services/jobs";
import { continueCreateProject, startCreateProject } from "@/server/services/projects";
import { continueImport, startImport } from "@/server/services/templateIo";
import { FAKE_OPTS } from "../notion/helpers";
import { driveTab, seedLibrary } from "../../support/jobDrivers";
import { lagWorld, type LagWorld } from "./_lag";

afterEach(() => {
  JOB_LOOKUP.sleep = undefined;
});

async function settingRows(w: LagWorld, key: string): Promise<number> {
  const reg = await discoverRegistry(w.raw, FAKE_OPTS);
  const e = reg.dbs.settings!;
  const r = (await w.raw.dataSources.query({ data_source_id: e.dataSourceId, filter: { property: e.props.key, title: { equals: key } } } as never)) as {
    results: unknown[];
  };
  return r.results.length;
}

describe("saving a job (JC-4)", { timeout: 60_000 }, () => {
  it("a single 503 on the save that records the new project's id is sent again: one project with the code", async () => {
    const w = await lagWorld({ queryLagMs: 5_000 });
    JOB_LOOKUP.sleep = async (ms) => w.advance(ms);
    await seedLibrary(w);
    const opId = randomUUID();
    let updates = 0;
    w.beforeCall = (method) => {
      if (method === "pages.update" && ++updates === 1) w.raw.fake.injectFault({ status: 503, method: "pages.update" });
    };
    const { projectId } = await startCreateProject(w.ctx(opId), { code: "C0800", name: "Once" });
    w.beforeCall = null;
    expect(updates).toBe(2);
    await driveTab(w, (t) => continueCreateProject(w.ctx(opId, t.repo), opId), { repo: w.repo }, { gapMs: 500 });
    w.advance(20_000);
    const withCode = (await w.repo.projects.list()).filter((p) => p.code === "C0800");
    expect(withCode.map((p) => [p.id, p.setup])).toEqual([[projectId, "READY"]]);
  });

  it("the save that creates the job's row is not sent twice (a second row for one job)", async () => {
    const w = await lagWorld({ queryLagMs: 5_000 });
    JOB_LOOKUP.sleep = async (ms) => w.advance(ms);
    await seedLibrary(w);
    const opId = randomUUID();
    let creates = 0;
    w.beforeCall = (method, args) => {
      if (method === "pages.create" && JSON.stringify(args).includes(jobKey(opId)) && ++creates === 1) {
        w.raw.fake.injectFault({ status: 503, method: "pages.create", afterCommit: true, reportCommittedId: false });
      }
    };
    await expect(startCreateProject(w.ctx(opId), { code: "C0801", name: "Once" })).rejects.toThrow();
    w.beforeCall = null;
    w.advance(10_000);
    expect(creates).toBe(1);
    expect(await settingRows(w, jobKey(opId))).toBe(1);
  });
});

function bigFile(n: number): TemplateFile {
  const milestones = Array.from({ length: n }, (_, i) => ({
    key: `milestone-number-${String(i).padStart(4, "0")}`,
    name: `Milestone ${i}`,
    description: "d".repeat(500),
    fieldType: "TEXT" as const,
    order: i + 1,
    choices: [],
  }));
  const edges = milestones.slice(1).map((m, i) => ({ from: milestones[i].key, to: m.key }));
  return { format: "gunnebo-pm.template", version: 1, milestones, edges } as unknown as TemplateFile;
}

describe("a job that could outgrow Notion's limit (JC-5)", { timeout: 60_000 }, () => {
  it("is refused at the start with nothing written; a file that starts always finishes", async () => {
    const w = await lagWorld({ queryLagMs: 0, perCallMs: 1 });
    JOB_LOOKUP.sleep = async () => undefined;
    const big = randomUUID();
    await expect(startImport(w.ctx(big), bigFile(232), { reason: "import" })).rejects.toMatchObject({
      code: "TOO_LARGE",
      message: expect.stringContaining("This template file is too large to run as one task"),
    });
    expect(await w.repo.settings.get(jobKey(big))).toBeUndefined();
    expect((await w.repo.history.listAll({ type: "template.snapshot", limit: 5 })).items).toHaveLength(0);

    const ok = randomUUID();
    await startImport(w.ctx(ok), bigFile(200), { reason: "import" });
    await driveTab(w, (t) => continueImport(w.ctx(ok, t.repo), ok), { repo: w.repo }, { gapMs: 10, maxCalls: 100 });
    expect((await w.repo.milestones.list()).filter((m) => m.key.startsWith("milestone-number-"))).toHaveLength(200);

    // Copying that template into a project would outgrow the limit as the job records its 200 steps: refused up front.
    const create = randomUUID();
    await expect(startCreateProject(w.ctx(create), { code: "C0900", name: "Too big" })).rejects.toMatchObject({
      code: "TOO_LARGE",
      message: expect.stringContaining("Copying this template is too large to run as one task"),
    });
    expect(await w.repo.settings.get(jobKey(create))).toBeUndefined();
    expect(await w.repo.projects.findByCode("C0900")).toBeNull();
  });
});
