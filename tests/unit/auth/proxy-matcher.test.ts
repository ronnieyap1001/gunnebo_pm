import { describe, expect, it } from "vitest";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { config } from "@/proxy";

const matches = (url: string) => unstable_doesMiddlewareMatch({ config, url });

describe("proxy matcher", () => {
  it.each([
    "/",
    "/portfolio",
    "/projects",
    "/projects/abc?view=list",
    "/library",
    "/template",
    "/archive",
    "/settings",
    "/setup",
    "/api/files/123",
    "/api/export/project/123",
  ])("protects %s", (url) => {
    expect(matches(url)).toBe(true);
  });

  it.each(["/login", "/not-configured", "/api/health", "/api/cron/backup", "/_next/static/chunk.js", "/favicon.ico", "/robots.txt", "/icon.svg"])(
    "leaves %s public",
    (url) => {
      expect(matches(url)).toBe(false);
    },
  );
});
