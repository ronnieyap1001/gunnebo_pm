"use client";

import { useEffect, useState } from "react";

/**
 * "Now" for relative times ("3d ago"). Starts at the server's time, so the first client render matches the server
 * HTML, then follows the browser clock once a minute.
 */
export function useNow(serverNow: string, intervalMs = 60_000): string {
  const [now, setNow] = useState(serverNow);
  useEffect(() => {
    setNow(new Date().toISOString());
    const t = window.setInterval(() => setNow(new Date().toISOString()), intervalMs);
    return () => window.clearInterval(t);
  }, [intervalMs]);
  return now;
}

/** True on Apple platforms (shows ⌘ instead of Ctrl). False until mounted, so server and client HTML agree. */
export function useIsMac(): boolean {
  const [mac, setMac] = useState(false);
  useEffect(() => {
    const p = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform ?? "";
    setMac(/mac|iphone|ipad|ipod/i.test(p) || /Mac OS X/.test(navigator.userAgent));
  }, []);
  return mac;
}
