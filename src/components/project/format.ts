"use client";

import { useEffect, useState } from "react";
import { formatInstant, formatRelative } from "@/domain/dates";

/**
 * The current time, available only after mount (so server and browser render the same HTML) and refreshed every
 * minute. `null` before mount.
 */
export function useNow(intervalMs = 60_000): string | null {
  const [now, setNow] = useState<string | null>(null);
  useEffect(() => {
    setNow(new Date().toISOString());
    const t = setInterval(() => setNow(new Date().toISOString()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

/** "2d ago" after mount; empty before (avoids a hydration mismatch). */
export function relative(iso: string | null | undefined, now: string | null, timeZone: string): string {
  if (!iso || !now) return "";
  return formatRelative(iso, now, timeZone);
}

/** "24 Oct 14:05" (the year only when it isn't this year), in the app's time zone. */
export function shortInstant(iso: string, timeZone: string, now?: string | null): string {
  const full = formatInstant(iso, timeZone); // "24 Oct 2026, 14:05"
  const m = /^(\d{1,2} \w{3}) (\d{4}), (\d{2}:\d{2})$/.exec(full);
  if (!m) return full;
  const thisYear = now ? formatInstant(now, timeZone).match(/\d{4}/)?.[0] : null;
  return thisYear === m[2] ? `${m[1]} ${m[3]}` : `${m[1]} ${m[2]}, ${m[3]}`;
}

export function formatBytes(n: number | null | undefined): string {
  if (!n || n <= 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Removes the "C0822 · " prefix History summaries start with. */
export function stripCode(summary: string, code: string): string {
  const prefix = `${code} · `;
  return summary.startsWith(prefix) ? summary.slice(prefix.length) : summary;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
