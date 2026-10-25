/**
 * Session token signing and verification. Used by src/proxy.ts and by server code, so it must not import
 * 'server-only' or next/headers. Node runtime only (Next 16 Proxy runs on Node by default).
 *
 * Token = base64url(JSON payload) + "." + base64url(HMAC-SHA256(key, payloadPart)).
 * Key   = HKDF-SHA256(ikm = SESSION_SECRET || NOTION_TOKEN, salt = sha256(APP_PASSWORD), info = 'gpm-session-v1:<VERCEL_ENV>').
 * A leaked cookie therefore cannot be used to guess the password offline, and changing the password or the Notion
 * secret signs everyone out (after a redeploy).
 */
import { createHash, createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

export const MIN_PASSWORD_LENGTH = 16;
/** Absolute lifetime of a session. */
export const SESSION_MAX_AGE_S = 30 * 24 * 3600;
/** A session not used for this long expires. */
export const SESSION_IDLE_S = 7 * 24 * 3600;
/** Refresh the cookie's idle timestamp at most once per day. */
export const SESSION_REFRESH_S = 24 * 3600;

type Env = Record<string, string | undefined>;

export function sessionCookieName(env: Env = process.env): string {
  // __Host- cookies require Secure, which browsers refuse on plain http://localhost in some cases.
  return env.NODE_ENV === "production" ? "__Host-gpm_session" : "gpm_session";
}

export function sessionCookieOptions(env: Env = process.env) {
  return {
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: SESSION_MAX_AGE_S,
  };
}

export type AuthConfig = { ok: true; key: Buffer } | { ok: false; problem: string };

export function authConfig(env: Env = process.env): AuthConfig {
  const password = env.APP_PASSWORD ?? "";
  if (!password) {
    return { ok: false, problem: "APP_PASSWORD is not set." };
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, problem: `APP_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters long.` };
  }
  const ikm = env.SESSION_SECRET || env.NOTION_TOKEN || (env.VERCEL ? "" : "local-development-only");
  if (!ikm) {
    return { ok: false, problem: "NOTION_TOKEN (or SESSION_SECRET) is not set." };
  }
  const salt = createHash("sha256").update(password, "utf8").digest();
  const info = `gpm-session-v1:${env.VERCEL_ENV ?? "development"}`;
  const key = Buffer.from(hkdfSync("sha256", ikm, salt, info, 32));
  return { ok: true, key };
}

export interface SessionPayload {
  v: 1;
  /** Issued at (seconds). */
  iat: number;
  /** Absolute expiry (seconds). */
  exp: number;
  /** Last time the session was seen (seconds), for the idle limit. */
  seen: number;
  /** Must match Settings 'auth.epoch'; bumping it signs everyone out. */
  epoch: number;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function mac(key: Buffer, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

export function newSessionPayload(nowS: number, epoch: number): SessionPayload {
  return { v: 1, iat: nowS, exp: nowS + SESSION_MAX_AGE_S, seen: nowS, epoch };
}

export function signSession(key: Buffer, payload: SessionPayload): string {
  const body = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  return `${body}.${b64url(mac(key, body))}`;
}

export function verifySession(key: Buffer, token: string | undefined | null, nowS: number): SessionPayload | null {
  if (!token || token.length > 2048) return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot !== token.lastIndexOf(".")) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  let given: Buffer;
  try {
    given = Buffer.from(sig, "base64url");
  } catch {
    return null;
  }
  const expected = mac(key, body);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let payload: SessionPayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as SessionPayload;
  } catch {
    return null;
  }
  if (
    !payload ||
    payload.v !== 1 ||
    typeof payload.exp !== "number" ||
    typeof payload.seen !== "number" ||
    typeof payload.iat !== "number" ||
    typeof payload.epoch !== "number"
  ) {
    return null;
  }
  if (nowS >= payload.exp) return null;
  if (nowS - payload.seen > SESSION_IDLE_S) return null;
  if (payload.iat > nowS + 300) return null; // issued in the future: reject
  return payload;
}

/** Constant-time password check. Hashing first gives equal-length buffers. */
export function checkPassword(input: string, env: Env = process.env): boolean {
  const expected = env.APP_PASSWORD ?? "";
  if (!expected || expected.length < MIN_PASSWORD_LENGTH) return false;
  const a = createHash("sha256").update(input, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

/** Only allow same-site relative paths as login redirect targets. */
export function safeNextPath(next: string | null | undefined): string {
  if (!next || typeof next !== "string") return "/portfolio";
  if (!next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return "/portfolio";
  if (next.startsWith("/login")) return "/portfolio";
  return next;
}
