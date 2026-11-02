import "server-only";
import { getDay, getSetupStatus, type SetupStatusDTO } from "@/server/queries";
import { getRepo, getStorageAdmin } from "@/server/repo";

/**
 * The project each unfinished project task belongs to ("C0822 Heathrow T5 eGates"), keyed by the task's opId, for the
 * "Unfinished tasks" list. Best effort: a project that can't be read keeps the plain label.
 */
export async function describeOpenJobs(status: SetupStatusDTO): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const withProject = status.openJobs.filter((j) => j.projectId).slice(0, 10);
  await Promise.all(
    withProject.map(async (j) => {
      try {
        const p = await getRepo().projects.get(j.projectId!);
        if (p) out[j.opId] = `${p.code} ${p.name}`;
      } catch {
        // keep the plain label
      }
    }),
  );
  return out;
}

/** The app time zone, or Singapore while the settings can't be read (before setup). */
export async function timeZoneOrDefault(): Promise<string> {
  try {
    return (await getDay()).timeZone;
  } catch {
    return "Asia/Singapore";
  }
}

/**
 * Setup status that never throws. `getSetupStatus()` builds the repo eagerly, which throws while NOTION_TOKEN is
 * missing on Vercel; the storage admin alone still reports that state (and every other) in plain words.
 */
export async function readSetupStatus(): Promise<SetupStatusDTO> {
  try {
    return await getSetupStatus();
  } catch {
    try {
      const status = await getStorageAdmin().status();
      return { ...status, openJobs: [] };
    } catch {
      return {
        mode: "notion",
        problems: ["The app could not read its setup status from Notion. Wait a moment and click Check again."],
        databases: [],
        schemaReady: false,
        seeded: false,
        errorKind: "busy",
        openJobs: [],
      };
    }
  }
}
