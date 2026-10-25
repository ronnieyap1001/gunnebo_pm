import "server-only";
/**
 * Setup and Settings read models.
 */
import type { Repo, SetupStatus, StorageAdmin } from "@/server/repo/types";
import { getAppSettings, type AppSettings } from "@/server/services/admin";
import { listOpenJobs, type JobSummary } from "@/server/services/jobs";

export interface SetupStatusDTO extends SetupStatus {
  /** Jobs left running (e.g. the seed import interrupted by closing the tab). Empty when storage is not ready. */
  openJobs: JobSummary[];
}

/** Storage status for /setup (and the redirect check on every screen). Never throws for a missing setup. */
export async function getSetupStatus(admin: StorageAdmin, repo?: Repo): Promise<SetupStatusDTO> {
  const status = await admin.status();
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

export interface SettingsData extends AppSettings {
  /** Days since the last full backup (null = never). */
  daysSinceBackup: number | null;
}

export async function getSettingsData(repo: Repo, now: Date = new Date()): Promise<SettingsData> {
  const s = await getAppSettings(repo);
  const days = s.backupLastAt ? Math.floor((now.getTime() - Date.parse(s.backupLastAt)) / 86_400_000) : null;
  return { ...s, daysSinceBackup: days };
}
