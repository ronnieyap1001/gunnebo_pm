import "server-only";
/**
 * Setup and Settings read models.
 */
import type { SeedNotice } from "@/server/notion/registry";
import type { Repo, SetupStatus, StorageAdmin } from "@/server/repo/types";
import { getAppSettings, type AppSettings } from "@/server/services/admin";
import { SETTINGS } from "@/server/services/context";
import { listOpenJobs, type JobSummary } from "@/server/services/jobs";

export interface SetupStatusDTO extends SetupStatus {
  /** Jobs left running (e.g. the seed import interrupted by closing the tab). Empty when storage is not ready. */
  openJobs: JobSummary[];
}

/** Storage status for /setup (and the redirect check on every screen). Never throws for a missing setup. */
export async function getSetupStatus(admin: StorageAdmin & Partial<SeedNotice>, repo?: Repo): Promise<SetupStatusDTO> {
  let status = await admin.status();
  // Right after the seed, Notion's query may not show its 'seed.appliedAt' row for a few seconds. The repo of the
  // instance that wrote it reads it by its page id: Setup says "ready" at once, and so does every page's check.
  if (repo && status.schemaReady && !status.seeded && (await hasSeedMarker(repo))) {
    status = { ...status, seeded: true };
    admin.noteSeeded?.();
  }
  let openJobs: JobSummary[] = [];
  if (repo && status.schemaReady) {
    try {
      openJobs = await listOpenJobs(repo);
    } catch {
      openJobs = [];
    }
  }
  return { ...status, openJobs };
}

async function hasSeedMarker(repo: Repo): Promise<boolean> {
  try {
    return (await repo.settings.get(SETTINGS.seedAppliedAt)) !== undefined;
  } catch {
    return false;
  }
}

export interface SettingsData extends AppSettings {
  /** Days since the last full backup (null = never). */
  daysSinceBackup: number | null;
}

export async function getSettingsData(repo: Repo, now: Date = new Date()): Promise<SettingsData> {
  const s = await getAppSettings(repo);
  const days = s.backupLastAt ? Math.floor((now.getTime() - Date.parse(s.backupLastAt)) / 86_400_000) : null;
  return { ...s, daysSinceBackup: days };
}
