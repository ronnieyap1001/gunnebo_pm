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
 *
 * One job can be driven from two tabs, windows or server instances at once (a duplicated tab resumes it from the URL,
 * or Resume is clicked while another tab still runs it). Each browser run of a job passes a driver id, and the driver
 * that works on the job holds a lease in the job row (see claimJob): another driver gets RUNNING_ELSEWHERE and waits
 * until the job is finished or the lease runs out. Notion has no conditional writes, so two drivers that take a free
 * job at the same moment can still overlap for a call; every save therefore reads the row again first and keeps what
 * another call recorded (see saveRunningJob), and finalizing only uses the record Notion has.
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
  /** The driver working on the job (see claimJob). */
  lease?: JobLease;
}

/** One browser run of a job holds it until `until` (renewed with every save of that run). */
export interface JobLease {
  driver: string;
  until: Iso;
  /** How long the lease lasts after each renewal (see LEASE_MAX_MS); LEASE_MS when missing. */
  ms?: number;
}

/**
 * How long a lease lasts after the save that renewed it, at least. A driver whose tab was closed is taken over after
 * this; the same driver (a retry within one run) carries on at once.
 */
export const LEASE_MS = 30_000;
/**
 * A lease lasts longer when the job's calls are slow (Notion busy): twice as long as the call that renewed it took, so
 * another tab does not take the job over in the middle of the next call. A lease taken over from another driver lasts
 * twice as long as the one that ran out (that driver may have been slow, not closed), so two open tabs cannot keep
 * taking the job from each other without either saving its work. Never longer than this.
 */
export const LEASE_MAX_MS = 5 * 60_000;
/**
 * A driver that takes a free job writes its lease, waits this long and reads the row again: when another driver took
 * the job in the same moment, only the one whose lease Notion kept carries on.
 */
export const LEASE_SETTLE_MS = 1_000;
/** Result code of a `continue…` call while another driver holds the job; the browser waits and calls again. */
export const RUNNING_ELSEWHERE = "RUNNING_ELSEWHERE";
export const RUNNING_ELSEWHERE_MESSAGE = "Running in another tab or window, waiting…";
/** A driver id from the browser (runJob creates one per run). */
export const DRIVER_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

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
  /** RUNNING_ELSEWHERE: another tab or window works on this job; call again after `retryInMs`. */
  code?: typeof RUNNING_ELSEWHERE;
  /** Wait this long before the next call (the job is waiting for something, e.g. Notion's query to catch up). */
  retryInMs?: number;
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
  /** Until when another tab or window holds the job (it is running there, not interrupted). */
  leaseUntil?: Iso;
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
 * a 409 conflict (the client retries it once) nor the save that creates the job's row (`creates`, the first save of
 * a start): if that create did land, a second one would add a second row for the same job.
 */
export async function saveJob<T extends JobBase>(repo: Repo, job: T, opts: { creates?: boolean } = {}): Promise<void> {
  const value = dropUndefined(job);
  try {
    await repo.settings.set(jobKey(job.opId), value);
  } catch (e) {
    if (opts.creates || !worthOneMoreTry(e)) throw e;
    await repo.settings.set(jobKey(job.opId), value);
  }
}

/**
 * Notion keeps a job in one text property of at most 200,000 characters (100 pieces of 2,000; a piece can be one
 * shorter so an emoji is not cut in half).
 */
export const JOB_MAX_CHARS = 199_000;

/**
 * Refuses to start a job that could outgrow what Notion stores before it finishes: `worstCase` is the job as it
 * would be with every planned row recorded. Checked before anything is written, so a refused job changes nothing.
 */
export function assertJobFits(worstCase: JobBase, what: string): void {
  const chars = JSON.stringify(dropUndefined(worstCase)).length;
  if (chars <= JOB_MAX_CHARS) return;
  throw new AppError(
    "TOO_LARGE",
    `${what} is too large to run as one task: Notion would have to store ${chars.toLocaleString("en-US")} characters for it (the limit is ${JOB_MAX_CHARS.toLocaleString("en-US")}).`,
    { chars, limit: JOB_MAX_CHARS },
  );
}

/** A page id as long as Notion's, for worst-case sizes. */
export const SAMPLE_ID = "00000000-0000-0000-0000-000000000000";
/** A lease as long as the longest one a driver can hold, for worst-case sizes. */
export const SAMPLE_LEASE: JobLease = { driver: "x".repeat(64), until: "2000-01-01T00:00:00.000Z", ms: LEASE_MAX_MS };

