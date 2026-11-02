import "server-only";
import { getRepo } from "@/server/repo";

/**
 * Settings 'auth.epoch' (a number). Sessions carry the epoch they were issued under; bumping it
 * ("Sign out everywhere") invalidates every session. Cached per server instance for 60 seconds.
 *
 * When Notion can't be read (not set up yet, busy, briefly unreachable) the epoch is *unknown* (null) rather than 0:
 * sessions are then accepted on their signature alone, instead of signing everyone out because of a Notion hiccup.
 */
const TTL_MS = 60_000;
const UNKNOWN_TTL_MS = 5_000;
let cached: { value: number | null; at: number } | null = null;

export async function currentEpoch(): Promise<number | null> {
  const ttl = cached?.value === null ? UNKNOWN_TTL_MS : TTL_MS;
  if (cached && Date.now() - cached.at < ttl) return cached.value;
  let value: number | null;
  try {
    const stored = await getRepo().settings.get<number>("auth.epoch");
    value = typeof stored === "number" ? stored : 0;
  } catch {
    // Keep the last known value if there is one; otherwise unknown.
    value = cached?.value ?? null;
  }
  cached = { value, at: Date.now() };
  return value;
}

export async function bumpEpoch(): Promise<number> {
  cached = null;
  const current = await currentEpoch();
  if (current === null) throw new Error("Could not read the sign-in settings from Notion. Try again in a moment.");
  const next = current + 1;
  await getRepo().settings.set("auth.epoch", next);
  cached = { value: next, at: Date.now() };
  return next;
}

/** Forget the cached epoch (e.g. after "Start over" wiped the settings). */
export function resetEpochCache(): void {
  cached = null;
}
