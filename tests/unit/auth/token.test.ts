import { describe, expect, it } from "vitest";
import {
  authConfig,
  checkPassword,
  newSessionPayload,
  safeNextPath,
  SESSION_IDLE_S,
  SESSION_MAX_AGE_S,
  signSession,
  verifySession,
} from "@/server/auth/token";

const env = {
  APP_PASSWORD: "correct horse battery staple",
  NOTION_TOKEN: "ntn_test_secret_value_1234567890",
  VERCEL_ENV: "production",
  NODE_ENV: "test",
};

function key(e: Record<string, string | undefined> = env): Buffer {
  const cfg = authConfig(e);
  if (!cfg.ok) throw new Error(cfg.problem);
  return cfg.key;
}

describe("authConfig", () => {
  it("requires a password", () => {
    expect(authConfig({ ...env, APP_PASSWORD: "" })).toEqual({ ok: false, problem: "APP_PASSWORD is not set." });
  });
  it("requires at least 16 characters", () => {
    const cfg = authConfig({ ...env, APP_PASSWORD: "short password" });
    expect(cfg.ok).toBe(false);
  });
  it("requires a secret on Vercel", () => {
    const cfg = authConfig({ APP_PASSWORD: env.APP_PASSWORD, VERCEL: "1" });
    expect(cfg.ok).toBe(false);
  });
  it("allows a development secret locally", () => {
    expect(authConfig({ APP_PASSWORD: env.APP_PASSWORD }).ok).toBe(true);
  });
  it("derives different keys per environment, password and secret", () => {
    const base = key();
    expect(key({ ...env, VERCEL_ENV: "preview" }).equals(base)).toBe(false);
    expect(key({ ...env, APP_PASSWORD: "another long password here" }).equals(base)).toBe(false);
    expect(key({ ...env, NOTION_TOKEN: "ntn_other_secret_value_000000000" }).equals(base)).toBe(false);
    expect(key({ ...env, SESSION_SECRET: "explicit-session-secret" }).equals(base)).toBe(false);
  });
});

describe("session tokens", () => {
  const now = 1_800_000_000;

  it("round-trips", () => {
    const k = key();
    const token = signSession(k, newSessionPayload(now, 3));
    const payload = verifySession(k, token, now + 10);
    expect(payload?.epoch).toBe(3);
  });

  it("rejects tampered payloads and signatures", () => {
    const k = key();
    const token = signSession(k, newSessionPayload(now, 0));
    const [body, sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ ...newSessionPayload(now, 0), exp: now + 10 ** 9 })).toString("base64url");
    expect(verifySession(k, `${forged}.${sig}`, now)).toBeNull();
    expect(verifySession(k, `${body}.${sig.slice(0, -2)}AA`, now)).toBeNull();
    expect(verifySession(k, `${body}`, now)).toBeNull();
    expect(verifySession(k, "", now)).toBeNull();
    expect(verifySession(k, "a.b.c", now)).toBeNull();
  });

  it("rejects a token signed with another key", () => {
    const token = signSession(key(), newSessionPayload(now, 0));
    expect(verifySession(key({ ...env, VERCEL_ENV: "preview" }), token, now)).toBeNull();
  });

  it("expires after the absolute lifetime", () => {
    const k = key();
    const p = { ...newSessionPayload(now, 0), seen: now + SESSION_MAX_AGE_S - 5 };
    const token = signSession(k, p);
    expect(verifySession(k, token, now + SESSION_MAX_AGE_S - 1)).not.toBeNull();
    expect(verifySession(k, token, now + SESSION_MAX_AGE_S)).toBeNull();
  });

  it("expires after the idle limit", () => {
    const k = key();
    const token = signSession(k, newSessionPayload(now, 0));
    expect(verifySession(k, token, now + SESSION_IDLE_S)).not.toBeNull();
    expect(verifySession(k, token, now + SESSION_IDLE_S + 1)).toBeNull();
  });
});

describe("checkPassword", () => {
  it("accepts only the exact password", () => {
    expect(checkPassword(env.APP_PASSWORD, env)).toBe(true);
    expect(checkPassword(env.APP_PASSWORD + " ", env)).toBe(false);
    expect(checkPassword("", env)).toBe(false);
  });
  it("never accepts when no valid password is configured", () => {
    expect(checkPassword("", { APP_PASSWORD: "" })).toBe(false);
    expect(checkPassword("short", { APP_PASSWORD: "short" })).toBe(false);
  });
});

describe("safeNextPath", () => {
  it.each([
    [undefined, "/portfolio"],
    ["", "/portfolio"],
    ["/projects/abc?view=list", "/projects/abc?view=list"],
    ["//evil.example", "/portfolio"],
    ["/\\evil.example", "/portfolio"],
    ["https://evil.example", "/portfolio"],
    ["/login?next=/x", "/portfolio"],
    // Browsers strip tab/newline/CR from URLs, so these would become "//evil.example".
    ["/\t/evil.example", "/portfolio"],
    ["/\n/evil.example", "/portfolio"],
    ["/\r/evil.example", "/portfolio"],
    ["/\u0000/evil.example", "/portfolio"],
    ["/\u007f/evil.example", "/portfolio"],
    // Percent-encoded tab stays a path segment on this site.
    ["/%09/evil", "/%09/evil"],
    ["/./login", "/portfolio"],
    ["/login/../portfolio#top", "/portfolio#top"],
    ["/" + "a".repeat(2001), "/portfolio"],
  ])("%j -> %s", (input, expected) => {
    expect(safeNextPath(input as string | undefined)).toBe(expected);
  });

  it("never returns something a browser would read as another site", () => {
    const tricky = ["/\t/x.example", "/\\/x.example", "/%2F/x.example", "/%5C/x.example", "/..//x.example", "/.//x.example"];
    for (const input of tricky) {
      const out = safeNextPath(input);
      expect(out.startsWith("/")).toBe(true);
      expect(out.startsWith("//")).toBe(false);
      expect(new URL(out, "https://app.example").origin).toBe("https://app.example");
    }
  });
});
