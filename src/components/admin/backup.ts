"use client";

import { ok, type ActionResult } from "@/lib/action-result";
import type { JobProgress } from "@/lib/run-job";
import { backupDatabasesAction, backupPageAction } from "@/app/(app)/settings/actions";

export interface BackupFile {
  format: "gunnebo-pm.backup";
  version: 1;
  exportedAt: string;
  databases: Record<string, unknown[]>;
}

/**
 * The full backup as a resumable runJob step: the first call lists the databases, every later call reads one page
 * of one database. State only advances after a page arrived, so a retried step (network error, BUSY) re-reads the
 * same page and never skips or doubles rows.
 */
export function makeBackupJob() {
  let names: string[] | null = null;
  let index = 0;
  let cursor: string | null = null;
  let rowCount = 0;
  const databases: Record<string, unknown[]> = {};

  const step = async (): Promise<ActionResult<JobProgress>> => {
    if (!names) {
      const r = await backupDatabasesAction();
      if (!r.ok) return r;
      names = r.data;
      for (const n of names) databases[n] = [];
      return ok({ done: names.length === 0, message: `Reading ${names[0] ?? "Notion"}…`, fraction: 0 });
    }
    const name = names[index];
    const r = await backupPageAction(name, cursor);
    if (!r.ok) return r;
    databases[name].push(...r.data.rows);
    rowCount += r.data.rows.length;
    cursor = r.data.nextCursor;
    if (!cursor) index++;
    const done = index >= names.length;
    const fraction = Math.min(1, (index + (cursor ? 0.5 : 0)) / names.length);
    const message = done
      ? `Read ${rowCount.toLocaleString("en-GB")} rows. Preparing the file…`
      : `Reading ${names[index]} (${index + 1} of ${names.length}) · ${rowCount.toLocaleString("en-GB")} rows so far`;
    return ok({ done, message, fraction });
  };

  const file = (exportedAt: string): BackupFile => ({ format: "gunnebo-pm.backup", version: 1, exportedAt, databases });

  return { step, file, rowCount: () => rowCount };
}
