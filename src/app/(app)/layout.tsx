import { requireUser } from "@/server/auth/session";
import { getCachedAppSettings } from "@/server/queries";
import { AppShell } from "@/components/shell/app-shell";
import type { BackupStatus } from "@/components/shell/backup-reminder";

// Every signed-in page reads live data, so render per request.
export const dynamic = "force-dynamic";

const DAY_MS = 86_400_000;

/**
 * Backup reminder for the sidebar footer, from the cached settings (cheap). Null while the app is not set up yet
 * (Setup has its own guidance) or when the settings can't be read right now.
 */
async function readBackupStatus(): Promise<BackupStatus | null> {
  try {
    const s = await getCachedAppSettings();
    if (!s.seedAppliedAt) return null;
    if (!s.backupLastAt) return { lastAt: null, days: null };
    const days = Math.floor((Date.now() - Date.parse(s.backupLastAt)) / DAY_MS);
    return { lastAt: s.backupLastAt, days: Number.isFinite(days) ? Math.max(0, days) : null };
  } catch {
    return null;
  }
}

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  await requireUser();
  const backup = await readBackupStatus();
  return <AppShell backup={backup}>{children}</AppShell>;
}
