/**
 * CR-1: the schema registry shared through Next's unstable_cache must not outlive a change made in Notion.
 *
 * Production wiring (src/server/queries/cached.ts with the real next/cache and next/server, getRepo() and
 * getStorageAdmin()) on a fake Notion, inside Next's real request stores: a page render runs in phase 'render' (where
 * revalidateTag throws), after() callbacks run once the response is done, and a Server Action runs in phase 'action'.
 * The incremental cache is Next's own with an in-memory handler, and the clock drives performance.now too, so the 1 h
 * revalidate and the stale-while-revalidate refresh really happen. Scenario: the Projects database is moved to Notion's
 * trash, the case Setup's "Repair databases" exists for.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { currentSetupStep } from "@/components/admin/setup-steps";
import { createFakeNotion, type FakeNotion } from "@/server/notion/fake";
import { discoverRegistry, SETTINGS_SEED_KEY, upsertSettingRow, type Registry } from "@/server/notion/registry";
import { FAKE_OPTS, runSetup } from "./helpers";

// Next's request stores need the global AsyncLocalStorage that its runtime installs.
(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage ??= AsyncLocalStorage;
const req = createRequire(path.resolve("node_modules/next/package.json"));
/* eslint-disable @typescript-eslint/no-explicit-any */
const { AfterContext } = req("next/dist/server/after/after-context.js");
const { workAsyncStorage } = req("next/dist/server/app-render/work-async-storage.external.js");
const { workUnitAsyncStorage } = req("next/dist/server/app-render/work-unit-async-storage.external.js");
const { IncrementalCache } = req("next/dist/server/lib/incremental-cache/index.js");
const { tagsManifest } = req("next/dist/server/lib/incremental-cache/tags-manifest.external.js");
const { withExecuteRevalidates } = req("next/dist/server/revalidation-utils.js");

/** Next's IncrementalCache over an in-memory handler (what Vercel's data cache does for unstable_cache entries). */
function makeIncrementalCache() {
  const store = new Map<string, { value: unknown; lastModified: number }>();
  const handler = {
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async set(key: string, data: unknown) {
      store.set(key, { value: data, lastModified: Date.now() });
    },
    async revalidateTag(tags: string | string[], durations?: { expire?: number }) {
      const now = Date.now();
      for (const tag of typeof tags === "string" ? [tags] : tags) {
        const e = tagsManifest.get(tag) || {};
        if (durations) tagsManifest.set(tag, { ...e, stale: now, ...(durations.expire !== undefined ? { expired: now + durations.expire * 1000 } : {}) });
        else tagsManifest.set(tag, { ...e, expired: now });
      }
    },
    resetRequestCache() {},
  };
  return new IncrementalCache({
    dev: false,
    requestHeaders: {},
    minimalMode: false,
    fetchCacheKeyPrefix: "",
    CurCacheHandler: function () {
      return handler;
    },
    previewProps: { previewModeId: "x", previewModeSigningKey: "y", previewModeEncryptionKey: "z" },
    prerenderManifest: { version: 4, routes: {}, dynamicRoutes: {}, preview: {}, notFoundRoutes: [] },
  });
}

