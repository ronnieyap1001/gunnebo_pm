import { afterEach, describe, expect, it } from "vitest";
import { createRealNotion, getNotion, setNotionForTesting, storageMode, withConcurrencyGate } from "@/server/notion/client";
import {
  BlockLimitError,
  NotConfiguredError,
  NotSharedError,
  NotionBusyError,
  NotionError,
  NotionUnavailableError,
  mapNotionError,
} from "@/server/notion/errors";
import { createFakeNotion } from "@/server/notion/fake";
import { createRegistryHandle } from "@/server/notion/registry";
import { createNotionRepo } from "@/server/repo/notionRepo";
import { FAKE_OPTS, runSetup, text } from "./helpers";

/** A fetch that always answers 429 with Retry-After: 0, counting calls. */
function rateLimitedFetch() {
  const calls: string[] = [];
  const fetch = async (url: string) => {
    calls.push(url);
    return {
      ok: false,
      status: 429,
      headers: new Headers({ "retry-after": "0", "content-type": "application/json" }),
      text: async () => JSON.stringify({ object: "error", status: 429, code: "rate_limited", message: "Rate limited" }),
    };
  };
  return { fetch, calls };
}

async function gatedSetup() {
  const fake = createFakeNotion();
  const notion = withConcurrencyGate(fake);
  await runSetup(fake);
  const repo = createNotionRepo(notion, createRegistryHandle(notion, FAKE_OPTS));
  await repo.settings.get("warm-up"); // registry memo loaded
  fake.fake.resetCalls();
  return { fake, notion, repo };
}

describe("rate limits and retries", () => {
  it("the real SDK client retries a 429 three times (no second loop), then it surfaces as NotionBusyError", async () => {
    const { fetch, calls } = rateLimitedFetch();
    const notion = withConcurrencyGate(createRealNotion({ auth: "secret_test", fetch, logLevel: undefined }));
    const err = await notion.pages.retrieve({ page_id: "11111111-1111-4111-8111-111111111111" }).catch((e: unknown) => e);
    expect(calls).toHaveLength(4); // 1 + maxRetries (3)
    const mapped = mapNotionError(err);
    expect(mapped).toBeInstanceOf(NotionBusyError);
    expect((mapped as NotionBusyError).retryAfterMs).toBe(0);
    expect((mapped as NotionBusyError).message).toMatch(/Notion is busy/);
  });

  it("an injected 429 from the fake (= after the SDK gave up) is not retried by the gate and becomes NotionBusyError", async () => {
    const { fake, repo } = await gatedSetup();
    fake.fake.injectFault({ status: 429, retryAfterSec: 30, method: "dataSources.query" });
    const err = await repo.settings.get("app.timezone").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotionBusyError);
    expect((err as NotionBusyError).retryAfterMs).toBe(30_000);
    expect(fake.fake.callCount("dataSources.query")).toBe(1);
    // Next call works again.
    expect(await repo.settings.get("app.timezone")).toBeUndefined();
  });

  it("the gate retries a 409 conflict once", async () => {
    const { fake, repo } = await gatedSetup();
    fake.fake.injectFault({ status: 409, method: "pages.create" });
    await repo.settings.set("a", 1);
    expect(await repo.settings.get("a")).toBe(1);
    fake.fake.injectFault({ status: 409, method: "pages.create", count: 2 });
    const err = await repo.settings.set("b", 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotionError);
    expect((err as NotionError).code).toBe("conflict_error");
  });

  it("a 503 after commit (without the committed id) surfaces as NotionUnavailableError while the row exists (callers must re-read)", async () => {
    const { fake, repo } = await gatedSetup();
    const before = fake.fake.pageCount();
    fake.fake.injectFault({ status: 503, afterCommit: true, method: "pages.create", reportCommittedId: false });
    const err = await repo.settings.set("c", 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotionUnavailableError);
    expect((err as NotionUnavailableError).mayHaveCommitted).toBe(true);
    expect(fake.fake.pageCount()).toBe(before + 1);
    expect(await repo.settings.get("c")).toBe(1);
  });

  it("limits in-flight requests to 3 per instance", async () => {
    const fake = createFakeNotion({ latencyMs: 15 });
    const notion = withConcurrencyGate(fake);
    const root = await notion.pages.create({ parent: { type: "workspace", workspace: true }, properties: { title: { title: text("R") } } });
    fake.fake.resetCalls();
    await Promise.all(Array.from({ length: 12 }, () => notion.pages.retrieve({ page_id: root.id })));
    expect(fake.fake.maxInFlight).toBe(3);
    fake.fake.resetCalls();
    await Promise.all(Array.from({ length: 12 }, () => fake.pages.retrieve({ page_id: root.id })));
    expect(fake.fake.maxInFlight).toBeGreaterThan(3); // ungated
  });
});

