import "server-only";
import { getRepo } from "@/server/repo";

/**
 * Settings 'auth.epoch' (a number). Sessions carry the epoch they were issued under; bumping it
 * ("Sign out everywhere") invalidates every session. Cached per server instance for 60 seconds.
 */
const TTL_MS = 60_000;
let cached: { value: number; at: number } | null = null;

export async function currentEpoch(): Promise<number> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.value;
  let value = 0;
  try {
    const stored = await getRepo().settings.get<number>("auth.epoch");
    value = typeof stored === "number" ? stored : 0;
  } catch {
    // Storage not configured or not set up yet: nothing to compare against.
    value = 0;
  }
  cached = { value, at: Date.now() };
  return value;
}

export async function bumpEpoch(): Promise<number> {
  const next = (await currentEpoch()) + 1;
  await getRepo().settings.set("auth.epoch", next);
  cached = { value: next, at: Date.now() };
  return next;
}
