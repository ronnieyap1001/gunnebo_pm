"use server";

import { updateTag } from "next/cache";
import { z } from "zod";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { runAction, runQuery } from "@/server/actions/run";
import { bumpEpoch } from "@/server/auth/epoch";
import { endSession } from "@/server/auth/session";
import { TAGS } from "@/server/queries";
import { getRepo, getStorageAdmin } from "@/server/repo";
import {
  exportBackupPage,
  listProjectIdsForRepair,
  recordBackup,
  repairMirrorsBatch,
  setDisplayName,
  setTimeZone,
  startOver,
  startResetTemplate,
  verifyHistoryPage,
  type VerifyHistoryResult,
} from "@/server/services";

const ALL_TAGS = [TAGS.library, TAGS.projectFields, TAGS.settings];
const text = (max: number) => z.string().max(max);
// Storage cursors can be long (the backup cursor carries the ids already read at the same timestamp).
const cursorSchema = z.string().max(1_500_000).nullable();

function refreshAllTags() {
  for (const tag of ALL_TAGS) updateTag(tag);
}

export async function saveDisplayNameAction(opId: string, name: string): Promise<ActionResult<{ name: string }>> {
  const parsed = text(200).safeParse(name);
  if (!parsed.success) return fail("Enter a name of at most 80 characters.", "VALIDATION");
  return runAction(
    opId,
    async (ctx) => {
      await setDisplayName(ctx, parsed.data);
      return { name: parsed.data.trim().replace(/\s+/g, " ") };
    },
    { tags: [TAGS.settings] },
  );
}

export async function saveTimeZoneAction(opId: string, timeZone: string): Promise<ActionResult<{ timeZone: string }>> {
  const parsed = text(100).safeParse(timeZone);
  if (!parsed.success) return fail("Enter a time zone such as Asia/Singapore.", "VALIDATION");
  return runAction(
    opId,
    async (ctx) => {
      await setTimeZone(ctx, parsed.data);
      return { timeZone: parsed.data.trim() };
    },
    { tags: [TAGS.settings] },
  );
}

// ---------------------------------------------------------------------------
// Backup (the browser pages through every database and builds one file)
// ---------------------------------------------------------------------------

export async function backupDatabasesAction(): Promise<ActionResult<string[]>> {
  return runQuery(async () => getStorageAdmin().databaseNames());
}

export async function backupPageAction(database: string, cursor: string | null): Promise<ActionResult<{ rows: unknown[]; nextCursor: string | null }>> {
  const db = text(100).safeParse(database);
  const cur = cursorSchema.safeParse(cursor);
  if (!db.success || !cur.success) return fail("The backup request was not valid. Start the backup again.", "VALIDATION");
  return runQuery(() => exportBackupPage(getStorageAdmin(), db.data, cur.data));
}

export async function recordBackupAction(opId: string): Promise<ActionResult<{ at: string }>> {
  return runAction(opId, async (ctx) => ({ at: await recordBackup(ctx) }), { tags: [TAGS.settings] });
}

// ---------------------------------------------------------------------------
// Maintenance
// ---------------------------------------------------------------------------

export async function verifyHistoryAction(opId: string, cursor: string | null): Promise<ActionResult<VerifyHistoryResult>> {
  const cur = cursorSchema.safeParse(cursor);
  if (!cur.success) return fail("The check was interrupted. Start it again.", "VALIDATION");
  return runAction(opId, (ctx) => verifyHistoryPage(ctx, cur.data, 100));
}

export async function repairListAction(): Promise<ActionResult<string[]>> {
  return runQuery(() => listProjectIdsForRepair(getRepo()));
}

export async function repairBatchAction(opId: string, projectIds: string[]): Promise<ActionResult<{ checked: number; repaired: string[] }>> {
  const ids = z.array(text(100)).max(5).safeParse(projectIds);
  if (!ids.success) return fail("Repair at most 5 projects at a time.", "VALIDATION");
  return runAction(opId, (ctx) => repairMirrorsBatch(ctx, ids.data));
}

/** "Reload from Notion": forget cached database ids and cached library / fields / settings. */
export async function reloadFromNotionAction(): Promise<ActionResult<null>> {
  return runQuery(async () => {
    await getStorageAdmin().resetCaches();
    refreshAllTags();
    return null;
  });
}

/** "Reset template to seed": a resumable import job (continue with continueImportAction from Setup). */
export async function startResetTemplateAction(opId: string): Promise<ActionResult<{ total: number }>> {
  return runAction(
    opId,
    async (ctx) => {
      const r = await startResetTemplate(ctx);
      return { total: r.total };
    },
    { tags: ALL_TAGS },
  );
}

/** "Start over": moves every app database to Notion's trash; Setup runs again afterwards. */
export async function startOverAction(confirmation: string): Promise<ActionResult<null>> {
  const parsed = text(20).safeParse(confirmation);
  if (!parsed.success || parsed.data !== "RESET") return fail("Type RESET to confirm.", "VALIDATION");
  return runQuery(async () => {
    await startOver(getStorageAdmin(), parsed.data);
    refreshAllTags();
    return null;
  });
}

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------

/** Invalidates every session (all browsers and devices), then ends this one. The browser goes to /login. */
export async function signOutEverywhereAction(): Promise<ActionResult<null>> {
  const r = await runQuery(async () => {
    await bumpEpoch();
    return null;
  });
  if (!r.ok) return r;
  await endSession();
  return ok(null);
}
