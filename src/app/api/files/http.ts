/**
 * Shared helpers for the file and export routes: RFC 5987 Content-Disposition, same-origin checks and the
 * download headers every served file gets.
 */

/** `attachment; filename="ascii fallback"; filename*=UTF-8''percent-encoded` (also correct for Chinese and long names). */
export function contentDisposition(name: string, kind: "attachment" | "inline" = "attachment"): string {
  const clean = (name || "file").replace(/[\r\n\u0000-\u001f\u007f]/g, " ").trim() || "file";
  // Keep the extension when shortening the ASCII fallback.
  const ascii = clean
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\%;]/g, "_");
  const dot = ascii.lastIndexOf(".");
  const ext = dot > 0 && ascii.length - dot <= 10 ? ascii.slice(dot) : "";
  const fallback = ascii.length > 150 ? `${ascii.slice(0, 150 - ext.length)}${ext}` : ascii;
  const encoded = encodeURIComponent(Array.from(clean).slice(0, 400).join("")).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export const DOWNLOAD_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "sandbox",
  "Cache-Control": "private, no-store",
  "Referrer-Policy": "no-referrer",
};

/** Non-GET requests must come from this app's own pages (blocks cross-site form posts). */
export function isSameOrigin(req: Request): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (site) return site === "same-origin";
  const origin = req.headers.get("origin");
  if (!origin) return false;
  try {
    const o = new URL(origin);
    const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? new URL(req.url).host;
    return o.host === host;
  } catch {
    return false;
  }
}

export function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...extra } });
}
