/**
 * Counts wrong passwords per network address and pauses sign-in for that address after too many.
 * Kept in memory, so each server instance counts on its own and a cold start forgets; it slows guessing down,
 * it does not stop a determined attacker. The real protection is the long APP_PASSWORD plus Vercel
 * Authentication and the firewall rule described in the README.
 */
export const MAX_FAILURES = 5;
export const WINDOW_MS = 15 * 60 * 1000;
const MAX_TRACKED = 5000;

interface Entry {
  failures: number;
  /** When the counting window started. */
  since: number;
}

export class LoginThrottle {
  private entries = new Map<string, Entry>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Milliseconds this address must still wait, or 0 if it may try. */
  retryAfterMs(key: string): number {
    const e = this.entries.get(key);
    if (!e) return 0;
    const elapsed = this.now() - e.since;
    if (elapsed >= WINDOW_MS) {
      this.entries.delete(key);
      return 0;
    }
    return e.failures >= MAX_FAILURES ? WINDOW_MS - elapsed : 0;
  }

  recordFailure(key: string): void {
    const t = this.now();
    const e = this.entries.get(key);
    if (!e || t - e.since >= WINDOW_MS) {
      this.entries.delete(key);
      if (this.entries.size >= MAX_TRACKED) {
        // Forget the oldest address (Map keeps insertion order).
        const oldest = this.entries.keys().next().value;
        if (oldest !== undefined) this.entries.delete(oldest);
      }
      this.entries.set(key, { failures: 1, since: t });
      return;
    }
    e.failures += 1;
  }

  recordSuccess(key: string): void {
    this.entries.delete(key);
  }
}

/**
 * The visitor's address as Vercel reports it. Vercel overwrites X-Forwarded-For with the real client address, so it
 * cannot be faked from the browser there. Locally everything counts as one address.
 */
export function clientKey(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const real = headers.get("x-real-ip")?.trim();
  return (forwarded || real || "local").slice(0, 100);
}

const globalForThrottle = globalThis as unknown as { __gpmLoginThrottle?: LoginThrottle };
export const loginThrottle = (globalForThrottle.__gpmLoginThrottle ??= new LoginThrottle());
