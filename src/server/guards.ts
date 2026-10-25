import "server-only";
import { redirect } from "next/navigation";
import { getStorageAdmin } from "@/server/repo";

/**
 * Pages that need the Notion databases call this first. Sends the user to /setup until the databases exist and the
 * 64 milestones are loaded. Cheap: discovery and the seed flag are cached per instance.
 */
export async function requireReadyStorage(): Promise<void> {
  let ready = false;
  try {
    const status = await getStorageAdmin().status();
    ready = status.mode !== "unconfigured" && status.schemaReady && status.seeded;
  } catch {
    ready = false;
  }
  if (!ready) redirect("/setup");
}
