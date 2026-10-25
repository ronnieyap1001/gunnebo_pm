/**
 * Shared fixtures for the service tests: an in-memory repo, a fixed clock/day, and loops that drive the resumable
 * jobs the way the browser does.
 */
import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import type { TemplateFile } from "@/domain/templateFile";
import type { Iso, Ymd } from "@/domain/types";
import type { StoredStep } from "@/server/repo/types";
import { makeCtx, type Ctx, type MakeCtxOptions } from "@/server/services/context";
import { continueCreateProject, startCreateProject, type CreateProjectInput } from "@/server/services/projects";
import { continueImport, startImport, startSeed, type ImportReason } from "@/server/services/templateIo";
import { continueSync, startSync } from "@/server/services/sync";
import { createMemoryRepo, type MemoryRepo } from "../../support/memoryRepo";

export const NOW: Iso = "2026-10-25T02:00:00.000Z";
export const TODAY: Ymd = "2026-10-25";
export const TZ = "Asia/Singapore";

export interface World {
  repo: MemoryRepo;
  /** A context for one user action (fresh opId unless given). */
  ctx: (opts?: MakeCtxOptions) => Ctx;
}

export function world(): World {
  let t = Date.parse(NOW);
  const repo = createMemoryRepo({ clock: () => new Date((t += 1000)).toISOString() });
  return {
    repo,
    ctx: (opts = {}) => makeCtx(repo, { now: NOW, today: TODAY, timeZone: TZ, actor: "Me", opId: randomUUID(), ...opts }),
  };
}

/** Runs an import job to the end; returns the number of continue calls. */
export async function runImport(w: World, file: TemplateFile | unknown, reason: ImportReason = "import", opId = randomUUID()): Promise<number> {
  const c = w.ctx({ opId });
  await startImport(c, file, { reason });
  let calls = 0;
  for (;;) {
    calls++;
    const r = await continueImport(w.ctx({ opId }), opId);
    if (r.done) return calls;
    if (calls > 200) throw new Error("import did not finish");
  }
}

/** Loads the seed template through the importer (as Setup does). */
export async function seedLibrary(w: World): Promise<void> {
  const opId = randomUUID();
  await startSeed(w.ctx({ opId }));
  for (let i = 0; i < 200; i++) {
    const r = await continueImport(w.ctx({ opId }), opId);
    if (r.done) return;
  }
  throw new Error("seed did not finish");
}

/** Creates a project through the start/continue loop; returns the project id. */
export async function createProject(w: World, input: Partial<CreateProjectInput> = {}, opId = randomUUID()): Promise<string> {
  const { projectId } = await startCreateProject(w.ctx({ opId }), { code: "C0822", name: "Heathrow T5 gates", ...input });
  for (let i = 0; i < 100; i++) {
    const r = await continueCreateProject(w.ctx({ opId }), opId);
    if (r.done) return projectId;
  }
  throw new Error("create did not finish");
}

/** Runs a sync job to the end with the given item ids. */
export async function runSync(w: World, projectId: string, selectedIds: string[], opId = randomUUID()): Promise<void> {
  await startSync(w.ctx({ opId }), { projectId, selectedIds });
  for (let i = 0; i < 100; i++) {
    const r = await continueSync(w.ctx({ opId }), opId);
    if (r.done) return;
  }
  throw new Error("sync did not finish");
}

export async function stepsOf(w: World, projectId: string, includeArchived = false): Promise<StoredStep[]> {
  return w.repo.steps.listByProject(projectId, { includeArchived });
}

export async function stepByKey(w: World, projectId: string, key: string): Promise<StoredStep> {
  const s = (await stepsOf(w, projectId, true)).find((x) => x.milestoneKey === key);
  if (!s) throw new Error(`no step with key ${key}`);
  return s;
}

export async function milestoneByKey(w: World, key: string) {
  const m = (await w.repo.milestones.list({ includeArchived: true })).find((x) => x.key === key);
  if (!m) throw new Error(`no milestone with key ${key}`);
  return m;
}

/** All History rows, newest first. */
export async function allHistory(w: World) {
  return (await w.repo.history.listAll({ limit: 100 })).items;
}

export async function historyOfType(w: World, type: string) {
  return (await w.repo.history.listAll({ type, limit: 100 })).items;
}

/** Expects a promise to reject with an AppError of the given code. */
export async function expectAppError(p: Promise<unknown>, code: string, message?: RegExp): Promise<void> {
  await expect(p).rejects.toMatchObject({ name: "AppError", code });
  if (message) await expect(p).rejects.toThrow(message);
}

export function activeEdgePairs(edges: { from: string; to: string; archivedAt?: string }[]): string[] {
  return edges
    .filter((e) => !e.archivedAt)
    .map((e) => `${e.from}->${e.to}`)
    .sort();
}
