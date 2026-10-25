/**
 * Deployment review fixes: the preview/production page split also holds with NOTION_PARENT_PAGE_ID (DEPLOY-02), one
 * schema discovery shared by all server instances (DEPLOY-03), and Setup telling a rejected token or a busy Notion
 * apart from a missing page (DEPLOY-04).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { currentSetupStep, setupStepState } from "@/components/admin/setup-steps";
import { NotionBusyError } from "@/server/notion/errors";
import { setNotionForTesting, withConcurrencyGate } from "@/server/notion/client";
import { createFakeNotion } from "@/server/notion/fake";
import {
  createRegistryHandle,
  createStorageAdmin,
  discoverRegistry,
  discoverShareableRegistry,
  isSchemaReady,
  UnsharedRegistry,
} from "@/server/notion/registry";
import { FAKE_OPTS, runSetup, text } from "./helpers";

const page = (notion: ReturnType<typeof createFakeNotion>, title: string) =>
  notion.pages.create({ parent: { type: "workspace", workspace: true }, properties: { title: { title: text(title) } } });

describe("NOTION_PARENT_PAGE_ID respects the preview / production split (DEPLOY-02)", () => {
  const opts = { ...FAKE_OPTS, createParentIfMissing: false };

  it("a preview deployment refuses a page that is not 'Gunnebo PM (Preview)'", async () => {
    const notion = createFakeNotion();
    const real = await page(notion, "Gunnebo PM");
    const reg = await discoverRegistry(notion, { ...opts, parentTitle: "Gunnebo PM (Preview)", parentPageId: real.id, vercelEnv: "preview" });
    expect(reg.parent).toBeNull();
    expect(reg.problems[0]).toMatch(/points to the page "Gunnebo PM", but preview versions only use the page "Gunnebo PM \(Preview\)"/);
    expect(reg.problems[0]).toMatch(/for Production only/);
  });

  it("a preview deployment accepts its own page; development is not restricted", async () => {
    const notion = createFakeNotion();
    const test = await page(notion, "Gunnebo PM (Preview)");
    const reg = await discoverRegistry(notion, { ...opts, parentTitle: "Gunnebo PM (Preview)", parentPageId: test.id, vercelEnv: "preview" });
    expect(reg.parent?.id).toBe(test.id);
    const real = await page(notion, "Gunnebo PM");
    expect((await discoverRegistry(notion, { ...opts, parentPageId: real.id, vercelEnv: undefined })).parent?.id).toBe(real.id);
  });

  it("production refuses the preview page", async () => {
    const notion = createFakeNotion();
    const test = await page(notion, "Gunnebo PM (Preview)");
    const reg = await discoverRegistry(notion, { ...opts, parentPageId: test.id, vercelEnv: "production" });
    expect(reg.parent).toBeNull();
    expect(reg.problems[0]).toMatch(/test data for preview versions/);
  });

  it("'Several Notion pages…' tells production to set the variable for Production only", async () => {
    const notion = createFakeNotion();
    await page(notion, "Gunnebo PM");
    await page(notion, "Gunnebo PM");
    const prod = await discoverRegistry(notion, { ...opts, vercelEnv: "production" });
    expect(prod.problems[0]).toMatch(/Several Notion pages are called "Gunnebo PM".*for Production only \(untick Preview and Development\)/);
    await page(notion, "Gunnebo PM (Preview)");
    await page(notion, "Gunnebo PM (Preview)");
    const preview = await discoverRegistry(notion, { ...opts, parentTitle: "Gunnebo PM (Preview)", vercelEnv: "preview" });
    expect(preview.problems[0]).toMatch(/Several Notion pages are called "Gunnebo PM \(Preview\)"/);
    expect(preview.problems[0]).not.toMatch(/NOTION_PARENT_PAGE_ID/);
  });
});

describe("the schema registry is shared by all server instances (DEPLOY-03)", () => {
  it("only a ready registry is shareable", async () => {
    const notion = createFakeNotion();
    await expect(discoverShareableRegistry(notion, FAKE_OPTS)).rejects.toBeInstanceOf(UnsharedRegistry);
    await runSetup(notion);
    expect(isSchemaReady(await discoverShareableRegistry(notion, FAKE_OPTS))).toBe(true);
  });

  it("a handle uses the shared loader: no Notion calls for a cached registry, one direct discovery for an unshared one", async () => {
    const notion = createFakeNotion();
    await runSetup(notion);
    const shared = await discoverRegistry(notion, FAKE_OPTS);
    notion.fake.resetCalls();
    const cached = createRegistryHandle(notion, { ...FAKE_OPTS, loader: async () => shared });
    expect(isSchemaReady(await cached.load())).toBe(true);
    expect(notion.fake.callCount()).toBe(0);

    const fresh = createFakeNotion();
    let discoveries = 0;
    const unshared = createRegistryHandle(fresh, {
      ...FAKE_OPTS,
      loader: async () => {
        discoveries++;
        return discoverShareableRegistry(fresh, FAKE_OPTS);
      },
    });
    const reg = await unshared.load();
    expect(isSchemaReady(reg)).toBe(false);
    expect(discoveries).toBe(1);
    expect(fresh.fake.callCount("search")).toBe(1); // the loader's discovery is reused, not repeated
  });

  it("falls back to direct discovery when the cache is unavailable, but passes Notion errors on", async () => {
    const notion = createFakeNotion();
    await runSetup(notion);
    const broken = createRegistryHandle(notion, {
      ...FAKE_OPTS,
      loader: async () => {
        throw new Error("Invariant: incrementalCache missing");
      },
    });
    expect(isSchemaReady(await broken.load())).toBe(true);
    const busy = createRegistryHandle(notion, {
      ...FAKE_OPTS,
      loader: async () => {
        throw new NotionBusyError();
      },
    });
    await expect(busy.load()).rejects.toBeInstanceOf(NotionBusyError);
  });

  it("status() drops a shared registry that names databases which are gone (Start over elsewhere) and discovers again", async () => {
    const notion = createFakeNotion();
    await runSetup(notion);
    const stale = await discoverRegistry(notion, FAKE_OPTS);
    // Another instance ran Start over and Setup: new databases. The shared cache still holds the old registry.
    await createStorageAdmin(notion, createRegistryHandle(notion, FAKE_OPTS), FAKE_OPTS).trashAll();
    await runSetup(notion);
    let loads = 0;
    const handle = createRegistryHandle(notion, {
      ...FAKE_OPTS,
      loader: async () => {
        loads++;
        return stale;
      },
    });
    const s = await createStorageAdmin(notion, handle, FAKE_OPTS).status();
    expect(s.problems).toEqual([]);
    expect(s.schemaReady).toBe(true);
    expect(loads).toBe(1);
    expect((await handle.load()).dbs.settings?.dataSourceId).not.toBe(stale.dbs.settings?.dataSourceId);
  });

  it("with a shared loader the instance memo lasts a minute (a reset elsewhere reaches every instance)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const notion = createFakeNotion();
      await runSetup(notion);
      const shared = await discoverRegistry(notion, FAKE_OPTS);
      let loads = 0;
      const handle = createRegistryHandle(notion, {
        ...FAKE_OPTS,
        loader: async () => {
          loads++;
          return shared;
        },
      });
      await handle.load();
      await handle.load();
      expect(loads).toBe(1);
      vi.setSystemTime(Date.now() + 61_000);
      await handle.load();
      expect(loads).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("cached.ts plugs the shared registry into the app's repo (DEPLOY-03)", () => {
  const cacheCalls: { keyParts: string[]; options: { tags?: string[]; revalidate?: number } }[] = [];
  const revalidated: unknown[][] = [];

  beforeEach(() => {
    vi.resetModules();
    vi.doMock("next/cache", () => ({
      unstable_cache: (fn: (...a: unknown[]) => unknown, keyParts: string[], options: { tags?: string[]; revalidate?: number }) => {
        cacheCalls.push({ keyParts, options });
        return (...a: unknown[]) => fn(...a);
      },
      revalidateTag: (...a: unknown[]) => revalidated.push(a),
      updateTag: () => undefined,
    }));
    vi.doMock("next/server", () => ({ after: (fn: () => unknown) => void fn() }));
  });
  afterEach(async () => {
    vi.doUnmock("next/cache");
    vi.doUnmock("next/server");
    const repo = await import("@/server/repo");
    repo.setRegistryLoader(undefined);
    repo.resetRepoForTesting();
    setNotionForTesting(null);
  });

  it("registers an unstable_cache loader tagged 'schema' (1 h) and revalidates the tag on a reset", async () => {
    if (process.env.NOTION_TOKEN || process.env.VERCEL) return;
    const client = await import("@/server/notion/client");
    const notion = createFakeNotion();
    await runSetup(notion);
    client.setNotionForTesting(withConcurrencyGate(notion));
    const repo = await import("@/server/repo");
    repo.resetRepoForTesting();
    await import("@/server/queries/cached");
    const { TAGS } = await import("@/server/queries/tags");
    expect(TAGS.schema).toBe("schema");
    const schema = cacheCalls.find((c) => c.options.tags?.includes("schema"));
    expect(schema?.options.revalidate).toBe(3600);
    expect(schema?.keyParts).toContain("schema");

    notion.fake.resetCalls();
    const status = await repo.getStorageAdmin().status();
    expect(status.schemaReady).toBe(true);
    expect(notion.fake.callCount("search")).toBe(1); // discovered through the loader

    await repo.getStorageAdmin().resetCaches();
    expect(revalidated).toContainEqual(["schema", { expire: 0 }]);
    repo.resetRepoForTesting();
  });

  it("with local test data the cache key names the data file (another file's database ids are never reused)", async () => {
    if (process.env.NOTION_TOKEN || process.env.VERCEL) return;
    const before = process.env.FAKE_NOTION_FILE;
    process.env.FAKE_NOTION_FILE = "data/fake-other-screen.json";
    try {
      cacheCalls.length = 0;
      const client = await import("@/server/notion/client");
      client.setNotionForTesting(withConcurrencyGate(createFakeNotion()));
      await import("@/server/queries/cached");
      const schema = cacheCalls.find((c) => c.options.tags?.includes("schema"));
      expect(schema?.keyParts).toContain(client.fakeNotionFile());
      expect(client.fakeNotionFile()).toMatch(/fake-other-screen\.json$/);
    } finally {
      if (before === undefined) delete process.env.FAKE_NOTION_FILE;
      else process.env.FAKE_NOTION_FILE = before;
    }
  });
});

describe("Setup tells a rejected token and a busy Notion apart from a missing page (DEPLOY-04)", () => {
  async function adminWithFault(status: 401 | 429 | 503) {
    const notion = createFakeNotion();
    await runSetup(notion);
    const admin = createStorageAdmin(notion, createRegistryHandle(notion, FAKE_OPTS), FAKE_OPTS);
    notion.fake.injectFault({ status, method: "search" });
    return admin.status();
  }

  it("a rejected token is reported as tokenRejected and Setup shows step 1", async () => {
    const s = await adminWithFault(401);
    expect(s.errorKind).toBe("tokenRejected");
    expect(s.problems[0]).toMatch(/NOTION_TOKEN/);
    expect(currentSetupStep(s)).toBe("connect");
    expect(setupStepState("connect", currentSetupStep(s))).toBe("current");
  });

  it("a busy or unavailable Notion is reported as busy and Setup does not ask for a new page", async () => {
    for (const code of [429, 503] as const) {
      const s = await adminWithFault(code);
      expect(s.errorKind).toBe("busy");
      expect(currentSetupStep(s)).toBe("busy");
      expect(setupStepState("page", currentSetupStep(s))).toBe("todo");
      expect(setupStepState("connect", currentSetupStep(s))).toBe("done");
    }
  });

  it("without an error the steps are unchanged", async () => {
    const notion = createFakeNotion();
    const admin = createStorageAdmin(notion, createRegistryHandle(notion, { ...FAKE_OPTS, createParentIfMissing: false }), {
      ...FAKE_OPTS,
      createParentIfMissing: false,
    });
    const s = await admin.status();
    expect(s.errorKind).toBeUndefined();
    expect(currentSetupStep(s)).toBe("page");
    expect(currentSetupStep({ ...s, mode: "unconfigured" })).toBe("connect");
    const ready = { mode: "notion" as const, parentPage: { id: "p", title: "Gunnebo PM" }, schemaReady: true, seeded: true };
    expect(currentSetupStep(ready)).toBe("ready");
    expect(currentSetupStep({ ...ready, seeded: false })).toBe("seed");
    expect(setupStepState("databases", "seed")).toBe("done");
  });
});
