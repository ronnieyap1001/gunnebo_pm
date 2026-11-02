"use client";

import { toast } from "sonner";
import { isSessionError, isStaleDeploymentError, type ActionResult } from "@/lib/action-result";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const RETRYABLE = new Set(["BUSY", "NETWORK"]);

/**
 * An expired session makes the proxy answer a Server Action with a 401, which Next reports as "an unexpected
 * response", the same words as a stale deployment. The login page sends signed-in users away, so a plain 200 from
 * it means the session is gone.
 */
async function sessionExpired(): Promise<boolean> {
  try {
    const res = await fetch("/login", { redirect: "manual", cache: "no-store", credentials: "same-origin" });
    return res.type !== "opaqueredirect" && res.status === 200;
  } catch {
    return false;
  }
}

export type Failure = Extract<ActionResult<never>, { ok: false }>;

const failure = (error: string, code: string): Failure => ({ ok: false, error, code });

/** Turns an error thrown by a Server Action call into a plain-English result: SESSION, STALE_DEPLOYMENT or NETWORK. */
export async function classifyThrown(err: unknown): Promise<Failure> {
  if (isStaleDeploymentError(err) || isSessionError(err)) {
    if (await sessionExpired()) return failure("Session expired. Sign in again.", "SESSION");
    if (isStaleDeploymentError(err)) {
      return failure("The app was updated while this page was open. Reload the page and try again.", "STALE_DEPLOYMENT");
    }
  }
  return failure("Could not reach the server. Check your connection and try again.", "NETWORK");
}

/**
 * Calls a Server Action and retries network errors and BUSY answers with backoff. The caller's closure carries the
 * opId, so every retry reuses the SAME opId (services are idempotent per opId). Never throws.
 */
export async function callAction<T>(
  fn: () => Promise<ActionResult<T>>,
  opts: { retries?: number } = {},
): Promise<ActionResult<T>> {
  const retries = opts.retries ?? 3;
  for (let attempt = 0; ; attempt++) {
    let result: ActionResult<T>;
    try {
      result = await fn();
    } catch (err) {
      result = await classifyThrown(err);
    }
    if (!result.ok && RETRYABLE.has(result.code ?? "") && attempt < retries) {
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    return result;
  }
}

/** True when trying the same call again later can succeed (network trouble, Notion busy). */
export function isRetryable(result: { code?: string }): boolean {
  return RETRYABLE.has(result.code ?? "");
}

/**
 * Plain-English error toast for a failed ActionResult, with the right follow-up button. `retry` (offered for network
 * and busy errors, and after signing in again) must re-send the same call with the same opId.
 */
export function toastError(result: { error: string; code?: string }, title?: string, opts: { retry?: () => void } = {}): void {
  const here = () => window.location.pathname + window.location.search;
  // A second start while a task's progress dialog is open (e.g. a double click): that task carries on, nothing to say.
  if (result.code === "BUSY_LOCAL") return;
  if (result.code === "SESSION") {
    if (opts.retry) {
      toast.error("Session expired. Sign in again.", {
        description: "Nothing was lost. Sign in (opens a new tab), then press Retry.",
        duration: Infinity,
        action: { label: "Retry", onClick: opts.retry },
        cancel: { label: "Sign in", onClick: () => window.open(`/login?next=${encodeURIComponent(here())}`, "_blank") },
      });
    } else {
      toast.error("Session expired. Sign in again.", {
        duration: Infinity,
        action: { label: "Sign in", onClick: () => window.location.assign(`/login?next=${encodeURIComponent(here())}`) },
      });
    }
    return;
  }
  if (result.code === "STALE_DEPLOYMENT") {
    toast.error(result.error, { duration: Infinity, action: { label: "Reload", onClick: () => window.location.reload() } });
    return;
  }
  const action = opts.retry && isRetryable(result) ? { label: "Retry", onClick: opts.retry } : undefined;
  const duration = action ? 15_000 : undefined;
  if (title) toast.error(title, { description: result.error, action, duration });
  else toast.error(result.error, { action, duration });
}
