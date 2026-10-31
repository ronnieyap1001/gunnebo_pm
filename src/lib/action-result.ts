/** Shape every Server Action returns. Never throw raw errors to the client. */
export type ActionResult<T = undefined> =
  | { ok: true; data: T }
  | { ok: false; error: string; code?: string; details?: Record<string, unknown> };

export function ok<T>(data: T): ActionResult<T> {
  return { ok: true, data };
}

export function fail(error: string, code?: string, details?: Record<string, unknown>): ActionResult<never> {
  return details ? { ok: false, error, code, details } : { ok: false, error, code };
}

/** True when a thrown client-side error means the deployment changed under an open tab. */
export function isStaleDeploymentError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /Failed to find Server Action|was not found on the server|unexpected response was received/i.test(msg);
}

/** True when the proxy rejected an action because the session expired. */
export function isSessionError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /\b401\b|session/i.test(msg);
}
