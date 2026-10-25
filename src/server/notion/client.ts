import "server-only";
import path from "node:path";
import { Client, isNotionClientError, APIErrorCode } from "@notionhq/client";
import type { PageObjectResponse } from "@notionhq/client";
import type { StorageMode } from "@/server/repo/types";
import { NotConfiguredError } from "./errors";
import { createFakeNotion } from "./fake";

// ---------------------------------------------------------------------------
// The subset of the SDK the app uses, typed with the SDK's own request and response types.
// The real Client and the fake are both NotionLike, so every caller works with either.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => unknown;
/** First argument of an SDK method (never undefined). */
export type Arg<F extends AnyFn> = NonNullable<Parameters<F>[0]>;
type Method<F extends AnyFn> = (args: Arg<F>) => ReturnType<F>;

export interface NotionLike {
  databases: {
    create: Method<Client["databases"]["create"]>;
    retrieve: Method<Client["databases"]["retrieve"]>;
    update: Method<Client["databases"]["update"]>;
  };
  dataSources: {
    retrieve: Method<Client["dataSources"]["retrieve"]>;
    query: Method<Client["dataSources"]["query"]>;
    update: Method<Client["dataSources"]["update"]>;
  };
  pages: {
    create: Method<Client["pages"]["create"]>;
    retrieve: Method<Client["pages"]["retrieve"]>;
    update: Method<Client["pages"]["update"]>;
  };
  blocks: {
    children: { list: Method<Client["blocks"]["children"]["list"]> };
  };
  search: Method<Client["search"]>;
  fileUploads: {
    create: Method<Client["fileUploads"]["create"]>;
    send: Method<Client["fileUploads"]["send"]>;
  };
}

export type DatabaseCreateArgs = Arg<Client["databases"]["create"]>;
export type DatabaseUpdateArgs = Arg<Client["databases"]["update"]>;
export type DataSourceUpdateArgs = Arg<Client["dataSources"]["update"]>;
export type QueryArgs = Arg<Client["dataSources"]["query"]>;
export type QueryFilter = NonNullable<QueryArgs["filter"]>;
export type QuerySort = NonNullable<QueryArgs["sorts"]>[number];
export type PageCreateArgs = Arg<Client["pages"]["create"]>;
export type PageUpdateArgs = Arg<Client["pages"]["update"]>;
export type SearchArgs = Arg<Client["search"]>;
export type FileUploadCreateArgs = Arg<Client["fileUploads"]["create"]>;
export type FileUploadSendArgs = Arg<Client["fileUploads"]["send"]>;
export type BlockChildrenListArgs = Arg<Client["blocks"]["children"]["list"]>;

/** A property value as written by pages.create / pages.update. */
export type PropWrite = NonNullable<PageUpdateArgs["properties"]>[string];
export type PropWrites = Record<string, PropWrite>;
/** A rich text item as sent in requests. */
export type RichTextRequest = Extract<PropWrite, { rich_text: unknown }>["rich_text"][number];
/** A property definition for databases.create / dataSources.update (create branch). */
export type PropertyConfig = NonNullable<NonNullable<DatabaseCreateArgs["initial_data_source"]>["properties"]>[string];
/** A property value as returned on a page. */
export type PropValue = PageObjectResponse["properties"][string];

// ---------------------------------------------------------------------------
// Mode selection
// ---------------------------------------------------------------------------

export const NOTION_VERSION = "2025-09-03";

/** Any env-like record (process.env, or a plain object in tests). */
export type EnvLike = Readonly<Record<string, string | undefined>>;

/**
 * 'notion' when NOTION_TOKEN is set; 'fake' only off Vercel without a token (local dev, tests, e2e);
 * 'unconfigured' on Vercel without a token (the app shows Setup instructions, never the fake).
 */
export function storageMode(env: EnvLike = process.env): StorageMode {
  if (env.NOTION_TOKEN) return "notion";
  if (!env.VERCEL) return "fake";
  return "unconfigured";
}

type ClientOptions = NonNullable<ConstructorParameters<typeof Client>[0]>;

/**
 * The real SDK client with the agreed retry policy. The SDK retries 429/529 on every method and
 * 500/503 on GET/DELETE (honouring Retry-After, capped at 8 s); there is no second retry loop on top.
 */
