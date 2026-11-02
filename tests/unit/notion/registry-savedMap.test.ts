/**
 * CR-2: Notion being busy or silent while discovery reads the saved property map ('schema.registry' in Settings) is
 * "try again", never "not set up": status() reports errorKind 'busy' (the busy page, Setup's busy notice), nothing is
 * memoised, and the next call works. A map row that is really gone still reads as "not saved" (Setup saves it again).
 */
import { RequestTimeoutError } from "@notionhq/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { currentSetupStep } from "@/components/admin/setup-steps";
import type { NotionLike } from "@/server/notion/client";
import { createFakeNotion, type FakeMethod } from "@/server/notion/fake";
import {
  createRegistryHandle,
  createStorageAdmin,
  discoverRegistry,
  isSchemaReady,
  SETTINGS_SEED_KEY,
  upsertSettingRow,
} from "@/server/notion/registry";
import { FAKE_OPTS, runSetup } from "./helpers";

afterEach(() => vi.useRealTimers());

/** Same decision as requireReadyStorage (src/server/guards.ts). */
function guard(s: { mode: string; schemaReady: boolean; seeded: boolean; errorKind?: string }): string {
  if (s.mode !== "unconfigured" && s.schemaReady && s.seeded) return "ok";
  return s.errorKind === "busy" ? "busy page" : "-> /setup";
}

/** A set-up, seeded fake with the production wiring: the handle loads through a shared loader (a cache miss each time). */
async function world() {
  const notion = createFakeNotion();
  await runSetup(notion);
  const reg0 = await discoverRegistry(notion, FAKE_OPTS);
  await upsertSettingRow(notion, reg0.dbs.settings!, SETTINGS_SEED_KEY, "2026-10-25T00:00:00Z");
  expect(reg0.dbs.settings!.mapPageId).toBeTruthy(); // the map is read by id (pages.retrieve)
  let loads = 0;
  const handle = createRegistryHandle(notion, {
    ...FAKE_OPTS,
    loader: async () => {
      loads++;
      return discoverRegistry(notion, FAKE_OPTS);
    },
  });
  return { notion, reg0, admin: createStorageAdmin(notion, handle, FAKE_OPTS), loads: () => loads };
}

describe("a busy Notion while reading the saved property map (CR-2)", () => {
  for (const status of [429, 502, 503, 504] as const) {
    it(`a ${status} on the map read shows the busy page, and the next call works`, async () => {
      const { notion, admin } = await world();
      notion.fake.injectFault({ status, method: "pages.retrieve", count: 1 });
      const s = await admin.status();
      expect(s.errorKind).toBe("busy");
      expect(guard(s)).toBe("busy page");
      expect(currentSetupStep(s)).toBe("busy");
      // Nothing was memoised: Notion answers again, so does the app.
      const s2 = await admin.status();
      expect(guard(s2)).toBe("ok");
    });
  }

  it("a request timeout on the map read is busy too", async () => {
    const { notion, reg0 } = await world();
    let timeouts = 1;
    const slow: NotionLike = {
      ...notion,
      pages: {
        ...notion.pages,
        retrieve: async (args) => {
          if (args.page_id === reg0.dbs.settings!.mapPageId && timeouts-- > 0) throw new RequestTimeoutError();
          return notion.pages.retrieve(args);
        },
      },
    };
    const admin = createStorageAdmin(slow, createRegistryHandle(slow, FAKE_OPTS), FAKE_OPTS);
    const s = await admin.status();
    expect(s.errorKind).toBe("busy");
    expect(guard(s)).toBe("busy page");
    expect(guard(await admin.status())).toBe("ok");
  });

  it("a 504 on the map query (when the row id is unknown) is busy too", async () => {
    const { notion, reg0, admin } = await world();
    // Without the pointer in the Settings description the map row is found by a query.
    await notion.databases.update({ database_id: reg0.dbs.settings!.databaseId, description: [] });
    notion.fake.injectFault({ status: 504, method: "dataSources.query" as FakeMethod, count: 1 });
    const s = await admin.status();
    expect(s.errorKind).toBe("busy");
    expect(guard(s)).toBe("busy page");
  });

  it("a rejected token on the map read asks for the secret again", async () => {
    const { notion, admin } = await world();
    notion.fake.injectFault({ status: 401, method: "pages.retrieve", count: 1 });
    const s = await admin.status();
    expect(s.errorKind).toBe("tokenRejected");
    expect(currentSetupStep(s)).toBe("connect");
  });

  it("a map row moved to Notion's trash still reads as 'not saved': Setup step 3, checked again after 10 s", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { notion, reg0, admin, loads } = await world();
    await notion.pages.update({ page_id: reg0.dbs.settings!.mapPageId!, in_trash: true });
    const reg = await discoverRegistry(notion, FAKE_OPTS);
    expect(reg.saved).toBeNull();
    expect(isSchemaReady(reg)).toBe(false);
    const s = await admin.status();
    expect(s.errorKind).toBeUndefined();
    expect(currentSetupStep(s)).toBe("databases");
    // A registry that is not ready is checked again soon (not kept for the minute a ready one is).
    const before = loads();
    vi.setSystemTime(Date.now() + 11_000);
    await admin.status();
    expect(loads()).toBe(before + 1);
  });
});
