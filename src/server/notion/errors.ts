import "server-only";
import { APIErrorCode, APIResponseError, RequestTimeoutError, UnknownHTTPResponseError } from "@notionhq/client";

/**
 * Plain-English errors for everything that can go wrong between the app and Notion.
 * Messages are safe to show to the user: they never contain request bodies or tokens.
 * The raw Notion message (useful in logs) is kept in `detail`.
 */
export class NotionError extends Error {
  readonly code: string;
  readonly status?: number;
  /** Raw Notion error message or extra context, for logs only. */
  readonly detail?: string;
  readonly requestId?: string;

  constructor(
    message: string,
    opts: { code?: string; status?: number; detail?: string; requestId?: string; cause?: unknown } = {},
  ) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = new.target.name;
    this.code = opts.code ?? "notion_error";
    this.status = opts.status;
    this.detail = opts.detail;
    this.requestId = opts.requestId;
  }
}

/** No token, an invalid token, or (in production) no Notion at all. */
export class NotConfiguredError extends NotionError {
  constructor(message = NOT_CONFIGURED_MESSAGE, opts: ConstructorParameters<typeof NotionError>[1] = {}) {
    super(message, { code: "not_configured", ...opts });
  }
}

/** The databases or a property the app needs do not exist yet: Setup has to run (again). */
export class SetupIncompleteError extends NotionError {
  constructor(message = "Notion setup has not finished. Open Setup and create the databases.", opts: ConstructorParameters<typeof NotionError>[1] = {}) {
    super(message, { code: "setup_incomplete", ...opts });
  }
}

/** object_not_found / restricted_resource: the page or database is missing or not shared with the integration. */
export class NotSharedError extends NotionError {
  constructor(
    message = "Notion could not find this item. It may have been deleted in Notion, or the Gunnebo PM page is no longer shared with the integration (page menu ··· → Connections).",
    opts: ConstructorParameters<typeof NotionError>[1] = {},
  ) {
    super(message, { code: "not_shared", ...opts });
  }
}

/** 403 restricted_resource with additional_data.block_limit: the Free multi-member workspace limit. */
export class BlockLimitError extends NotionError {
  constructor(opts: ConstructorParameters<typeof NotionError>[1] = {}) {
    super(
      "This Notion workspace has reached the block limit for integrations. Free workspaces with more than one member allow only 1,000 blocks through integrations. Use a Free workspace with only you as a member, or a paid Notion plan.",
      { code: "block_limit", status: 403, ...opts },
    );
  }
}

/** 429 / 529 after the SDK's own retries are used up. Client-driven batches should pause and resume. */
export class NotionBusyError extends NotionError {
  /** Retry-After from Notion, when it sent one. */
  readonly retryAfterMs?: number;
  constructor(opts: ConstructorParameters<typeof NotionError>[1] & { retryAfterMs?: number } = {}) {
    super("Notion is busy right now. Wait a moment and try again; batches resume where they stopped.", {
      code: "busy",
      ...opts,
    });
    this.retryAfterMs = opts.retryAfterMs;
  }
}

/**
 * 500 / 503 / 504 or a timeout. For a write, Notion may already have saved it:
 * callers must re-read before retrying (`mayHaveCommitted`).
 */
export class NotionUnavailableError extends NotionError {
  readonly mayHaveCommitted: boolean;
  readonly committedResourceId?: string;
  constructor(
    opts: ConstructorParameters<typeof NotionError>[1] & { mayHaveCommitted?: boolean; committedResourceId?: string } = {},
  ) {
    super("Notion did not respond in time. Check your connection and try again.", { code: "unavailable", ...opts });
    this.mayHaveCommitted = opts.mayHaveCommitted ?? true;
    this.committedResourceId = opts.committedResourceId;
  }
}

/** A value is bigger than Notion can store (200 KB of text, 500 KB per request, 4 MB per file). */
export class ValueTooLargeError extends NotionError {
  constructor(message: string, opts: ConstructorParameters<typeof NotionError>[1] = {}) {
    super(message, { code: "too_large", ...opts });
  }
}

export class FileTooLargeError extends ValueTooLargeError {
  constructor(size: number, max: number) {
    super(
      `This file is ${formatMb(size)}; files up to ${formatMb(max)} can be stored in Notion. Paste a SharePoint or OneDrive link instead.`,
      { code: "file_too_large", status: 413 },
    );
  }
}

