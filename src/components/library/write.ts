"use client";

/**
 * Browser side of a library write: one opId per user action, queued per key (one write in flight, FIFO), retried with
 * the SAME opId on network errors and BUSY, plain-English toasts on failure, optimistic updates via React transitions.
 */
import { startTransition, useEffect, useState } from "react";
import { toast } from "sonner";
import { isSessionError, isStaleDeploymentError, type ActionResult } from "@/lib/action-result";
import { enqueue, newOpId, onQueueChange, pendingCount } from "@/lib/write-queue";

export type Failure = Extract<ActionResult<unknown>, { ok: false }>;

/** Queue keys: library edits share the template (flow + revision), project fields their own list. */
export const QUEUE = { library: "library", fields: "project-fields" } as const;

const RETRYABLE = new Set(["BUSY", "NETWORK"]);
/** Failures that usually mean this tab shows stale data (changed in another tab or on another screen). */
const STALE = new Set(["NOT_FOUND", "VALIDATION", "CONFLICT", "FORBIDDEN"]);
const MAX_RETRIES = 4;

let staleRefresh: (() => void) | null = null;
/** The screen registers how to reload its data (router.refresh) after a failure caused by stale data. */
export function setStaleRefresh(fn: (() => void) | null): void {
  staleRefresh = fn;
}
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

async function attempt<T>(run: () => Promise<ActionResult<T>>): Promise<ActionResult<T>> {
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

/** Outcome of the most recent finished write per queue (for the "Saved" / "Not saved" indicator). */
const lastOutcome = new Map<string, { ok: boolean; seq: number }>();
let outcomeSeq = 0;

/** Runs one write in the queue; retries network errors and BUSY with backoff, always with the same call (opId). */
export function queuedWrite<T>(queue: string, run: () => Promise<ActionResult<T>>): Promise<ActionResult<T>> {
  return enqueue(queue, async () => {
    let r = await attempt(run);
    for (let i = 1; !r.ok && RETRYABLE.has(r.code ?? "") && i <= MAX_RETRIES; i++) {
      await sleep(Math.min(8000, 400 * 2 ** i));
      r = await attempt(run);
    }
    lastOutcome.set(queue, { ok: r.ok, seq: ++outcomeSeq });
    return r;
  });
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
  queue: string;
  /** The Server Action call. Receives the opId so a retry re-sends the same one. */
  run: (opId: string) => Promise<ActionResult<T>>;
  /** Optimistic update (a useOptimistic dispatch); reverts by itself when the write fails. */
  optimistic?: () => void;
  onSuccess?: (data: T) => void;
  /** Return true when the failure is fully handled (no default toast). */
  onFailure?: (f: Failure) => boolean | void;
}

/**
 * Fire-and-forget write with an optimistic update. The optimistic state lasts until the transition ends, i.e. until
 * the action has returned and the refreshed page data has arrived (or the write failed, which rolls it back).
 */
export function runWrite<T>(spec: WriteSpec<T>, opId: string = newOpId()): void {
  startTransition(async () => {
    spec.optimistic?.();
    const r = await queuedWrite(spec.queue, () => spec.run(opId));
    if (r.ok) {
      if (spec.onSuccess) startTransition(() => spec.onSuccess!(r.data));
      return;
    }
    let handled = false;
    startTransition(() => {
      handled = spec.onFailure?.(r) === true;
    });
    if (!handled) reportFailure(r, () => runWrite(spec, opId));
    if (STALE.has(r.code ?? "")) staleRefresh?.();
  });
}

/**
 * Number of queued or in-flight writes for the given queues, and whether the last finished one succeeded
 * (for the "Saving…" / "Saved" indicator).
 */
export function usePendingWrites(keys: readonly string[]): { pending: number; lastOk: boolean } {
  const joined = keys.join("|");
  const [state, setState] = useState({ pending: 0, lastOk: true });
  useEffect(() => {
    const list = joined.split("|");
    const read = () =>
      setState((prev) => {
        const pending = list.reduce((n, k) => n + pendingCount(k), 0);
        const latest = list
          .map((k) => lastOutcome.get(k))
          .reduce<{ ok: boolean; seq: number } | undefined>((a, b) => (b && (!a || b.seq > a.seq) ? b : a), undefined);
        const ok = latest?.ok ?? true;
        return prev.pending === pending && prev.lastOk === ok ? prev : { pending, lastOk: ok };
      });
    read();
    // Deferred so the update is never folded into the transition that queued the write.
    return onQueueChange((key) => {
      if (list.includes(key)) setTimeout(read, 0);
    });
  }, [joined]);
  return state;
}
