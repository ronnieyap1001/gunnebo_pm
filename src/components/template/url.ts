"use client";

/**
 * Query-string bookkeeping without a server round trip (Next.js syncs native history calls with its router):
 * `?m=<milestoneId>` for the open side panel, `?job=<opId>&kind=import|sync` while a resumable job runs.
 */
export function setSearchParams(updates: Record<string, string | null>): void {
  try {
    const url = new URL(window.location.href);
    for (const [k, v] of Object.entries(updates)) {
      if (v === null || v === "") url.searchParams.delete(k);
      else url.searchParams.set(k, v);
    }
    if (url.href === window.location.href) return;
    // `null` state: Next.js then treats this as an outside call and syncs its router (and useSearchParams) with it.
    window.history.replaceState(null, "", url.toString());
  } catch {
    /* URL bookkeeping is best effort */
  }
}

export type ResumableKind = "import" | "sync";

export function setJobParam(job: { opId: string; kind: ResumableKind } | null): void {
  setSearchParams(job ? { job: job.opId, kind: job.kind } : { job: null, kind: null });
}
