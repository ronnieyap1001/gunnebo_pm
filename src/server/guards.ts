import "server-only";
import { redirect } from "next/navigation";
import { requireUser } from "@/server/auth/session";
import { getStorageAdmin } from "@/server/repo";

/** Thrown when Notion is busy or unreachable: the page shows "try again" instead of sending people to Setup. */
export class StorageBusyError extends Error {
  constructor() {
    super("Notion is busy or can't be reached right now. Wait a few seconds and reload the page.");
    this.name = "StorageBusyError";
  }
}

/**
 * Pages that need the Notion databases call this first. Checks the sign-in (layouts and pages render at the same
 * time, so the layout's check alone does not stop a page from reading data), then sends the user to /setup until the
 * databases exist and the 64 milestones are loaded. Cheap: the sign-in check is cached per request, discovery and the
 * seed flag per instance.
 */
export async function requireReadyStorage(): Promise<void> {
  await requireUser();
  let ready = false;
  let busy = false;
  try {
    const status = await getStorageAdmin().status();
    ready = status.mode !== "unconfigured" && status.schemaReady && status.seeded;
    busy = !ready && (status as { errorKind?: string }).errorKind === "busy";
  } catch {
    ready = false;
  }
  if (busy) throw new StorageBusyError();
  if (!ready) redirect("/setup");
}
