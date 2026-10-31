import type { ActionResult } from "./action-result";
import { isStaleDeploymentError } from "./action-result";

export interface JobProgress {
  done: boolean;
  /** Plain-English progress text, e.g. "Copied 24 of 64 milestones". */
  message: string;
  /** 0..1 when known. */
  fraction?: number;
  /** RUNNING_ELSEWHERE: another tab or window is running this job; runJob waits and calls again. */
  code?: string;
  /** The server asks to wait this long before the next call (e.g. while Notion's search catches up). */
  retryInMs?: number;
}

/** Result code of a job step while another tab or window holds the job (see src/server/services/jobs.ts). */
export const RUNNING_ELSEWHERE = "RUNNING_ELSEWHERE";
export const RUNNING_ELSEWHERE_MESSAGE = "Running in another tab or window, waiting…";

export interface RunJobOptions {
  onProgress?: (p: JobProgress) => void;
  /** Max consecutive BUSY retries before giving up. */
  maxBusyRetries?: number;
  /** Max total steps (safety net against a runaway loop). Waiting for another tab or window does not count. */
  maxSteps?: number;
  signal?: AbortSignal;
  /** Identifies this run to the server (default: a new id per run). */
  driver?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A new id for one run of a job (letters, digits and dashes, as the server expects). */
export function newDriverId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  } catch {
    /* not a secure context: fall back below */
  }
  return `d-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * Drives a resumable server job: calls `step(driver)` until it reports done. Each step is idempotent on the server, so
 * a retry after a network error or BUSY response never repeats or skips work. `driver` stays the same for the whole
 * run, so a retry within the run carries on at once; while another tab or window runs the same job, the server
 * answers RUNNING_ELSEWHERE and this run waits (for as long as the other one keeps going), then finishes or takes over.
 */
export async function runJob(
  step: (driver: string) => Promise<ActionResult<JobProgress>>,
  opts: RunJobOptions = {},
): Promise<ActionResult<JobProgress>> {
  const maxBusy = opts.maxBusyRetries ?? 5;
  const maxSteps = opts.maxSteps ?? 500;
  const driver = opts.driver ?? newDriverId();
  let busy = 0;
  let last: JobProgress = { done: false, message: "Starting…" };

  for (let steps = 0; steps < maxSteps; ) {
    if (opts.signal?.aborted) return { ok: false, error: "Stopped.", code: "ABORTED" };
    let result: ActionResult<JobProgress>;
    try {
      result = await step(driver);
    } catch (err) {
      if (isStaleDeploymentError(err)) {
        return { ok: false, error: "The app was updated while this was running. Reload the page to continue.", code: "STALE_DEPLOYMENT" };
      }
      result = { ok: false, error: "Can't reach the server. Check your connection and try again.", code: "NETWORK" };
    }
    if (!result.ok) {
      steps++;
      if ((result.code === "BUSY" || result.code === "NETWORK") && busy < maxBusy) {
        busy++;
        const why = result.code === "NETWORK" ? "Can't reach the server" : "Notion is busy";
        opts.onProgress?.({ ...last, message: `${why}, retrying (${busy} of ${maxBusy})…` });
        await sleep(Math.min(30_000, 1000 * 2 ** busy));
        continue;
      }
      return result;
    }
    busy = 0;
    const p = result.data;
    if (!p.done && p.code === RUNNING_ELSEWHERE) {
      // Not a step of this run: wait while the other tab or window works on the job.
      if (p.fraction !== undefined) last = { ...last, fraction: p.fraction };
      opts.onProgress?.({ ...last, message: RUNNING_ELSEWHERE_MESSAGE });
      await sleep(Math.min(10_000, Math.max(500, p.retryInMs ?? 3_000)));
      continue;
    }
    steps++;
    last = p;
    opts.onProgress?.(last);
    if (last.done) return result;
    if (p.retryInMs) await sleep(Math.min(10_000, p.retryInMs));
  }
  return { ok: false, error: "This is taking longer than expected. Reload the page to continue.", code: "TOO_LONG" };
}