// ---------------------------------------------------------------------------
// Drivers and leases
// ---------------------------------------------------------------------------

/** One `continue…` call: the context, the driver (none for calls from tests and scripts) and a clock for the call. */
export interface JobCall {
  ctx: Ctx;
  driver?: string;
  /** The context's time plus the real time this call has taken so far (a failure late in a call is dated then). */
  now(): Iso;
  /** The real time this call has taken so far (ms). */
  elapsedMs(): number;
}

/** A driver id as the browser sends it: missing, or letters, digits and dashes (8 to 64). */
export function isDriverId(raw: unknown): raw is string | undefined {
  return raw === undefined || raw === null || (typeof raw === "string" && DRIVER_PATTERN.test(raw));
}

/** The progress fields every `continue…` action returns (with the wait hints the browser's runJob uses). */
export function progressOf(r: JobStepResult): JobStepResult {
  const out: JobStepResult = { done: r.done, message: r.message, fraction: r.fraction, total: r.total, doneCount: r.doneCount };
  if (r.code) out.code = r.code;
  if (r.retryInMs) out.retryInMs = r.retryInMs;
  return out;
}

export function beginJobCall(ctx: Ctx, driver?: string | null): JobCall {
  if (driver === null) driver = undefined;
  if (driver !== undefined && !DRIVER_PATTERN.test(driver)) {
    throw new AppError("VALIDATION", "This task's window id is not valid. Reload the page and try again.");
  }
  const started = Date.now();
  const elapsedMs = () => Date.now() - started;
  return { ctx, driver, now: () => new Date(Date.parse(ctx.now) + elapsedMs()).toISOString(), elapsedMs };
}

/** The lease another driver holds on the job right now (undefined when it is free, has run out, or is ours). */
export function leaseHeldElsewhere(job: JobBase, driver: string | undefined, now: Iso): JobLease | undefined {
  const lease = job.lease;
  if (!lease || lease.driver === driver) return undefined;
  return Date.parse(lease.until) > Date.parse(now) ? lease : undefined;
}

/** Progress for a driver that has to wait: the job runs in another tab or window. */
export function elsewhereResult(job: JobBase, lease: JobLease, now: Iso): JobStepResult {
  const left = Date.parse(lease.until) - Date.parse(now);
  return {
    ...stepResult(false, job.doneCount, job.total, RUNNING_ELSEWHERE_MESSAGE),
    code: RUNNING_ELSEWHERE,
    retryInMs: Math.min(3_000, Math.max(1_000, left)),
  };
}

export type Claim<T> = { job: T; wait?: undefined } | { job?: undefined; wait: JobStepResult };

/**
 * Takes the job for this call's driver. The driver that holds the lease carries on (it is renewed with each save);
 * another driver gets a RUNNING_ELSEWHERE result while the lease lasts. A free job (no lease, or one that ran out) is
 * taken by writing the lease, waiting LEASE_SETTLE_MS and reading the row again by its page id: only the driver whose
 * lease Notion kept goes on. A lease taken over from another driver lasts twice as long as the one that ran out (see
 * LEASE_MAX_MS). Calls without a driver take no lease. Returns the job as read again (it may be finished).
 */
export async function claimJob<T extends JobBase>(call: JobCall, job: T): Promise<Claim<T>> {
  const { driver } = call;
  if (!driver || isFinished(job) || job.lease?.driver === driver) return { job };
  const held = leaseHeldElsewhere(job, driver, call.now());
  if (held) return { wait: elsewhereResult(job, held, call.now()) };
  job.lease = leaseFor(call, job.lease ? 2 * (job.lease.ms ?? LEASE_MS) : LEASE_MS);
  await saveJob(call.ctx.repo, job);
  await jobPause(LEASE_SETTLE_MS);
  const again = await loadJob<T>(call.ctx.repo, job.opId);
  if (!again) return { job };
  if (isFinished(again) || again.lease?.driver === driver) return { job: again };
  const other = leaseHeldElsewhere(again, driver, call.now());
  return other ? { wait: elsewhereResult(again, other, call.now()) } : { job: again };
}

/** A lease for this call's driver lasting `ms` from now (between LEASE_MS and LEASE_MAX_MS). */
function leaseFor(call: JobCall, ms: number): JobLease {
  const length = Math.min(LEASE_MAX_MS, Math.max(LEASE_MS, Math.round(ms)));
  return { driver: call.driver!, until: new Date(Date.parse(call.now()) + length).toISOString(), ms: length };
}

