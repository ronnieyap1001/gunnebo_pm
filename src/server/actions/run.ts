import "server-only";
import { updateTag } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import type { EventSource } from "@/domain/types";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { requireUser } from "@/server/auth/session";
import { getActionCtx } from "@/server/queries/cached";
import type { CacheTag } from "@/server/queries/tags";
import { isAppError, type Ctx } from "@/server/services/context";
import {
  BlockLimitError,
  NotConfiguredError,
  NotionBusyError,
  NotionError,
  NotionUnavailableError,
  NotSharedError,
  SetupIncompleteError,
  ValueTooLargeError,
} from "@/server/notion/errors";

export interface RunActionOptions {
  /** Cache tags to refresh after a successful write (library, project-fields, settings). */
  tags?: CacheTag[];
  source?: EventSource;
}

/** Turn any error into a plain-English result. Never leaks stack traces, tokens or request bodies. */
export function toActionError(err: unknown): ActionResult<never> {
  if (isAppError(err)) return fail(err.message, err.code, err.details);
  if (err instanceof NotionBusyError || err instanceof NotionUnavailableError) {
    return fail("Notion is busy right now. Wait a moment and try again.", "BUSY");
  }
  if (err instanceof BlockLimitError) return fail(err.message, "BLOCK_LIMIT");
  if (err instanceof NotConfiguredError) return fail(err.message, "NOT_CONFIGURED");
  if (err instanceof SetupIncompleteError) return fail(err.message, "SETUP_INCOMPLETE");
  if (err instanceof NotSharedError) return fail(err.message, "NOT_SHARED");
  if (err instanceof ValueTooLargeError) return fail(err.message, "TOO_LARGE");
  if (err instanceof NotionError) return fail(err.message, "NOTION");
  console.error("[action] unexpected error", err instanceof Error ? `${err.name}: ${err.message}` : "unknown");
  return fail("Something went wrong. Try again; if it keeps happening, reload the page.", "UNKNOWN");
}

/**
 * Wrapper for every Server Action:
 * sign-in check → context (opId from the browser, actor, today in the configured time zone) → service call →
 * cache tag refresh → `{ ok: true, data }` or a plain-English `{ ok: false, error, code }`.
 * Retrying with the same opId is safe: services are idempotent per opId.
 */
export async function runAction<T>(
  opId: string,
  fn: (ctx: Ctx) => Promise<T>,
  opts: RunActionOptions = {},
): Promise<ActionResult<T>> {
  try {
    await requireUser();
    if (typeof opId !== "string" || !/^[A-Za-z0-9-]{8,64}$/.test(opId)) {
      return fail("This action is missing its id. Reload the page and try again.", "VALIDATION");
    }
    const ctx = await getActionCtx({ opId, source: opts.source });
    const data = await fn(ctx);
    for (const tag of opts.tags ?? []) updateTag(tag);
    return ok(data);
  } catch (err) {
    unstable_rethrow(err); // let redirect()/notFound() through
    return toActionError(err);
  }
}

/** For read-only actions (lazy loading history, tooltips): sign-in check + error mapping, no context. */
export async function runQuery<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    await requireUser();
    return ok(await fn());
  } catch (err) {
    unstable_rethrow(err);
    return toActionError(err);
  }
}