describe("plain-English error mapping", () => {
  it("maps the block limit, missing access, bad token and unknown ids", async () => {
    const { fake, repo } = await gatedSetup();
    fake.fake.injectFault({ status: 403, additional_data: { block_limit: "block_creation" } });
    const block = await repo.settings.set("x", 1).catch((e: unknown) => e);
    expect(block).toBeInstanceOf(BlockLimitError);
    expect((block as Error).message).toMatch(/block limit/);

    fake.fake.injectFault({ status: 403 });
    expect(await repo.settings.get("x").catch((e: unknown) => e)).toBeInstanceOf(NotSharedError);

    fake.fake.injectFault({ status: 401 });
    const auth = await repo.settings.get("x").catch((e: unknown) => e);
    expect(auth).toBeInstanceOf(NotConfiguredError);
    expect((auth as Error).message).toMatch(/NOTION_TOKEN/);

    // Messages never echo request bodies; Notion's own text is kept in `detail` for logs.
    fake.fake.injectFault({ status: 500 });
    const e500 = (await repo.settings.set("secret-value", "do-not-echo").catch((e: unknown) => e)) as NotionError;
    expect(e500).toBeInstanceOf(NotionUnavailableError);
    expect(e500.message).not.toMatch(/do-not-echo/);
  });

  it("a busy Notion during discovery is reported as busy and not cached", async () => {
    const fake = createFakeNotion();
    await runSetup(fake);
    const handle = createRegistryHandle(fake, FAKE_OPTS);
    const repo = createNotionRepo(fake, handle);
    fake.fake.injectFault({ status: 429, method: "blocks.children.list" });
    expect(await repo.settings.get("x").catch((e: unknown) => e)).toBeInstanceOf(NotionBusyError);
    expect(await repo.settings.get("x")).toBeUndefined(); // the next call rediscovers
    const { createStorageAdmin } = await import("@/server/notion/registry");
    const admin = createStorageAdmin(fake, createRegistryHandle(fake, FAKE_OPTS), FAKE_OPTS);
    fake.fake.injectFault({ status: 503, method: "blocks.children.list" });
    const s = await admin.status();
    expect(s.schemaReady).toBe(false);
    expect(s.problems[0]).toMatch(/did not respond/);
  });

  it("leaves non-Notion errors alone", () => {
    const bug = new RangeError("bug");
    expect(mapNotionError(bug)).toBe(bug);
  });
});

describe("mode selection", () => {
  afterEach(() => setNotionForTesting(null));

  it("uses the fake only off Vercel without a token", () => {
    expect(storageMode({ NOTION_TOKEN: "secret_x" })).toBe("notion");
    expect(storageMode({ NOTION_TOKEN: "secret_x", VERCEL: "1" })).toBe("notion");
    expect(storageMode({})).toBe("fake");
    expect(storageMode({ VERCEL: "1" })).toBe("unconfigured");
  });

  it("getNotion refuses to run on Vercel without a token", () => {
    const saved = { VERCEL: process.env.VERCEL, NOTION_TOKEN: process.env.NOTION_TOKEN };
    try {
      process.env.VERCEL = "1";
      delete process.env.NOTION_TOKEN;
      setNotionForTesting(null);
      expect(() => getNotion()).toThrow(NotConfiguredError);
    } finally {
      if (saved.VERCEL === undefined) delete process.env.VERCEL;
      else process.env.VERCEL = saved.VERCEL;
      if (saved.NOTION_TOKEN !== undefined) process.env.NOTION_TOKEN = saved.NOTION_TOKEN;
    }
  });

  it("getStorageAdmin and getRepo work end-to-end on the process-wide fake", async () => {
    if (process.env.NOTION_TOKEN || process.env.VERCEL) return;
    const { getRepo, getStorageAdmin, resetRepoForTesting } = await import("@/server/repo");
    setNotionForTesting(withConcurrencyGate(createFakeNotion()));
    resetRepoForTesting();
    const admin = getStorageAdmin();
    expect((await admin.status()).schemaReady).toBe(false);
    await expect(getRepo().settings.get("x")).rejects.toThrow(/setup has not finished/i);
    for (let i = 0; i < 30; i++) if ((await admin.runSchemaStep()).done) break;
    expect((await admin.status()).schemaReady).toBe(true);
    await getRepo().settings.set("app.displayName", "Ronnie");
    expect(await getRepo().settings.get("app.displayName")).toBe("Ronnie");
    resetRepoForTesting();
  });

  it("getNotion gives an in-memory fake with FAKE_NOTION_FILE=:memory:", async () => {
    const saved = process.env.FAKE_NOTION_FILE;
    try {
      process.env.FAKE_NOTION_FILE = ":memory:";
      delete process.env.VERCEL;
      setNotionForTesting(null);
      if (process.env.NOTION_TOKEN) return; // a developer machine with a real token: nothing to check here
      const n = getNotion();
      expect(getNotion()).toBe(n);
      const p = await n.pages.create({ parent: { type: "workspace", workspace: true }, properties: { title: { title: text("M") } } });
      expect(p.id).toBeTruthy();
    } finally {
      if (saved === undefined) delete process.env.FAKE_NOTION_FILE;
      else process.env.FAKE_NOTION_FILE = saved;
    }
  });
});
