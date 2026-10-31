"use client";

/**
 * Long template operations: Export JSON (download), Import JSON (browser checks → preview → resumable import job)
 * and "Sync all projects" (one resumable sync job per active project, driven one after another). Every job shows the
 * shared ProgressDialog; `?job=<opId>&kind=…` stays in the URL while it runs so a reload (e.g. after a deployment)
 * finishes it.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  continueImportAction,
  continueSyncAction,
  listSyncTargetsAction,
  previewImportAction,
  startImportAction,
  startSyncDefaultsAction,
  type ImportSummary,
} from "@/app/(app)/template/actions";
import type { ActionResult } from "@/lib/action-result";
import { runJob, type JobProgress } from "@/lib/run-job";
import { enqueue, newOpId } from "@/lib/write-queue";
import type { SyncTarget } from "@/server/services/sync";
import { ProgressDialog } from "@/components/common/progress-dialog";
import type { ImportPreview } from "./import-dialog";
import { setJobParam, type ResumableKind } from "./url";
import { attempt, reportFailure, withRetry } from "./write";

/** Same limit as the server action (and the importer's job storage). */
export const MAX_IMPORT_BYTES = 1024 * 1024;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * A job step for runJob: network errors count as BUSY (retried with backoff); session/deployment problems stop. The
 * run's driver id goes to the continue action (it waits while another tab or window runs the same job).
 */
function jobStep<T extends JobProgress>(call: (driver: string) => Promise<ActionResult<T>>): (driver: string) => Promise<ActionResult<T>> {
  return async (driver) => {
    const r = await attempt(() => call(driver));
    return r.ok || r.code !== "NETWORK" ? r : { ...r, code: "BUSY" };
  };
}

export function summaryLine(s: ImportSummary): string {
  const parts = [
    s.added.length ? `${s.added.length} added` : "",
    s.updated.length ? `${s.updated.length} updated` : "",
    s.archived.length ? `${s.archived.length} archived` : "",
    s.edgesAdded || s.edgesRemoved ? `arrows +${s.edgesAdded} −${s.edgesRemoved}` : "",
    s.projectFieldsAdded.length ? `${plural(s.projectFieldsAdded.length, "project field")} added` : "",
  ].filter(Boolean);
  return parts.length ? `${parts.join(", ")}. Projects change when you Sync them.` : "Projects change when you Sync them.";
}

function filenameFrom(disposition: string | null): string | null {
  const m = disposition?.match(/filename="([^"]+)"/);
  return m ? m[1] : null;
}

interface ProgressView {
  title: string;
  message: string;
  fraction?: number;
}

