/**
 * Drives the real job services the way browsers do, on the lagging fake Notion (tests/unit/services/_lag.ts): one or
 * two tabs (drivers) calling `continue…` one call after another, on the same or a cold server instance, with jittered
 * gaps, the BUSY backoff and RUNNING_ELSEWHERE waits of runJob. And the checks every such run must pass: one active
 * row per planned step, milestone or field, and no flow node pointing at a trashed or missing row.
 */
import { randomUUID } from "node:crypto";
import { discoverRegistry } from "@/server/notion/registry";
import type { Repo } from "@/server/repo/types";
import { RUNNING_ELSEWHERE, type JobStepResult } from "@/server/services/jobs";
import { getTemplate } from "@/server/services/library";
import { continueCreateProject, reconcileProject, startCreateProject } from "@/server/services/projects";
import { continueImport, startSeed } from "@/server/services/templateIo";
import { FAKE_OPTS } from "../unit/notion/helpers";
import type { LagWorld } from "../unit/services/_lag";

const realSleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A small deterministic random number generator (0 ≤ x < 1). */
export function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

export interface Tab {
  /** Driver id (one browser run); undefined drives without a lease, as tests and scripts do. */
  driver?: string;
  /** The server instance this tab's calls land on. */
  repo: Repo;
}

export interface DriveOptions {
  /** Fake time between two calls of a tab (plus up to `jitterMs`). */
  gapMs?: number;
  jitterMs?: number;
  rand?: () => number;
  /** Stop after this many calls (a tab that is closed part-way). */
  stopAfter?: number;
  /** Waits (real time, a few ms) before the first call until this returns true. */
  startWhen?: () => boolean;
  maxCalls?: number;
  /** Called after every answered call. */
  onResult?: (r: JobStepResult) => void;
}

/**
 * One tab running a job like runJob: calls again after `gapMs`; after an error waits the BUSY backoff (2 s);
 * RUNNING_ELSEWHERE and other wait hints wait what the server asks. Returns how the run ended.
 */
export async function driveTab(
  w: LagWorld,
  cont: (tab: Tab) => Promise<JobStepResult>,
  tab: Tab,
  opts: DriveOptions = {},
): Promise<{ done: boolean; calls: number; waits: number; errors: number }> {
  const rand = opts.rand ?? Math.random;
  while (opts.startWhen && !opts.startWhen()) await realSleep(1);
  let calls = 0;
  let waits = 0;
  let errors = 0;
  for (let n = 0; n < (opts.maxCalls ?? 300); n++) {
    if (opts.stopAfter !== undefined && calls >= opts.stopAfter) return { done: false, calls, waits, errors };
    await realSleep(Math.floor(rand() * 4));
    w.advance((opts.gapMs ?? 300) + Math.floor(rand() * (opts.jitterMs ?? 0)));
    let r: JobStepResult;
    try {
      calls++;
      r = await cont(tab);
    } catch {
      errors++;
      w.advance(2_000);
      continue;
    }
    opts.onResult?.(r);
    if (r.done) return { done: true, calls, waits, errors };
    if (r.code === RUNNING_ELSEWHERE) {
      waits++;
      calls--;
      w.advance(r.retryInMs ?? 3_000);
    } else if (r.retryInMs) {
      w.advance(r.retryInMs);
    }
  }
  throw new Error("the job did not finish");
}

export async function trashedCount(w: LagWorld, db: "milestones" | "projectFields" | "steps"): Promise<number> {
  const reg = await discoverRegistry(w.raw, FAKE_OPTS);
  let n = 0;
  let cursor: string | undefined;
  do {
    const r = (await w.raw.dataSources.query({
      data_source_id: reg.dbs[db]!.dataSourceId,
      in_trash: true,
      page_size: 100,
      start_cursor: cursor,
    } as never)) as { results: unknown[]; has_more: boolean; next_cursor: string | null };
    n += r.results.length;
    cursor = r.has_more && r.next_cursor ? r.next_cursor : undefined;
  } while (cursor);
  return n;
}

export async function seedLibrary(w: LagWorld): Promise<void> {
  const opId = randomUUID();
  await startSeed(w.ctx(opId));
  await driveTab(w, (t) => continueImport(w.ctx(opId, t.repo), opId), { repo: w.repo }, { gapMs: 500 });
  w.advance(10_000);
}

export async function newProject(w: LagWorld, code: string): Promise<string> {
  const opId = randomUUID();
  const { projectId } = await startCreateProject(w.ctx(opId), { code, name: "Test project" });
  await driveTab(w, (t) => continueCreateProject(w.ctx(opId, t.repo), opId), { repo: w.repo }, { gapMs: 500 });
  return projectId;
}

/**
 * The project as the app shows it once the lag has passed and the project page has run its reconcile: active steps,
 * distinct step keys, flow nodes without an active step, and whether the cells are exactly the active steps.
 */
export async function projectState(w: LagWorld, projectId: string) {
  w.advance(10_000);
  await reconcileProject(w.ctx(), projectId);
  w.advance(10_000);
  const steps = await w.repo.steps.listByProject(projectId);
  const p = (await w.repo.projects.get(projectId))!;
  const ids = new Set(steps.map((s) => s.id));
  return {
    steps: steps.length,
    keys: new Set(steps.map((s) => s.stepKey)).size,
    dangling: Object.keys(p.flow.nodes).filter((id) => !ids.has(id)).length,
    cellsMatch: Object.keys(p.cells).length === steps.length && Object.keys(p.cells).every((id) => ids.has(id)),
    setup: p.setup,
  };
}

/** The template once the lag has passed: active milestones, distinct keys, dangling flow nodes, fields. */
export async function templateState(w: LagWorld) {
  w.advance(15_000);
  const milestones = await w.repo.milestones.list({ includeArchived: true });
  const fields = await w.repo.projectFields.list({ includeArchived: true });
  const t = await getTemplate(w.repo);
  const active = milestones.filter((m) => !m.archived);
  const activeIds = new Set(active.map((m) => m.id));
  return {
    milestones: active.length,
    keys: new Set(active.map((m) => m.key)).size,
    flowNodes: Object.keys(t.flow.nodes).length,
    dangling: Object.keys(t.flow.nodes).filter((id) => !activeIds.has(id)).length,
    liveEdges: t.flow.edges.filter((e) => !e.archivedAt && activeIds.has(e.from) && activeIds.has(e.to)).length,
    fields: fields.length,
    fieldKeys: new Set(fields.map((f) => f.key)).size,
  };
}
