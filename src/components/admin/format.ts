import { formatInstant, formatRelative, ymdFromInstant } from "@/domain/dates";

/** '24 Oct 2026, 14:05' in the app time zone, or an em dash when unknown. */
export function when(iso: string | null | undefined, timeZone: string): string {
  if (!iso) return "—";
  return formatInstant(iso, timeZone);
}

/** '3d ago' relative to `now` (pass a server-supplied or after-mount clock, never render-time Date.now()). */
export function ago(iso: string | null | undefined, now: string, timeZone: string): string {
  if (!iso) return "";
  return formatRelative(iso, now, timeZone);
}

/** 'YYYY-MM-DD' of an instant in the app time zone (file names). */
export function ymdIn(iso: string, timeZone: string): string {
  try {
    return ymdFromInstant(iso, timeZone);
  } catch {
    return iso.slice(0, 10);
  }
}

/** '1.2 MB'. */
export function fileSize(bytes: number | null | undefined): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Saves a string as a file in the browser. */
export function downloadText(fileName: string, text: string, type = "application/json"): void {
  const blob = new Blob([text], { type: `${type};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
