"use client";

/**
 * Browser side of Server Action calls for the shell, Projects and Portfolio screens. The caller's closure carries the
 * opId, so every retry re-sends the SAME opId (services are idempotent per opId). Never throws.
 */
import { toast } from "sonner";
import { fail, isSessionError, isStaleDeploymentError, type ActionResult } from "@/lib/action-result";

export type Failure = Extract<ActionResult<unknown>, { ok: false }>;

const RETRYABLE = new Set(["BUSY", "NETWORK"]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The login page sends signed-in users away, so a plain 200 from it means the session is gone. */
async function sessionExpired(): Promise<boolean> {
  try {
    const res = await fetch("/login", { redirect: "manual", cache: "no-store", credentials: "same-origin" });
    return res.type !== "opaqueredirect" && res.status === 200;
  } catch {
    return false;
  }
}

async function attempt<T>(fn: () => Promise<ActionResult<T>>): Promise<ActionResult<T>> {
  try {
    return await fn();
  } catch (err) {
    if (isStaleDeploymentError(err) || isSessionError(err)) {
      if (await sessionExpired()) return fail("Session expired. Sign in again", "SESSION");
      if (isStaleDeploymentError(err)) return fail("The app was updated. Reload the page to continue.", "STALE_DEPLOYMENT");
    }
    return fail("Couldn't reach the server. Check your connection and try again.", "NETWORK");
  }
}

/** Calls a Server Action; network errors and BUSY answers are retried with backoff (same call, same opId). */
export async function callAction<T>(fn: () => Promise<ActionResult<T>>, opts: { retries?: number } = {}): Promise<ActionResult<T>> {
  const retries = opts.retries ?? 3;
  let r = await attempt(fn);
  for (let i = 1; !r.ok && RETRYABLE.has(r.code ?? "") && i <= retries; i++) {
    await sleep(Math.min(8000, 500 * 2 ** i));
    r = await attempt(fn);
  }
  return r;
}

export function isRetryable(f: Failure): boolean {
  return RETRYABLE.has(f.code ?? "");
}

/** Plain-English error toast with the right follow-up button. `retry` re-sends the same call (same opId). */
export function toastFailure(f: Failure, opts: { title?: string; retry?: () => void } = {}): void {
  if (f.code === "SESSION") {
    toast.error("Session expired. Sign in again", {
      description: opts.retry ? "Nothing was lost. Sign in (opens a new tab), then press Retry." : undefined,
      duration: Infinity,
      action: opts.retry ? { label: "Retry", onClick: opts.retry } : undefined,
      cancel: {
        label: "Sign in",
        onClick: () => window.open(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`, "_blank"),
      },
    });
    return;
  }
  if (f.code === "STALE_DEPLOYMENT") {
    toast.error(f.error, { duration: Infinity, action: { label: "Reload", onClick: () => window.location.reload() } });
    return;
  }
  const action = opts.retry && isRetryable(f) ? { label: "Retry", onClick: opts.retry } : undefined;
  if (opts.title) toast.error(opts.title, { description: f.error, action, duration: action ? 15_000 : undefined });
  else toast.error(f.error, { action, duration: action ? 15_000 : undefined });
}
