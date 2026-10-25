import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  authConfig,
  newSessionPayload,
  sessionCookieName,
  sessionCookieOptions,
  signSession,
  verifySession,
  type SessionPayload,
} from "./token";
import { currentEpoch } from "./epoch";

export interface CurrentUser {
  /** Display name for history rows. Single user until Microsoft sign-in arrives in Phase 2. */
  name: string;
  session: SessionPayload;
}

export async function readSession(): Promise<SessionPayload | null> {
  const cfg = authConfig();
  if (!cfg.ok) return null;
  const jar = await cookies();
  const session = verifySession(cfg.key, jar.get(sessionCookieName())?.value, Math.floor(Date.now() / 1000));
  if (!session) return null;
  const epoch = await currentEpoch();
  // Unknown epoch (Notion unreadable): accept the signed session rather than signing everyone out.
  if (epoch !== null && session.epoch !== epoch) return null;
  return session;
}

/** Call at the start of every Server Action, route handler and protected page. */
export async function requireUser(): Promise<CurrentUser> {
  const session = await readSession();
  if (!session) redirect("/login");
  return { name: process.env.APP_USER_NAME || "Me", session };
}

/** For route handlers: returns null instead of redirecting. */
export async function userOrNull(): Promise<CurrentUser | null> {
  const session = await readSession();
  return session ? { name: process.env.APP_USER_NAME || "Me", session } : null;
}

export async function startSession(): Promise<void> {
  const cfg = authConfig();
  if (!cfg.ok) throw new Error(cfg.problem);
  const epoch = (await currentEpoch()) ?? 0;
  const jar = await cookies();
  jar.set(sessionCookieName(), signSession(cfg.key, newSessionPayload(Math.floor(Date.now() / 1000), epoch)), sessionCookieOptions());
}

export async function endSession(): Promise<void> {
  const jar = await cookies();
  jar.delete(sessionCookieName());
}