/** What saveRunningJob did: wrote the job, or left it alone because it was finished or taken by another driver. */
export type SaveOutcome = "saved" | "finished" | "elsewhere";

/**
 * Saves a running job without undoing what another call did: reads the row again by its page id first. A finished job
 * is left as it is (no tombstone is turned back into a running job), so is a job another driver holds now. Otherwise
 * `merge` adds what Notion has and this call does not know (another call that overlapped this one recorded it), and
 * the job is written with this driver's lease renewed: for twice as long as this call has taken (at least LEASE_MS),
 * so a slow Notion does not let another tab take the job over in the middle of the next call.
 */
export async function saveRunningJob<T extends JobBase>(
  call: JobCall,
  job: T,
  merge?: (stored: T) => void,
): Promise<{ outcome: SaveOutcome; stored: T | null }> {
  const stored = await loadJob<T>(call.ctx.repo, job.opId);
  if (stored && isFinished(stored)) return { outcome: "finished", stored };
  if (stored && call.driver && leaseHeldElsewhere(stored, call.driver, call.now())) return { outcome: "elsewhere", stored };
  if (stored && merge) merge(stored);
  if (call.driver) job.lease = leaseFor(call, 2 * call.elapsedMs());
  await saveJob(call.ctx.repo, job);
  return { outcome: "saved", stored };
}

/**
 * Merges a record of created rows (key → id) with the one Notion has: Notion's entry wins for a key both have (the
 * other call recorded it first), entries only this call has are added. Ids in `gone` (rows this call found deleted)
 * are not taken over. Returns the ids of this call's entries that lost (rows nobody records any more).
 */
export function mergeRecord(
  target: Record<string, string>,
  stored: Record<string, string> | undefined,
  gone: ReadonlySet<string> = new Set(),
): string[] {
  const lost: string[] = [];
  for (const [key, id] of Object.entries(stored ?? {})) {
    if (gone.has(id)) continue;
    if (target[key] !== undefined && target[key] !== id) lost.push(target[key]);
    target[key] = id;
  }
  return lost;
}

/**
 * Rows a call created that it may discard after saving: those that lost the merge (Notion records another row for
 * their key, so nothing uses them), or all of them once the job is finished (the finishing call wrote everything that
 * uses them; the caller still checks the flow and what the tombstone keeps). Not while another driver holds the job:
 * it may have found them through its query and be about to use them; its finalize discards them if it does not.
 */
export function orphansOf(outcome: SaveOutcome, lost: string[], made: ReadonlySet<string>): string[] {
  if (outcome === "saved") return lost.filter((id) => made.has(id));
  return outcome === "finished" ? [...made] : [];
}

/** True when two records of created rows (key → id) hold the same entries. */
export function sameRecord(a: Record<string, string> | undefined, b: Record<string, string> | undefined): boolean {
  const ea = Object.entries(a ?? {});
  if (ea.length !== Object.keys(b ?? {}).length) return false;
  return ea.every(([k, v]) => (b ?? {})[k] === v);
}

/**
 * Reads the job again by page id before a finalize write: "same" when Notion has what this call works from (`same`),
 * "finished" when another call finished the job, "changed" when another call saved a different record meanwhile (the
 * next call goes on from that one), or the RUNNING_ELSEWHERE progress when another driver holds the job now.
 */
export async function recheckJob<T extends JobBase>(
  call: JobCall,
  opId: string,
  same: (stored: T) => boolean,
): Promise<"same" | "finished" | "changed" | JobStepResult> {
  const stored = await loadJob<T>(call.ctx.repo, opId);
  if (!stored) return "same";
  if (isFinished(stored)) return "finished";
  const held = call.driver ? leaseHeldElsewhere(stored, call.driver, call.now()) : undefined;
  if (held) return elsewhereResult(stored, held, call.now());
  return same(stored) ? "same" : "changed";
}

/** A timestamp later than both (either may be missing). */
export function laterOf(a: Iso | undefined, b: Iso | undefined): Iso | undefined {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(a) >= Date.parse(b) ? a : b;
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
    if (j.lease?.until) s.leaseUntil = j.lease.until;
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
  if (j.status === "running" && j.lease?.until) s.leaseUntil = j.lease.until;
  return s;
}
