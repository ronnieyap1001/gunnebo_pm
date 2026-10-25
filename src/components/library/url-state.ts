"use client";

/**
 * Updates the query string without a server round trip. Next.js syncs native history calls with useSearchParams,
 * so components reading the URL re-render.
 */
export function setSearchParams(updates: Record<string, string | null>, mode: "push" | "replace" = "replace"): void {
  const params = new URLSearchParams(window.location.search);
  for (const [k, v] of Object.entries(updates)) {
    if (v === null || v === "") params.delete(k);
    else params.set(k, v);
  }
  const qs = params.toString();
  const url = `${window.location.pathname}${qs ? `?${qs}` : ""}`;
  if (url === `${window.location.pathname}${window.location.search}`) return;
  if (mode === "push") window.history.pushState(null, "", url);
  else window.history.replaceState(null, "", url);
}
