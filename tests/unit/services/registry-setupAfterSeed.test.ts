/**
 * UI-3 (status part): right after "Load the 64 milestones" finishes, Setup must say "ready" although Notion's query
 * does not show the new 'seed.appliedAt' row yet. The instance that wrote it reads it by its page id; the guard on
 * every other page (requireReadyStorage → admin.status()) then agrees.
 */
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { currentSetupStep } from "@/components/admin/setup-steps";
import { createRegistryHandle, createStorageAdmin } from "@/server/notion/registry";
import { getSetupStatus } from "@/server/queries/setup";
import { JOB_LOOKUP } from "@/server/services/jobs";
import { continueImport, startSeed } from "@/server/services/templateIo";
import { FAKE_OPTS } from "../notion/helpers";
import { driveJob, lagWorld } from "./_lag";

afterEach(() => {
  JOB_LOOKUP.sleep = undefined;
});

/** Same decision as requireReadyStorage (src/server/guards.ts). */
const passes = (s: { mode: string; schemaReady: boolean; seeded: boolean }) => s.mode !== "unconfigured" && s.schemaReady && s.seeded;

describe("Setup right after the seed finishes, while Notion's query lags (UI-3)", { timeout: 60_000 }, () => {
  for (const lag of [3_000, 5_000, 8_000]) {
    it(`query lag ${lag / 1000} s: "Check again" shows ready and pages open`, async () => {
      const w = await lagWorld({ queryLagMs: lag });
      JOB_LOOKUP.sleep = async (ms) => w.advance(ms);
      const admin = createStorageAdmin(w.notion, createRegistryHandle(w.notion, FAKE_OPTS), FAKE_OPTS);
      let markerAt = 0;
      let queriedAt = 0;
      w.beforeCall = (method, args) => {
        const seedRow = JSON.stringify(args).includes("seed.appliedAt");
        if (method === "pages.create" && seedRow) markerAt = w.now();
        if (method === "dataSources.query" && seedRow && markerAt && !queriedAt) queriedAt = w.now();
      };
      const opId = randomUUID();
      await startSeed(w.ctx(opId));
      await driveJob(w, () => continueImport(w.ctx(opId), opId));
      queriedAt = 0;

      // The browser: "The 64 milestones are loaded.", then checkAgain → checkSetupAction (resetCaches + status).
      w.advance(300);
      await admin.resetCaches();
      const status = await getSetupStatus(admin, w.repo);
      w.beforeCall = null;
      expect(queriedAt - markerAt).toBeLessThan(lag); // status() asked the query before it showed the marker
      expect(currentSetupStep(status)).toBe("ready");
      expect(status.openJobs).toEqual([]);
      // "Open Portfolio": the guard agrees without waiting for the query.
      expect(passes(await admin.status())).toBe(true);

      // Later checks still agree (and the query has caught up by then).
      w.advance(lag);
      await admin.resetCaches();
      expect(currentSetupStep(await getSetupStatus(admin, w.repo))).toBe("ready");
      expect(passes(await admin.status())).toBe(true);
    });
  }

  it("before the seed, Setup still shows step 4 (the repo finds no marker either)", async () => {
    const w = await lagWorld({ queryLagMs: 5_000 });
    const admin = createStorageAdmin(w.notion, createRegistryHandle(w.notion, FAKE_OPTS), FAKE_OPTS);
    const status = await getSetupStatus(admin, w.repo);
    expect(currentSetupStep(status)).toBe("seed");
    expect(passes(await admin.status())).toBe(false);
  });
});
