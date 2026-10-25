import "server-only";
/**
 * Resumable jobs (create project, sync, import/seed/reset). A job is stored in Settings under `job:<opId>` with its
 * planned work and progress. Batches apply items from the job, never from a fresh plan, so a resumed batch neither
 * repeats nor skips work. A finished job is replaced by a small tombstone so a repeated "continue" is a no-op.
 */
import type { Iso } from "@/domain/types";
import type { Repo } from "@/server/repo/types";
import { AppError, dropUndefined, type Ctx } from "./context";

export type JobKind = "createProject" | "sync" | "import";

export const JOB_PREFIX = "job:";

export function jobKey(opId: string): string {
  return `${JOB_PREFIX}${opId}`;
}

/** Items written per batch call (keeps each call well under the hosting time limit and Notion's rate limit). */
export const BATCH_SIZE = 8;

export interface JobBase<K extends JobKind = JobKind> {
  kind: K;
  opId: string;
  status: "running" | "done";
  actor: string;
  createdAt: Iso;
  updatedAt: Iso;
  /** Units of work in total and done so far (for the progress bar). */
  total: number;
  doneCount: number;
  /** Project the job works on (createProject, sync). */
  projectId?: string;
}

/** What is left of a finished job. */
export interface JobTombstone<K extends JobKind = JobKind> extends JobBase<K> {
  status: "done";
  finishedAt: Iso;
  result?: Record<string, unknown>;
}

/** Progress returned by every `continue…` call; matches the client's runJob() JobProgress. */
export interface JobStepResult {
  done: boolean;
  /** Plain-English progress, e.g. "Copied 24 of 64 milestones". */
  message: string;
  /** 0..1 */
  fraction: number;
  total: number;
  doneCount: number;
}

export interface JobSummary {
  opId: string;
  kind: JobKind;
  status: "running" | "done";
  projectId?: string;
  total: number;
  doneCount: number;
  createdAt: Iso;
  updatedAt: Iso;
}

export async function loadJob<T extends JobBase>(repo: Repo, opId: string): Promise<T | null> {
  const job = await repo.settings.get<T | null>(jobKey(opId));
  return job && typeof job === "object" ? job : null;
}

/** Loads a job of the given kind or throws NOT_FOUND / VALIDATION. */
export async function requireJob<T extends JobBase>(repo: Repo, opId: string, kind: JobKind): Promise<T> {
  const job = await loadJob<T>(repo, opId);
  if (!job) throw new AppError("NOT_FOUND", "This task was not found. Start it again.");
  if (job.kind !== kind) throw new AppError("VALIDATION", "This task is of a different kind.");
  return job;
}

export async function saveJob<T extends JobBase>(repo: Repo, job: T): Promise<void> {
  await repo.settings.set(jobKey(job.opId), dropUndefined(job));
}

export function newJob<K extends JobKind>(
  ctx: Ctx,
  kind: K,
  total: number,
  opId: string = ctx.opId,
): JobBase<K> {
  return { kind, opId, status: "running", actor: ctx.actor, createdAt: ctx.now, updatedAt: ctx.now, total, doneCount: 0 };
}

/** Replaces the job with a tombstone (the planned items are dropped; the result stays for repeated calls). */
export async function finishJob(ctx: Ctx, job: JobBase, result?: Record<string, unknown>): Promise<JobTombstone> {
  const tombstone: JobTombstone = {
    kind: job.kind,
    opId: job.opId,
    status: "done",
    actor: job.actor,
    createdAt: job.createdAt,
    updatedAt: ctx.now,
    finishedAt: ctx.now,
    total: job.total,
    doneCount: job.total,
  };
  if (job.projectId) tombstone.projectId = job.projectId;
  if (result) tombstone.result = result;
  await saveJob(ctx.repo, tombstone);
  return tombstone;
}

export function isFinished(job: JobBase): job is JobTombstone {
  return job.status === "done";
}

export function stepResult(done: boolean, doneCount: number, total: number, message: string): JobStepResult {
  const fraction = total <= 0 ? (done ? 1 : 0) : Math.min(1, Math.max(0, doneCount / total));
  return { done, message, fraction: done ? 1 : fraction, total, doneCount: done ? total : doneCount };
}

/** Jobs still running (e.g. to offer "Resume" after the browser was closed mid-way). */
export async function listOpenJobs(repo: Repo): Promise<JobSummary[]> {
  const all = await repo.settings.list(JOB_PREFIX);
  const out: JobSummary[] = [];
  for (const value of Object.values(all)) {
    if (!value || typeof value !== "object") continue;
    const j = value as JobBase;
    if (j.status !== "running") continue;
    const s: JobSummary = {
      opId: j.opId,
      kind: j.kind,
      status: j.status,
      total: j.total,
      doneCount: j.doneCount,
      createdAt: j.createdAt,
      updatedAt: j.updatedAt,
    };
    if (j.projectId) s.projectId = j.projectId;
    out.push(s);
  }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
}

/** Status of one job (running, done, or null when unknown). */
export async function getJobStatus(repo: Repo, opId: string): Promise<JobSummary | null> {
  const j = await loadJob<JobBase>(repo, opId);
  if (!j) return null;
  const s: JobSummary = {
    opId: j.opId,
    kind: j.kind,
    status: j.status,
    total: j.total,
    doneCount: j.doneCount,
    createdAt: j.createdAt,
    updatedAt: j.updatedAt,
  };
  if (j.projectId) s.projectId = j.projectId;
  return s;
}
