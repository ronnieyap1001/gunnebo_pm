"use client";

/**
 * Browser side of a Template Flow write: one opId per user action, all template writes in ONE queue (they all
 * read-modify-write the same template flow), retried with the SAME opId on network errors and BUSY, plain-English
 * toasts on failure, optimistic updates that last until the refreshed page data arrives.
 */
import { startTransition, useEffect, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { isSessionError, isStaleDeploymentError, type ActionResult } from "@/lib/action-result";
import { enqueue, newOpId, onQueueChange, pendingCount } from "@/lib/write-queue";

export type Failure = Extract<ActionResult<unknown>, { ok: false }>;

/** Queue key shared by every template write. */
export const TEMPLATE_QUEUE = "template";

const RETRYABLE = new Set(["BUSY", "NETWORK"]);
const MAX_RETRIES = 4;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The login page redirects signed-in users away, so a plain 200 means the session is gone. */
async function sessionExpired(): Promise<boolean> {
  try {
    const res = await fetch("/login", { redirect: "manual", cache: "no-store", credentials: "same-origin" });
    return res.type !== "opaqueredirect" && res.status === 200;
  } catch {
    return false;
  }
}

/** Calls a Server Action once and turns thrown errors (network, expired session, new deployment) into results. */
export async function attempt<T>(run: () => Promise<ActionResult<T>>): Promise<ActionResult<T>> {
  try {
    return await run();
  } catch (err) {
    if (isStaleDeploymentError(err) || isSessionError(err)) {
      if (await sessionExpired()) return { ok: false, error: "Session expired. Sign in again", code: "SESSION" };
      if (isStaleDeploymentError(err)) {
        return { ok: false, error: "The app was updated. Reload the page to continue.", code: "STALE_DEPLOYMENT" };
      }
    }
    return { ok: false, error: "Couldn't reach the server. Check your connection and try again.", code: "NETWORK" };
  }
}

/** Calls an action, retrying network errors and BUSY with backoff. `run` must re-send the same opId. */
export async function withRetry<T>(run: () => Promise<ActionResult<T>>): Promise<ActionResult<T>> {
  let r = await attempt(run);
  for (let i = 1; !r.ok && RETRYABLE.has(r.code ?? "") && i <= MAX_RETRIES; i++) {
    await sleep(Math.min(8000, 400 * 2 ** i));
    r = await attempt(run);
  }
  return r;
}

// "Saved" indicator: whether the last template write failed (cleared by the next success).
let lastFailed = false;
const failureListeners = new Set<() => void>();
function setLastFailed(v: boolean) {
  if (lastFailed === v) return;
  lastFailed = v;
  for (const fn of failureListeners) fn();
}

/** Runs one template write in the queue (one in flight, FIFO) with retries. */
export function queuedWrite<T>(run: () => Promise<ActionResult<T>>): Promise<ActionResult<T>> {
  return enqueue(TEMPLATE_QUEUE, async () => {
    const r = await withRetry(run);
    setLastFailed(!r.ok);
    return r;
  });
}

/**
 * A write the server refused (not one lost on the way) usually means the template on screen is out of date, e.g. it
 * was changed in another tab: the screen then reloads its data. The screen registers its router.refresh here.
 */
const NOT_A_REFUSAL = new Set(["SESSION", "STALE_DEPLOYMENT", "NETWORK", "BUSY"]);
let refreshPage: (() => void) | null = null;

export function useRefreshAfterRefusal(refresh: () => void): void {
  useEffect(() => {
    refreshPage = refresh;
    return () => {
      if (refreshPage === refresh) refreshPage = null;
    };
  }, [refresh]);
}

export function refreshAfterRefusal(f: Failure): void {
  if (!NOT_A_REFUSAL.has(f.code ?? "")) refreshPage?.();
}

/** The standard failure toast. `retry` re-sends the same write (same opId). */
export function reportFailure(f: Failure, retry?: () => void): void {
  if (f.code === "SESSION") {
    toast.error("Session expired. Sign in again", {
      description: "Your change wasn't saved yet. Sign in (opens a new tab), then press Retry.",
      duration: Infinity,
      action: retry ? { label: "Retry", onClick: retry } : undefined,
      cancel: {
        label: "Sign in",
        onClick: () => window.open(`/login?next=${encodeURIComponent(window.location.pathname)}`, "_blank"),
      },
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

export interface WriteSpec<T> {
  /** The Server Action call. Receives the opId so a retry re-sends the same one. */
  run: (opId: string) => Promise<ActionResult<T>>;
  /** Optimistic update (a useOptimistic dispatch); it reverts by itself when the write fails. */
  optimistic?: () => void;
  onSuccess?: (data: T) => void;
  /** Return true when the failure is fully handled (no default toast). */
  onFailure?: (f: Failure) => boolean | void;
}

/**
 * Fire-and-forget write with an optimistic update. The optimistic state lasts until the transition ends, i.e. until
 * the action has returned together with the refreshed page data (or the write failed, which rolls it back).
 */
export function runWrite<T>(spec: WriteSpec<T>, opId: string = newOpId()): void {
  startTransition(async () => {
    spec.optimistic?.();
    const r = await queuedWrite(() => spec.run(opId));
    if (r.ok) {
      if (spec.onSuccess) startTransition(() => spec.onSuccess!(r.data));
      return;
    }
    let handled = false;
    startTransition(() => {
      handled = spec.onFailure?.(r) === true;
    });
    if (!handled) reportFailure(r, () => runWrite(spec, opId));
    refreshAfterRefusal(r);
  });
}

export type SaveStatus = "idle" | "saving" | "error";

function readSaveStatus(): SaveStatus {
  return pendingCount(TEMPLATE_QUEUE) > 0 ? "saving" : lastFailed ? "error" : "idle";
}

function subscribeSaveStatus(onChange: () => void): () => void {
  failureListeners.add(onChange);
  const off = onQueueChange((key) => {
    if (key === TEMPLATE_QUEUE) onChange();
  });
  return () => {
    failureListeners.delete(onChange);
    off();
  };
}

/**
 * "Saving…" while template writes are queued or in flight; "error" when the last one failed. An external store, so
 * the indicator updates at once: writes start inside a transition, and a plain state update made there would only
 * show once that transition (the whole write) had finished.
 */
export function useSaveStatus(): SaveStatus {
  return useSyncExternalStore(subscribeSaveStatus, readSaveStatus, () => "idle");
}
