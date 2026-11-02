import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ResponseCookies } from "next/dist/server/web/spec-extension/cookies";

/**
 * Sign out must really remove the "__Host-" cookie in production. Browsers ignore a Set-Cookie for a "__Host-" name
 * unless it carries Secure and Path=/, so a bare delete() would leave the session alive.
 */
const headers = new Headers();
const jar = new ResponseCookies(headers);

vi.mock("next/headers", () => ({ cookies: async () => jar }));
vi.mock("@/server/auth/epoch", () => ({ currentEpoch: async () => 0 }));

describe("endSession", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_PASSWORD", "a production password");
    vi.stubEnv("SESSION_SECRET", "test secret");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    headers.delete("set-cookie");
  });

  it("overwrites the __Host- cookie with Secure, Path=/ and Max-Age=0", async () => {
    const { endSession } = await import("@/server/auth/session");
    await endSession();
    const setCookie = headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/^__Host-gpm_session=;/);
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toMatch(/Max-Age=0/i);
    expect(setCookie).toContain("HttpOnly");
  });

  it("signing in sets a Secure __Host- cookie", async () => {
    const { startSession } = await import("@/server/auth/session");
    await startSession();
    const setCookie = headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/^__Host-gpm_session=[^;]+\./);
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("Path=/");
  });
});
