import { describe, expect, it } from "vitest";
import { clientKey, LoginThrottle, MAX_FAILURES, WINDOW_MS } from "@/server/auth/throttle";

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("LoginThrottle", () => {
  it(`lets an address try ${MAX_FAILURES} times, then pauses it`, () => {
    const c = clock();
    const th = new LoginThrottle(c.now);
    for (let i = 0; i < MAX_FAILURES; i++) {
      expect(th.retryAfterMs("1.2.3.4")).toBe(0);
      th.recordFailure("1.2.3.4");
    }
    expect(th.retryAfterMs("1.2.3.4")).toBe(WINDOW_MS);
    // Another address is not affected.
    expect(th.retryAfterMs("5.6.7.8")).toBe(0);
  });

  it("lifts the pause when the window has passed", () => {
    const c = clock();
    const th = new LoginThrottle(c.now);
    for (let i = 0; i < MAX_FAILURES; i++) th.recordFailure("a");
    c.advance(WINDOW_MS - 1000);
    expect(th.retryAfterMs("a")).toBe(1000);
    c.advance(1000);
    expect(th.retryAfterMs("a")).toBe(0);
    th.recordFailure("a");
    expect(th.retryAfterMs("a")).toBe(0);
  });

  it("forgets failures after a correct password", () => {
    const th = new LoginThrottle(clock().now);
    for (let i = 0; i < MAX_FAILURES - 1; i++) th.recordFailure("a");
    th.recordSuccess("a");
    th.recordFailure("a");
    expect(th.retryAfterMs("a")).toBe(0);
  });

  it("keeps memory bounded", () => {
    const th = new LoginThrottle(clock().now);
    for (let i = 0; i < 6000; i++) th.recordFailure(`ip-${i}`);
    expect((th as unknown as { entries: Map<string, unknown> }).entries.size).toBeLessThanOrEqual(5000);
  });
});

describe("clientKey", () => {
  it("uses the first X-Forwarded-For address", () => {
    expect(clientKey(new Headers({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" }))).toBe("203.0.113.9");
  });
  it("falls back to X-Real-IP, then to one local key", () => {
    expect(clientKey(new Headers({ "x-real-ip": "198.51.100.2" }))).toBe("198.51.100.2");
    expect(clientKey(new Headers())).toBe("local");
  });
});