export function useTemplateJobs({
  resume,
  onImported,
}: {
  resume: { opId: string; kind: ResumableKind } | null;
  /** Called after an import finished (the page data has been refreshed by then). */
  onImported: () => void;
}) {
  const [progress, setProgress] = useState<ProgressView | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [startingImport, setStartingImport] = useState(false);
  const [syncTargets, setSyncTargets] = useState<SyncTarget[] | null>(null);
  const [checkingSync, setCheckingSync] = useState(false);
  const [exporting, setExporting] = useState(false);
  const busy = useRef(false);
  const pendingImport = useRef<{ text: string; fileName: string; opId: string; summary: ImportSummary } | null>(null);
  const onImportedRef = useRef(onImported);
  onImportedRef.current = onImported;

  const report = useCallback((p: JobProgress, prefix = "", base = 0, of = 1) => {
    setProgress((v) => (v ? { ...v, message: prefix ? `${prefix}: ${p.message}` : p.message, fraction: (base + (p.fraction ?? 0)) / of } : v));
  }, []);

  /** After a new deployment the job continues from ?job= once the page has reloaded. */
  const reloadToContinue = useCallback(() => {
    setProgress((v) => (v ? { ...v, message: "The app was updated. Reloading to continue…" } : v));
    window.setTimeout(() => window.location.reload(), 800);
  }, []);

  // -------------------------------------------------------------------------
  // Import
  // -------------------------------------------------------------------------

  const runImportJob = useCallback(
    async (opId: string, summary: ImportSummary | null) => {
      if (busy.current) return;
      busy.current = true;
      setJobParam({ opId, kind: "import" });
      setProgress({ title: "Importing the template", message: "Starting…", fraction: 0 });
      const r = await runJob(jobStep((driver) => continueImportAction(opId, driver)), { onProgress: (p) => report(p) });
      busy.current = false;
      if (!r.ok && r.code === "STALE_DEPLOYMENT") return reloadToContinue();
      setProgress(null);
      setJobParam(null);
      if (!r.ok) {
        const retry = () => void runImportJob(opId, summary);
        if (r.code === "SESSION") reportFailure(r, retry);
        // No such job (e.g. an old ?job= link): nothing to continue.
        else if (r.code === "NOT_FOUND" || r.code === "VALIDATION") reportFailure(r);
        else
          toast.error("The import stopped before it finished", {
            description: `${r.error} Press Continue to finish it; nothing is applied twice.`,
            duration: Infinity,
            action: { label: "Continue", onClick: retry },
          });
        return;
      }
      toast.success("Template imported", { description: summary ? summaryLine(summary) : "Projects change when you Sync them." });
      onImportedRef.current();
    },
    [report, reloadToContinue],
  );

  const chooseImportFile = useCallback(async (file: File) => {
    if (busy.current) return;
    const fileName = file.name || "template.json";
    if (file.size > MAX_IMPORT_BYTES) {
      setPreview({
        kind: "problems",
        fileName,
        message: `This file is larger than 1 MB (${(file.size / (1024 * 1024)).toFixed(2)} MB), so it can't be a Gunnebo PM template file.`,
        problems: [],
      });
      return;
    }
    setPreviewing(true);
    try {
      let text: string;
      try {
        text = await file.text();
      } catch {
        toast.error("Couldn't read this file. Choose it again.");
        return;
      }
      try {
        JSON.parse(text);
      } catch {
        setPreview({ kind: "problems", fileName, message: "This isn't a JSON file, so it can't be a Gunnebo PM template.", problems: [] });
        return;
      }
      const opId = newOpId();
      const r = await withRetry(() => previewImportAction(opId, text));
      if (!r.ok) {
        if (r.code === "VALIDATION") {
          const raw = r.details?.errors;
          const problems = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
          setPreview({
            kind: "problems",
            fileName,
            message: problems.length ? `The file has ${plural(problems.length, "problem")}:` : r.error,
            problems,
          });
        } else {
          reportFailure(r);
        }
        return;
      }
      pendingImport.current = { text, fileName, opId: newOpId(), summary: r.data };
      setPreview({ kind: "summary", fileName, summary: r.data });
    } finally {
      setPreviewing(false);
    }
  }, []);

  const confirmImport = useCallback(async () => {
    const p = pendingImport.current;
    if (!p || busy.current) return;
    setStartingImport(true);
    const s = await withRetry(() => startImportAction(p.opId, p.text));
    setStartingImport(false);
    if (!s.ok) {
      reportFailure(s);
      return;
    }
    setPreview(null);
    pendingImport.current = null;
    await runImportJob(p.opId, s.data.summary);
  }, [runImportJob]);

  const cancelImport = useCallback(() => {
    pendingImport.current = null;
    setPreview(null);
  }, []);

  // -------------------------------------------------------------------------
  // Sync all projects
  // -------------------------------------------------------------------------

  const askSyncAll = useCallback(async () => {
    if (busy.current) return;
    setCheckingSync(true);
    const r = await withRetry(() => listSyncTargetsAction());
    setCheckingSync(false);
    if (!r.ok) {
      reportFailure(r);
      return;
    }
    if (!r.data.length) {
      toast.info("There are no active projects to sync.", { description: "Sync updates projects with the status Active." });
      return;
    }
    setSyncTargets(r.data);
  }, []);

  const syncAll = useCallback(
    async (targets: SyncTarget[]) => {
      if (busy.current || !targets.length) return;
      busy.current = true;
      setSyncTargets(null);
      const n = targets.length;
      const done: { t: SyncTarget; items: number }[] = [];
      const failed: { t: SyncTarget; error: string }[] = [];
      setProgress({ title: `Syncing ${plural(n, "project")}`, message: "Starting…", fraction: 0 });
      let stoppedBy: string | null = null;
      for (let i = 0; i < n; i++) {
        const t = targets[i];
        const prefix = `${t.code} (${i + 1} of ${n})`;
        const opId = newOpId();
        report({ done: false, message: "Checking what changed in the template…", fraction: 0 }, prefix, i, n);
        const r = await enqueue(t.projectId, async (): Promise<ActionResult<number>> => {
          const s = await withRetry(() => startSyncDefaultsAction(opId, t.projectId));
          if (!s.ok) return s;
          setJobParam({ opId, kind: "sync" });
          const j = await runJob(jobStep((driver) => continueSyncAction(opId, driver)), { onProgress: (p) => report(p, prefix, i, n) });
          return j.ok ? { ok: true, data: s.data.itemCount } : j;
        });
        if (!r.ok && r.code === "STALE_DEPLOYMENT") {
          busy.current = false;
          return reloadToContinue();
        }
        if (r.ok) done.push({ t, items: r.data });
        else failed.push({ t, error: r.error });
        if (!r.ok && r.code === "SESSION") {
          stoppedBy = r.error;
          break;
        }
      }
      setJobParam(null);
      setProgress(null);
      busy.current = false;

      const lines = done.map(({ t, items }) => `${t.code}: ${items ? plural(items, "change") : "nothing new"}`);
      if (stoppedBy) {
        reportFailure({ ok: false, error: stoppedBy, code: "SESSION" }, () => void syncAll(targets.filter((t) => !done.some((d) => d.t === t))));
        return;
      }
      if (failed.length) {
        const retry = failed.map((f) => f.t);
        toast.error(`Synced ${done.length} of ${plural(n, "project")}`, {
          description: [...failed.map((f) => `${f.t.code}: ${f.error}`), ...lines].join("\n"),
          duration: 20_000,
          action: { label: `Retry ${failed.length}`, onClick: () => void syncAll(retry) },
        });
        return;
      }
      toast.success(`Synced ${plural(n, "project")}`, { description: lines.join(" · ") });
    },
    [report, reloadToContinue],
  );

  // -------------------------------------------------------------------------
  // Export
  // -------------------------------------------------------------------------

  const exportJson = useCallback(async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const res = await fetch("/api/template/export", { cache: "no-store", credentials: "same-origin" });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        if (res.status === 401) reportFailure({ ok: false, error: "Session expired. Sign in again", code: "SESSION" });
        else toast.error(body?.error && body.error !== "session" ? body.error : "The export didn't work. Try again.");
        return;
      }
      const blob = await res.blob();
      const name = filenameFrom(res.headers.get("Content-Disposition")) ?? "gunnebo-pm-template.json";
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
      toast.success("Template exported", { description: name });
    } catch {
      toast.error("Couldn't reach the server. Check your connection and try again.");
    } finally {
      setExporting(false);
    }
  }, [exporting]);

  // -------------------------------------------------------------------------
  // Resume a job after a reload
  // -------------------------------------------------------------------------

  const resumed = useRef(false);
  useEffect(() => {
    if (!resume || resumed.current) return;
    resumed.current = true;
    if (resume.kind === "import") {
      void runImportJob(resume.opId, null);
      return;
    }
    void (async () => {
      busy.current = true;
      setProgress({ title: "Finishing the sync", message: "Starting…", fraction: 0 });
      const r = await runJob(jobStep((driver) => continueSyncAction(resume.opId, driver)), { onProgress: (p) => report(p) });
      busy.current = false;
      if (!r.ok && r.code === "STALE_DEPLOYMENT") return reloadToContinue();
      setProgress(null);
      setJobParam(null);
      if (!r.ok) {
        reportFailure(r);
        return;
      }
      toast.success("Sync finished", { description: "If other projects were waiting, press Sync all projects again; synced ones are skipped quickly." });
    })();
  }, [resume, runImportJob, report, reloadToContinue]);

  const dialog = (
    <ProgressDialog open={progress !== null} title={progress?.title ?? ""} message={progress?.message ?? ""} fraction={progress?.fraction} />
  );

  return {
    dialog,
    running: progress !== null,
    preview,
    previewing,
    startingImport,
    chooseImportFile,
    confirmImport,
    cancelImport,
    syncTargets,
    checkingSync,
    askSyncAll,
    syncAll,
    cancelSyncAll: () => setSyncTargets(null),
    exporting,
    exportJson,
  };
}