export function createRealNotion(opts: { auth: string; fetch?: ClientOptions["fetch"]; logLevel?: ClientOptions["logLevel"] }): NotionLike {
  return new Client({
    auth: opts.auth,
    notionVersion: NOTION_VERSION,
    timeoutMs: 20_000,
    retry: { maxRetries: 3, initialRetryDelayMs: 500, maxRetryDelayMs: 8_000 },
    fetch: opts.fetch,
    logLevel: opts.logLevel,
  });
}

// ---------------------------------------------------------------------------
// Concurrency gate (per instance; not global across Vercel instances)
// ---------------------------------------------------------------------------

export function createGate(limit: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: (() => void)[] = [];
  const release = () => {
    active--;
    const next = waiting.shift();
    if (next) next();
  };
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    active++;
    try {
      return await fn();
    } finally {
      release();
    }
  };
}

function isConflict(e: unknown): boolean {
  return isNotionClientError(e) && e.code === APIErrorCode.ConflictError;
}

/**
 * Wraps a NotionLike so that at most `limit` requests are in flight from this instance.
 * A 409 conflict_error (which the SDK never retries) is retried once after a short pause:
 * Notion rolled the conflicting request back, and every write the app sends is a full set of the
 * properties it changes, so sending it again equals "re-read and retry once".
 * Rate limits are NOT retried here (the SDK already did).
 */
export function withConcurrencyGate(inner: NotionLike, limit = 3): NotionLike {
  const gate = createGate(limit);
  const wrap =
    <A, R>(fn: (a: A) => Promise<R>) =>
    (a: A): Promise<R> =>
      gate(async () => {
        try {
          return await fn(a);
        } catch (e) {
          if (!isConflict(e)) throw e;
          await new Promise((r) => setTimeout(r, 150 + Math.floor(Math.random() * 200)));
          return fn(a);
        }
      });
  return {
    databases: {
      create: wrap(inner.databases.create),
      retrieve: wrap(inner.databases.retrieve),
      update: wrap(inner.databases.update),
    },
    dataSources: {
      retrieve: wrap(inner.dataSources.retrieve),
      query: wrap(inner.dataSources.query),
      update: wrap(inner.dataSources.update),
    },
    pages: {
      create: wrap(inner.pages.create),
      retrieve: wrap(inner.pages.retrieve),
      update: wrap(inner.pages.update),
    },
    blocks: { children: { list: wrap(inner.blocks.children.list) } },
    search: wrap(inner.search),
    fileUploads: {
      create: wrap(inner.fileUploads.create),
      send: wrap(inner.fileUploads.send),
    },
  };
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

const KEY = Symbol.for("gunnebo-pm.notion");
type Holder = { [KEY]?: { mode: StorageMode; client: NotionLike } };

/** Path of the fake's JSON file (`data/fake-notion.json`, or FAKE_NOTION_FILE; ':memory:' keeps it in memory). */
export function fakeNotionFile(env: EnvLike = process.env): string | undefined {
  const f = env.FAKE_NOTION_FILE;
  if (f === ":memory:") return undefined;
  return f ? path.resolve(f) : path.resolve(process.cwd(), "data", "fake-notion.json");
}

/**
 * The process-wide Notion client (kept on globalThis so dev hot reloads reuse it).
 * Throws NotConfiguredError when running on Vercel without NOTION_TOKEN.
 */
export function getNotion(): NotionLike {
  const holder = globalThis as Holder;
  const mode = storageMode();
  const cached = holder[KEY];
  if (cached && cached.mode === mode) return cached.client;
  let client: NotionLike;
  if (mode === "notion") {
    client = withConcurrencyGate(createRealNotion({ auth: process.env.NOTION_TOKEN as string }));
  } else if (mode === "fake") {
    client = withConcurrencyGate(createFakeNotion({ file: fakeNotionFile() }));
  } else {
    throw new NotConfiguredError();
  }
  holder[KEY] = { mode, client };
  return client;
}

/** Tests / e2e: replace (or clear with null) the process-wide client. */
export function setNotionForTesting(client: NotionLike | null): void {
  const holder = globalThis as Holder;
  if (client) holder[KEY] = { mode: storageMode(), client };
  else delete holder[KEY];
}
