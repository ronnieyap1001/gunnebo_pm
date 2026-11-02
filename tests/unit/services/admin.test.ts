import { describe, expect, it } from "vitest";
import { makeCtx, appendHistory, SETTINGS, EV } from "@/server/services/context";
import {
  getAppSettings,
  listProjectIdsForRepair,
  recordBackup,
  repairMirrorsBatch,
  setDisplayName,
  setTimeZone,
  startOver,
  verifyHistoryPage,
} from "@/server/services/admin";
import { getJobStatus, listOpenJobs } from "@/server/services/jobs";
import { startCreateProject } from "@/server/services/projects";
import type { StorageAdmin } from "@/server/repo/types";
import { createProject, expectAppError, NOW, seedLibrary, stepByKey, world } from "./_helpers";

describe("context", () => {
  it("makeCtx computes today in the configured time zone from now", () => {
    const w = world();
    const late = makeCtx(w.repo, { now: "2026-10-25T17:30:00.000Z", timeZone: "Asia/Singapore" });
    expect(late.day).toEqual({ today: "2026-10-26", timeZone: "Asia/Singapore" });
    const utc = makeCtx(w.repo, { now: "2026-10-25T17:30:00.000Z", timeZone: "UTC" });
    expect(utc.day.today).toBe("2026-10-25");
    const fallback = makeCtx(w.repo, { now: NOW, timeZone: "Mars/Olympus" });
    expect(fallback.day.timeZone).toBe("Asia/Singapore");
    expect(fallback.actor).toBe("Me");
    expect(fallback.source).toBe("MANUAL");
    expect(fallback.opId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("appendHistory writes one row per opId", async () => {
    const w = world();
    const ctx = w.ctx();
    const a = await appendHistory(ctx, { type: EV.settingsUpdated, summary: "x" });
    const b = await appendHistory(ctx, { type: EV.settingsUpdated, summary: "y" });
    expect(a).toBeTruthy();
    expect(b).toBeNull();
    expect((await w.repo.history.listAll()).items).toHaveLength(1);
    expect(a).toMatchObject({ correlationId: ctx.opId, occurredAt: NOW, actor: "Me", source: "MANUAL" });
  });
});

describe("settings", () => {
  it("time zone and display name are validated, stored and logged", async () => {
    const w = world();
    expect(await getAppSettings(w.repo)).toMatchObject({ timeZone: "Asia/Singapore", displayName: "Me", backupLastAt: null });
    await setTimeZone(w.ctx(), "Europe/London");
    await expectAppError(setTimeZone(w.ctx(), "Nowhere/City"), "VALIDATION");
    await setDisplayName(w.ctx(), "  Ronnie   Yap ");
    await recordBackup(w.ctx());
    expect(await getAppSettings(w.repo)).toMatchObject({ timeZone: "Europe/London", displayName: "Ronnie Yap", backupLastAt: NOW });
    expect(await w.repo.settings.get(SETTINGS.timeZone)).toBe("Europe/London");
    expect((await w.repo.history.listAll({ type: EV.settingsUpdated })).items).toHaveLength(2);
  });
});

describe("verify history", () => {
  it("recomputes hashes and reports edited rows", async () => {
    const w = world();
    await seedLibrary(w);
    const id = await createProject(w);
    const bom = await stepByKey(w, id, "bom");
    await appendHistory(w.ctx(), { type: EV.noteAdded, summary: "C0822 · Note", projectId: id, stepId: bom.id, data: { a: 1 } });
    const clean = await verifyHistoryPage(w.ctx(), null);
    expect(clean.mismatches).toEqual([]);
    expect(clean.checked).toBeGreaterThan(1);

    // Someone edits a row in Notion.
    const row = w.repo.store.history.find((e) => e.type === EV.noteAdded)!;
    row.summary = "C0822 · Note (edited)";
    const dirty = await verifyHistoryPage(w.ctx(), null);
    expect(dirty.mismatches.map((m) => m.id)).toEqual([row.id]);

    // Paging.
    const p1 = await verifyHistoryPage(w.ctx(), null, 1);
    expect(p1.checked).toBe(1);
    expect(p1.nextCursor).toBeTruthy();
  });
});

describe("repair mirrors and jobs", () => {
  it("reconciles projects in small batches", async () => {
    const w = world();
    await seedLibrary(w);
    const id = await createProject(w);
    const bom = await stepByKey(w, id, "bom");
    await w.repo.steps.update(bom.id, { notApplicable: true });
    const ids = await listProjectIdsForRepair(w.repo);
    expect(ids).toEqual([id]);
    expect(await repairMirrorsBatch(w.ctx(), ids)).toEqual({ checked: 1, repaired: [id] });
    expect(await repairMirrorsBatch(w.ctx(), ids)).toEqual({ checked: 1, repaired: [] });
    await expectAppError(repairMirrorsBatch(w.ctx(), ["1", "2", "3", "4", "5", "6"]), "VALIDATION");
  });

  it("lists running jobs for resume and reports their status", async () => {
    const w = world();
    await seedLibrary(w);
    const ctx = w.ctx();
    await startCreateProject(ctx, { code: "C1", name: "x" });
    const open = await listOpenJobs(w.repo);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ opId: ctx.opId, kind: "createProject", status: "running", total: 64, doneCount: 0 });
    expect(await getJobStatus(w.repo, ctx.opId)).toMatchObject({ kind: "createProject" });
    expect(await getJobStatus(w.repo, "nope")).toBeNull();
  });
});

describe("start over", () => {
  it("requires RESET and trashes everything", async () => {
    const calls: string[] = [];
    const admin = {
      trashAll: async () => void calls.push("trash"),
      resetCaches: async () => void calls.push("reset"),
    } as unknown as StorageAdmin;
    await expectAppError(startOver(admin, "reset"), "VALIDATION");
    expect(calls).toEqual([]);
    await startOver(admin, "RESET");
    expect(calls).toEqual(["trash", "reset"]);
  });
});