const NOT_CONFIGURED_MESSAGE =
  "Notion is not connected yet. Add NOTION_TOKEN in Vercel → Project → Settings → Environment Variables, then redeploy.";

function formatMb(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

/** The raw Notion API error code of `e`, if it is one (e.g. 'object_not_found'). */
export function notionErrorCode(e: unknown): string | undefined {
  if (APIResponseError.isAPIResponseError(e)) return e.code;
  return undefined;
}

export function isNotionCode(e: unknown, code: `${APIErrorCode}`): boolean {
  return notionErrorCode(e) === code;
}

function additionalData(e: APIResponseError): Record<string, unknown> {
  if (e.additional_data && typeof e.additional_data === "object") return e.additional_data;
  try {
    const body = JSON.parse(e.body) as { additional_data?: Record<string, unknown> };
    return body.additional_data ?? {};
  } catch {
    return {};
  }
}

function retryAfterMs(headers: unknown): number | undefined {
  let raw: string | undefined;
  if (headers && typeof headers === "object") {
    const get = (headers as { get?: unknown }).get;
    if (typeof get === "function") {
      const v = (get as (n: string) => unknown).call(headers, "retry-after");
      raw = typeof v === "string" ? v : undefined;
    } else {
      for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
        if (k.toLowerCase() === "retry-after" && typeof v === "string") raw = v;
      }
    }
  }
  if (!raw) return undefined;
  const s = Number.parseInt(raw, 10);
  if (Number.isFinite(s) && s >= 0) return s * 1000;
  const d = Date.parse(raw);
  return Number.isNaN(d) ? undefined : Math.max(0, d - Date.now());
}

/**
 * Turns anything thrown by the Notion SDK (or the fake) into one of the errors above.
 * Errors that are not Notion errors (bugs) are returned unchanged.
 */
export function mapNotionError(e: unknown): unknown {
  if (e instanceof NotionError) return e;
  if (APIResponseError.isAPIResponseError(e)) {
    const base = { status: e.status, detail: e.message, requestId: e.request_id, cause: e };
    const data = additionalData(e);
    switch (e.code) {
      case APIErrorCode.Unauthorized:
        return new NotConfiguredError(
          "Notion rejected the integration token. Copy the secret again from notion.so/profile/integrations into NOTION_TOKEN and redeploy.",
          base,
        );
      case APIErrorCode.RestrictedResource:
        if (data.block_limit !== undefined) return new BlockLimitError(base);
        return new NotSharedError(
          "The Notion integration does not have access to this page or database. Share the Gunnebo PM page with the integration (page menu ··· → Connections).",
          base,
        );
      case APIErrorCode.ObjectNotFound:
        return new NotSharedError(undefined, base);
      case APIErrorCode.RateLimited:
      case APIErrorCode.ServiceOverload:
        return new NotionBusyError({ ...base, retryAfterMs: retryAfterMs(e.headers) });
      case APIErrorCode.InternalServerError:
      case APIErrorCode.ServiceUnavailable:
      case APIErrorCode.GatewayTimeout: {
        const committed = typeof data.committed_resource_id === "string" ? data.committed_resource_id : undefined;
        return new NotionUnavailableError({ ...base, committedResourceId: committed });
      }
      case APIErrorCode.ConflictError:
        return new NotionError("Notion was saving another change at the same moment. Try again.", {
          ...base,
          code: "conflict_error",
        });
      default:
        return new NotionError(`Notion rejected the request (${e.code}).`, { ...base, code: e.code });
    }
  }
  if (RequestTimeoutError.isRequestTimeoutError(e)) {
    return new NotionUnavailableError({ detail: e.message, cause: e });
  }
  if (UnknownHTTPResponseError.isUnknownHTTPResponseError(e)) {
    const base = { status: e.status, detail: e.message, cause: e };
    if (e.status === 429) return new NotionBusyError({ ...base, retryAfterMs: retryAfterMs(e.headers) });
    if (e.status === 413) return new ValueTooLargeError("This change is too large to send to Notion in one go.", base);
    if (e.status >= 500) return new NotionUnavailableError(base);
    return new NotionError(`Notion answered with an unexpected error (HTTP ${e.status}).`, base);
  }
  if (e instanceof TypeError && /fetch failed|network/i.test(e.message)) {
    return new NotionUnavailableError({ detail: e.message, cause: e, mayHaveCommitted: false });
  }
  return e;
}

/** Runs `fn` and rethrows any Notion error as a plain-English one. */
export async function withNotionErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw mapNotionError(e);
  }
}
