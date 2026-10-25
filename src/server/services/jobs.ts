import "server-only";
/**
 * Resumable jobs (create project, sync, import/seed/reset). A job is stored in Settings under `job:<opId>` with its
 * planned work and progress. Batches apply items from the job, never from a fresh plan, so a resumed batch neither
 * repeats nor skips work. A finished job is replaced by a small tombstone so a repeated "continue" is a no-op.
 *
 * Notion's queries can lag a few seconds behind writes, so a job also records the id of every row it created and is
 * saved after every batch: the next batch counts those as done instead of looking for them with a query (which may
 * not show them yet and would create them a second time). The query only remains as a fallback for a crash between a
 * create and the save; finalizing moves any second copy it may have caused to Notion's trash.
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

/**
 * The job as Notion has it now: by the row id this instance remembers, else found through a query and then read again
 * by its page id (a query can return an older copy of the row).
 */
export async function loadJob<T extends JobBase>(repo: Repo, opId: string): Promise<T | null> {
  const job = await repo.settings.get<T | null>(jobKey(opId), { fresh: true });
  return job && typeof job === "object" ? job : null;
}

/**
 * A batch can land on another server instance moments after the job was saved, before Notion's query shows the row.
 * A `continue…` call that does not find its job therefore looks again `retries` times, `waitMs` apart, before it
 * reports "not found": about 8 s in all, so a query that lags 5 s behind the write still finds the row (only an
 * unknown opId pays that wait). `sleep` can be replaced in tests.
 */
export const JOB_LOOKUP: { retries: number; waitMs: number; sleep?: (ms: number) => Promise<void> } = {
  retries: 4,
  waitMs: 2000,
};

/** Waits `ms` inside a batch (JOB_LOOKUP.sleep in tests). */
export function jobPause(ms: number): Promise<void> {
  return (JOB_LOOKUP.sleep ?? ((t: number) => new Promise<void>((r) => setTimeout(r, t))))(ms);
}

/** loadJob for a `continue…` call (see JOB_LOOKUP). */
export async function loadJobForContinue<T extends JobBase>(repo: Repo, opId: string): Promise<T | null> {
  let job = await loadJob<T>(repo, opId);
  for (let i = 0; !job && i < JOB_LOOKUP.retries; i++) {
    await jobPause(JOB_LOOKUP.waitMs);
    job = await loadJob<T>(repo, opId);
  }
  return job;
}

/**
 * Runs write thunks in parallel and waits for all of them. Unlike settleAll it never throws: it returns each result
 * (undefined where the write failed) and the first error, so the caller can record what was written before failing.
 */
export async function settleSome<T>(tasks: (() => Promise<T>)[]): Promise<{ results: (T | undefined)[]; error?: unknown }> {
  const settled = await Promise.allSettled(tasks.map((t) => t()));
  const failed = settled.find((r): r is PromiseRejectedResult => r.status === "rejected");
  return {
    results: settled.map((r) => (r.status === "fulfilled" ? r.value : undefined)),
    ...(failed ? { error: failed.reason } : {}),
  };
}

/** Loads a job of the given kind or throws NOT_FOUND / VALIDATION. */
export async function requireJob<T extends JobBase>(repo: Repo, opId: string, kind: JobKind): Promise<T> {
  const job = await loadJobForContinue<T>(repo, opId);
  if (!job) throw new AppError("NOT_FOUND", "This task was not found. Start it again.");
  if (job.kind !== kind) throw new AppError("VALIDATION", "This task is of a different kind.");
  return job;
}

/**
 * Saves the job. The save records what a batch created, so losing it can leave second copies (the next batch may not
 * see the rows in a query yet): when Notion is unavailable (a 5xx, a timeout, a dropped connection) the same value is
 * sent once more. It replaces the whole value, so a save that did land is not harmed, and even after a 20 s timeout
 * the second try fits in the batch's time limit. Busy (429) is not retried: the Notion client already did. Neither is
 * a 409 conflict (the client retries it once) nor the first save of a new job: that one creates the row, and if the
 * create did land, a second one would add a second row for the same job.
 */
export async function saveJob<T extends JobBase>(repo: Repo, job: T): Promise<void> {
  const value = dropUndefined(job);
  try {
    await repo.settings.set(jobKey(job.opId), value);
  } catch (e) {
    const firstSave = job.status === "running" && job.updatedAt === job.createdAt;
    if (firstSave || !worthOneMoreTry(e)) throw e;
    await repo.settings.set(jobKey(job.opId), value);
  }
}

/** Notion was unavailable (NotionUnavailableError: a 5xx, a timeout or a dropped connection). */
function worthOneMoreTry(e: unknown): boolean {
  return !!e && typeof e === "object" && (e as { code?: unknown }).code === "unavailable";
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
