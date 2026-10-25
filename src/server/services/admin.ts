import "server-only";
/**
 * Settings and maintenance: time zone, display name, backup bookkeeping, "Verify history", "Repair mirrors" and
 * "Start over".
 */
import type { Iso } from "@/domain/types";
import type { Repo, StorageAdmin } from "@/server/repo/types";
import {
  appendHistory,
  AppError,
  DEFAULT_ACTOR,
  DEFAULT_TIME_ZONE,
  EV,
  isValidTimeZone,
  SETTINGS,
  summaryFor,
  type Ctx,
} from "./context";
import { historyHash } from "./historyHash";
import { readTemplateRevision } from "./library";
import { listProjectFields } from "./projectFields";
import { reconcileProject } from "./projects";

export interface AppSettings {
  timeZone: string;
  displayName: string;
  backupLastAt: Iso | null;
  seedAppliedAt: Iso | null;
  templateRevision: number;
}

export async function getAppSettings(repo: Repo): Promise<AppSettings> {
  const [all, revision] = await Promise.all([repo.settings.list(), readTemplateRevision(repo)]);
  const tz = all[SETTINGS.timeZone];
  const name = all[SETTINGS.displayName];
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  return {
    timeZone: isValidTimeZone(tz) ? tz : DEFAULT_TIME_ZONE,
    displayName: typeof name === "string" && name.trim() ? name.trim() : DEFAULT_ACTOR,
    backupLastAt: str(all[SETTINGS.backupLastAt]),
    seedAppliedAt: str(all[SETTINGS.seedAppliedAt]),
    templateRevision: revision,
  };
}

/** Sets the time zone that decides "today" (date colours flip at its midnight). */
export async function setTimeZone(ctx: Ctx, timeZone: string): Promise<void> {
  const tz = typeof timeZone === "string" ? timeZone.trim() : "";
  if (!isValidTimeZone(tz)) throw new AppError("VALIDATION", `"${tz}" is not a time zone this server knows, e.g. Asia/Singapore.`);
  const current = await ctx.repo.settings.get<string>(SETTINGS.timeZone);
  if (current === tz) return;
  // History → setting: a retry with the same opId after a crash between the two finishes the change with one row.
  await appendHistory(ctx, {
    type: EV.settingsUpdated,
    summary: summaryFor("Settings", `Time zone: ${current ?? DEFAULT_TIME_ZONE} → ${tz}`),
    oldDisplay: current ?? DEFAULT_TIME_ZONE,
    newDisplay: tz,
    data: { key: SETTINGS.timeZone, old: current ?? null, new: tz },
  });
  await ctx.repo.settings.set(SETTINGS.timeZone, tz);
}

/** The name shown as the author of changes and notes. */
export async function setDisplayName(ctx: Ctx, name: string): Promise<void> {
  const clean = typeof name === "string" ? name.trim().replace(/\s+/g, " ") : "";
  if (!clean) throw new AppError("VALIDATION", "Enter a name.");
  if (clean.length > 80) throw new AppError("VALIDATION", "The name is too long (maximum 80 characters).");
  const current = await ctx.repo.settings.get<string>(SETTINGS.displayName);
  if (current === clean) return;
  await appendHistory(ctx, {
    type: EV.settingsUpdated,
    summary: summaryFor("Settings", `Display name: ${current ?? DEFAULT_ACTOR} → ${clean}`),
    oldDisplay: current ?? DEFAULT_ACTOR,
    newDisplay: clean,
    data: { key: SETTINGS.displayName, old: current ?? null, new: clean },
  });
  await ctx.repo.settings.set(SETTINGS.displayName, clean);
}

/** Records that a full backup was downloaded (the sidebar warns after 7 days without one). */
export async function recordBackup(ctx: Ctx): Promise<Iso> {
  await ctx.repo.settings.set(SETTINGS.backupLastAt, ctx.now);
  return ctx.now;
}

/** One page of one database for the full backup (the browser pages through every database and builds one file). */
export function exportBackupPage(
  admin: StorageAdmin,
  database: string,
  cursor: string | null,
): Promise<{ rows: unknown[]; nextCursor: string | null }> {
  if (!admin.databaseNames().includes(database)) throw new AppError("VALIDATION", `Unknown database "${database}".`);
  return admin.exportPage(database, cursor);
}

export interface HistoryMismatch {
  id: string;
  seq: number;
  summary: string;
  occurredAt: Iso;
}

export interface VerifyHistoryResult {
  checked: number;
  mismatches: HistoryMismatch[];
  /** Rows without a stored hash (cannot be verified). */
  unhashed: number;
  nextCursor: string | null;
}

/**
 * Recomputes the hash of one page of History rows (newest first) and reports rows whose content no longer
 * matches. Tamper-evident, not tamper-proof.
 */
export async function verifyHistoryPage(ctx: Ctx, cursor: string | null, limit = 100): Promise<VerifyHistoryResult> {
  const page = await ctx.repo.history.listAll({ cursor, limit });
  const mismatches: HistoryMismatch[] = [];
  let unhashed = 0;
  for (const row of page.items) {
    if (!row.hash) {
      unhashed++;
      continue;
    }
    const { id: _id, recordedAt: _r, hash, ...content } = row;
    if (historyHash(content) !== hash) {
      mismatches.push({ id: row.id, seq: row.seq, summary: row.summary, occurredAt: row.occurredAt });
    }
  }
  return { checked: page.items.length, mismatches, unhashed, nextCursor: page.nextCursor };
}

/** Project ids to repair, in a stable order (the browser calls repairMirrorsBatch with slices of it). */
export async function listProjectIdsForRepair(repo: Repo): Promise<string[]> {
  const projects = await repo.projects.list({ includeArchived: true });
  return projects.filter((p) => p.setup === "READY").map((p) => p.id).sort();
}

/**
 * "Repair mirrors": reconciles each given project (at most 5 per call) and rewrites its Notion mirrors (Current,
 * Customer, Project type, Summary) whether or not the cells changed. `repaired` lists the projects whose cells or
 * progress were wrong.
 */
export async function repairMirrorsBatch(ctx: Ctx, projectIds: string[]): Promise<{ checked: number; repaired: string[] }> {
  const ids = [...new Set(projectIds)];
  if (ids.length > 5) throw new AppError("VALIDATION", "Repair at most 5 projects per call.");
  if (ids.length === 0) return { checked: 0, repaired: [] };
  const fields = await listProjectFields(ctx.repo, { includeArchived: true });
  const repaired: string[] = [];
  for (const id of ids) {
    const r = await reconcileProject(ctx, id, { rewriteMirrors: { fields } });
    if (r.changed) repaired.push(id);
  }
  return { checked: ids.length, repaired };
}

/**
 * "Start over" (the UI requires typing RESET and offers a backup first): moves every app database to Notion's
 * trash (recoverable for 30 days) and clears cached ids, so Setup runs again.
 */
export async function startOver(admin: StorageAdmin, confirmation: string): Promise<void> {
  if (confirmation !== "RESET") throw new AppError("VALIDATION", "Type RESET to confirm.");
  await admin.trashAll();
  await admin.resetCaches();
}
