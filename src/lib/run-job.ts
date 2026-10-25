import type { ActionResult } from "./action-result";
import { isStaleDeploymentError } from "./action-result";

export interface JobProgress {
  done: boolean;
  /** Plain-English progress text, e.g. "Copied 24 of 64 milestones". */
  message: string;
  /** 0..1 when known. */
  fraction?: number;
}

export interface RunJobOptions {
  onProgress?: (p: JobProgress) => void;
  /** Max consecutive BUSY retries before giving up. */
  maxBusyRetries?: number;
  /** Max total steps (safety net against a runaway loop). */
  maxSteps?: number;
  signal?: AbortSignal;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Drives a resumable server job: calls `step()` until it reports done. Each step is idempotent on the server, so a
 * retry after a network error or BUSY response never repeats or skips work.
 */
export async function runJob(
  step: () => Promise<ActionResult<JobProgress>>,
  opts: RunJobOptions = {},
): Promise<ActionResult<JobProgress>> {
  const maxBusy = opts.maxBusyRetries ?? 5;
  const maxSteps = opts.maxSteps ?? 500;
  let busy = 0;
  let last: JobProgress = { done: false, message: "Starting…" };

  for (let i = 0; i < maxSteps; i++) {
    if (opts.signal?.aborted) return { ok: false, error: "Stopped.", code: "ABORTED" };
    let result: ActionResult<JobProgress>;
    try {
      result = await step();
    } catch (err) {
      if (isStaleDeploymentError(err)) {
        return { ok: false, error: "The app was updated while this was running. Reload the page to continue.", code: "STALE_DEPLOYMENT" };
      }
      result = { ok: false, error: "Can't reach the server. Check your connection and try again.", code: "NETWORK" };
    }
    if (!result.ok) {
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
    last = result.data;
    opts.onProgress?.(last);
    if (last.done) return result;
  }
  return { ok: false, error: "This is taking longer than expected. Reload the page to continue.", code: "TOO_LONG" };
}
