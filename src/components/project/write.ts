"use client";

/**
 * Browser side of every project write: one opId per user action, all writes of a project in ONE queue (one in
 * flight, FIFO), retried with the SAME opId on network errors and BUSY, plain-English toasts on failure. An expired
 * session keeps the change on screen and offers Sign in + Retry.
 */
import { toast } from "sonner";
import { isStaleDeploymentError, type ActionResult } from "@/lib/action-result";
import { enqueue } from "@/lib/write-queue";

export type Failure = Extract<ActionResult<unknown>, { ok: false }>;

const RETRYABLE = new Set(["BUSY", "NETWORK"]);
const MAX_RETRIES = 4;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Every /api route answers 401 without a session (proxy); with one, this path answers 204. */
export async function sessionExpired(): Promise<boolean> {
  try {
    const res = await fetch("/api/files/session", { cache: "no-store", credentials: "same-origin" });
    return res.status === 401;
  } catch {
    return false;
  }
}

/** One call; thrown errors (network, expired session, new deployment) become results. Never throws. */
export async function attempt<T>(run: () => Promise<ActionResult<T>>): Promise<ActionResult<T>> {
  try {
    const r = await run();
    if (r && typeof r === "object" && "ok" in r) return r;
    return { ok: false, error: "The server sent an unexpected answer. Reload the page and try again.", code: "UNKNOWN" };
  } catch (err) {
    if (await sessionExpired()) return { ok: false, error: "Session expired. Sign in again", code: "SESSION" };
    if (isStaleDeploymentError(err)) {
      return { ok: false, error: "The app was updated. Reload the page to continue.", code: "STALE_DEPLOYMENT" };
    }
    return { ok: false, error: "Couldn't reach the server. Check your connection and try again.", code: "NETWORK" };
  }
}

/** Retries network errors and BUSY with backoff. `run` must re-send the same opId. */
export async function withRetry<T>(run: () => Promise<ActionResult<T>>, retries = MAX_RETRIES): Promise<ActionResult<T>> {
  let r = await attempt(run);
  for (let i = 1; !r.ok && RETRYABLE.has(r.code ?? "") && i <= retries; i++) {
    await sleep(Math.min(8000, 400 * 2 ** i));
    r = await attempt(run);
  }
  return r;
}

/** Runs one write in the project's queue, with retries. */
export function queued<T>(projectId: string, run: () => Promise<ActionResult<T>>): Promise<ActionResult<T>> {
  return enqueue(queueKey(projectId), () => withRetry(run));
}

/** The write-queue key of a project (one write in flight per project). */
export function queueKey(projectId: string): string {
  return projectId;
}

// Writes held back by an expired session: one toast, one Retry for all of them.
const sessionRetries = new Map<string, () => void>();
const SESSION_TOAST = "gpm-session-expired";

/** Changes kept on the page after the session expired, waiting for Retry (a page refresh now would lose them). */
export function heldWrites(): number {
  return sessionRetries.size;
}

function signInHref(): string {
  return `/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`;
}

/** The standard failure toast. `retry` re-sends the same write (same opId). */
export function reportFailure(f: Failure, retry?: () => void, key?: string): void {
  if (f.code === "SESSION") {
    if (retry) sessionRetries.set(key ?? String(sessionRetries.size), retry);
    const n = sessionRetries.size;
    toast.error("Session expired. Sign in again", {
      id: SESSION_TOAST,
      description:
        n > 0
          ? `${n === 1 ? "Your change is" : `${n} changes are`} kept on this page but not saved yet. Sign in (opens a new tab), then press Retry.`
          : "Sign in (opens a new tab), then try again.",
      duration: Infinity,
      action: n
        ? {
            label: "Retry",
            onClick: () => {
              const all = [...sessionRetries.values()];
              sessionRetries.clear();
              for (const fn of all) fn();
            },
          }
        : undefined,
      cancel: { label: "Sign in", onClick: () => window.open(signInHref(), "_blank", "noopener") },
    });
    return;
  }
  if (f.code === "STALE_DEPLOYMENT") {
    toast.error(f.error, { duration: Infinity, action: { label: "Reload", onClick: () => window.location.reload() } });
    return;
  }
  if (RETRYABLE.has(f.code ?? "") && retry) {
    toast.error(f.error, { duration: 15_000, action: { label: "Retry", onClick: retry } });
    return;
  }
  toast.error(f.error);
}

/** Read-only calls (history pages, previews): retry BUSY/network a little, never queue. */
export function read<T>(run: () => Promise<ActionResult<T>>): Promise<ActionResult<T>> {
  return withRetry(run, 2);
}