/** One request: `fn` runs as a page render or a Server Action; then pending cache writes and after() callbacks run. */
async function inRequest<T>(ic: unknown, phase: "render" | "action", fn: () => Promise<T>): Promise<T> {
  const closers: (() => void)[] = [];
  const waits: Promise<unknown>[] = [];
  const afterContext = new AfterContext({ waitUntil: (p: Promise<unknown>) => waits.push(p), onClose: (cb: () => void) => closers.push(cb) });
  const workStore: any = {
    incrementalCache: ic,
    route: "/p",
    page: "/p/page",
    isOnDemandRevalidate: false,
    isDraftMode: false,
    nextFetchId: 1,
    cacheLifeProfiles: {},
    afterContext,
  };
  const unit = { type: "request", phase, url: { pathname: "/p", search: "" }, implicitTags: { tags: [] } };
  try {
    return await workAsyncStorage.run(workStore, () => workUnitAsyncStorage.run(unit, () => withExecuteRevalidates(workStore, fn)));
  } finally {
    await Promise.allSettled(Object.values(workStore.pendingRevalidates ?? {}));
    for (const close of closers.splice(0)) close();
    await workAsyncStorage.run(workStore, async () => {
      for (let i = 0; i < 5 && waits.length; i++) await Promise.allSettled(waits.splice(0));
    });
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const tick = (ms: number) => vi.setSystemTime(Date.now() + ms);

interface App {
  notion: FakeNotion;
  reg0: Registry;
  /** A guarded page (requireReadyStorage, then a read), rendered by this server instance. */
  page(read?: "projects" | "template"): Promise<string>;
  /** The Setup page's current step, rendered by this server instance. */
  setup(): Promise<string>;
  /** Setup → "Check again" (a Server Action). */
  checkAgain(): Promise<string>;
  /** Another server instance starts (nothing remembered; same shared cache). */
  coldInstance(): Promise<void>;
}

async function app(): Promise<App> {
  const notion = createFakeNotion();
  await runSetup(notion);
  const reg0 = await discoverRegistry(notion, FAKE_OPTS);
  await upsertSettingRow(notion, reg0.dbs.settings!, SETTINGS_SEED_KEY, "2026-10-25T00:00:00Z");
  const client = await import("@/server/notion/client");
  client.setNotionForTesting(client.withConcurrencyGate(notion));
  const repoModule = await import("@/server/repo");
  repoModule.resetRepoForTesting();
  const cached = await import("@/server/queries/cached");
  const ic = makeIncrementalCache();

  const guard = async () => {
    // Same decision as requireReadyStorage (src/server/guards.ts).
    const s = await repoModule.getStorageAdmin().status();
    if (s.mode !== "unconfigured" && s.schemaReady && s.seeded) return "ok";
    return s.errorKind === "busy" ? "busy page" : "-> /setup";
  };
  return {
    notion,
    reg0,
    page: (read = "projects") =>
      inRequest(ic, "render", async () => {
        const g = await guard();
        if (g !== "ok") return g;
        try {
          if (read === "projects") await repoModule.getRepo().projects.list();
          else await cached.getCachedTemplate();
          return "ok";
        } catch (e) {
          return `error page (${(e as Error).name})`;
        }
      }),
    setup: () => inRequest(ic, "render", async () => currentSetupStep(await repoModule.getStorageAdmin().status())),
    checkAgain: () =>
      inRequest(ic, "action", async () => {
        await repoModule.getStorageAdmin().resetCaches();
        return currentSetupStep(await repoModule.getStorageAdmin().status());
      }),
    coldInstance: async () => repoModule.resetRepoForTesting(),
  };
}

describe("the shared schema registry after a database is moved to Notion's trash (CR-1)", () => {
  beforeEach(() => {
    if (process.env.NOTION_TOKEN || process.env.VERCEL) return;
    vi.resetModules();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.spyOn(performance, "now").mockImplementation(() => Date.now() - performance.timeOrigin);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    tagsManifest.clear();
    const repo = await import("@/server/repo");
    repo.setRegistryLoader(undefined);
    repo.resetRepoForTesting();
    (await import("@/server/notion/client")).setNotionForTesting(null);
  });

  it("a page that meets the stale id sends every later view to Setup, which offers the repair, also hours later", async () => {
    if (process.env.NOTION_TOKEN || process.env.VERCEL) return;
    const a = await app();
    expect(await a.setup()).toBe("ready");
    await a.notion.databases.update({ database_id: a.reg0.dbs.projects!.databaseId, in_trash: true });
    tick(5 * 60_000);
    // The guard passed on the shared copy; the query found the database gone. Error page for this one view.
    expect(await a.page()).toBe("error page (SetupIncompleteError)");
    const log: string[] = [];
    for (const [ms, what] of [
      [3_000, "page"],
      [60_000, "page"], // the error page says "wait a minute and try again"
      [60_000, "page"],
      [15_000, "setup"],
      [2 * 3600_000, "setup"],
      [30_000, "page"],
      [24 * 3600_000, "setup"],
    ] as const) {
      tick(ms);
      log.push(`${what}: ${what === "page" ? await a.page() : await a.setup()}`);
    }
    expect(log).toEqual([
      "page: -> /setup",
      "page: -> /setup",
      "page: -> /setup",
      "setup: databases",
      "setup: databases",
      "page: -> /setup",
      "setup: databases",
    ]);
    // Another instance sees the same: the shared copy was dropped right after the first response.
    await a.coldInstance();
    expect(await a.setup()).toBe("databases");

    // The database is restored from Notion's trash: "Check again" brings everything back.
    await a.notion.databases.update({ database_id: a.reg0.dbs.projects!.databaseId, in_trash: false });
    tick(5_000);
    expect(await a.checkAgain()).toBe("ready");
    expect(await a.page()).toBe("ok");
    await a.coldInstance();
    tick(5_000);
    expect(await a.page()).toBe("ok");
  });

  it("the page that met the stale id drops the shared copy right after its response: another instance sees the repair at once", async () => {
    if (process.env.NOTION_TOKEN || process.env.VERCEL) return;
    const a = await app();
    expect(await a.page()).toBe("ok");
    await a.notion.databases.update({ database_id: a.reg0.dbs.projects!.databaseId, in_trash: true });
    tick(5 * 60_000);
    expect(await a.page()).toBe("error page (SetupIncompleteError)");
    await a.coldInstance();
    expect(await a.page()).toBe("-> /setup");
    expect(await a.setup()).toBe("databases");
  });

  it("a database restored by hand in Notion works again without Check again, and the shared copy is ready again", async () => {
    if (process.env.NOTION_TOKEN || process.env.VERCEL) return;
    const a = await app();
    expect(await a.page()).toBe("ok");
    await a.notion.databases.update({ database_id: a.reg0.dbs.projects!.databaseId, in_trash: true });
    tick(5 * 60_000);
    await a.page();
    tick(3_000);
    expect(await a.page()).toBe("-> /setup");
    await a.notion.databases.update({ database_id: a.reg0.dbs.projects!.databaseId, in_trash: false });
    tick(11_000);
    expect(await a.page()).toBe("ok");
    // That view found the shared copy (not ready) out of date and dropped it; a cold instance reads a ready one again.
    await a.coldInstance();
    tick(1_000);
    expect(await a.page()).toBe("ok");
    a.notion.fake.resetCalls();
    await a.coldInstance();
    expect(await a.page()).toBe("ok");
    expect(a.notion.fake.callCount("search")).toBe(0); // no discovery: the shared copy is used
  });

  it("a shared copy that says 'not set up' is checked again: a database restored by hand works on every instance", async () => {
    if (process.env.NOTION_TOKEN || process.env.VERCEL) return;
    const a = await app();
    expect(await a.page()).toBe("ok");
    await a.notion.databases.update({ database_id: a.reg0.dbs.projects!.databaseId, in_trash: true });
    tick(5 * 60_000);
    expect(await a.page()).toBe("error page (SetupIncompleteError)");
    // Another instance discovers afresh: the shared copy now says the Projects database is missing.
    await a.coldInstance();
    tick(1_000);
    expect(await a.page()).toBe("-> /setup");
    await a.notion.databases.update({ database_id: a.reg0.dbs.projects!.databaseId, in_trash: false });
    // A third instance starts: it does not take the shared "missing" for granted, and drops it.
    await a.coldInstance();
    tick(1_000);
    expect(await a.page()).toBe("ok");
    a.notion.fake.resetCalls();
    for (let i = 0; i < 2; i++) {
      await a.coldInstance();
      tick(1_000);
      expect(await a.page()).toBe("ok");
      expect(await a.setup()).toBe("ready");
    }
    expect(a.notion.fake.callCount("search")).toBe(1); // one discovery refills the shared copy, then it is used
  });

  it("a stale id met inside a cached function (where nothing can be revalidated) still sends this instance to Setup", async () => {
    if (process.env.NOTION_TOKEN || process.env.VERCEL) return;
    const a = await app();
    expect(await a.page("template")).toBe("ok");
    await a.notion.databases.update({ database_id: a.reg0.dbs.milestones!.databaseId, in_trash: true });
    tick(2 * 60_000);
    // The template cache (60 s) is served once more while its refresh runs in the background, inside unstable_cache:
    // that refresh meets the stale id and resets the registry, but cannot revalidate the shared copy.
    expect(await a.page("template")).toBe("ok");
    tick(11_000);
    expect(await a.setup()).toBe("databases");
    tick(61_000);
    expect(await a.page()).toBe("-> /setup");
    // That page view found the shared copy out of date and dropped it: a cold instance agrees.
    await a.coldInstance();
    expect(await a.setup()).toBe("databases");
  });

  it("without any page meeting the stale id, the hourly refresh replaces the ready copy and Setup shows the repair", async () => {
    if (process.env.NOTION_TOKEN || process.env.VERCEL) return;
    const a = await app();
    expect(await a.setup()).toBe("ready");
    await a.notion.databases.update({ database_id: a.reg0.dbs.projects!.databaseId, in_trash: true });
    tick(2 * 3600_000);
    // The copy is past its revalidate time: served once more while the refresh runs in the background.
    expect(await a.setup()).toBe("ready");
    tick(61_000);
    expect(await a.setup()).toBe("databases");
    tick(24 * 3600_000);
    expect(await a.setup()).toBe("databases");
    await a.coldInstance();
    expect(await a.setup()).toBe("databases");
  });
});
