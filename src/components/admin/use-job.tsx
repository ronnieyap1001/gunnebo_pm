"use client";

import { useCallback, useRef, useState } from "react";
import { ProgressDialog } from "@/components/common/progress-dialog";
import type { ActionResult } from "@/lib/action-result";
import { runJob, type JobProgress } from "@/lib/run-job";
import { classifyThrown } from "./call";

interface JobView {
  open: boolean;
  title: string;
  message: string;
  fraction?: number;
}

export interface RunOptions {
  /** Puts `?job=<id>&kind=<kind>` in the URL while it runs, so a reload (e.g. after a deployment) resumes it. */
  resume?: { jobId: string; kind: string };
  /** Turns a raw progress step into what the dialog shows (e.g. estimate a fraction from the message). */
  map?: (p: JobProgress, previous: JobProgress | null) => JobProgress;
  /** Safety net against a runaway loop (default 500 steps). */
  maxSteps?: number;
}

function setJobParam(resume: { jobId: string; kind: string } | null) {
  try {
    const url = new URL(window.location.href);
    if (resume) {
      url.searchParams.set("job", resume.jobId);
      url.searchParams.set("kind", resume.kind);
    } else {
      url.searchParams.delete("job");
      url.searchParams.delete("kind");
    }
    window.history.replaceState(null, "", url.toString());
  } catch {
    /* URL bookkeeping is best effort */
  }
}

/**
 * Runs a resumable server job with the shared ProgressDialog. Each `step` is idempotent on the server; BUSY answers
 * are retried with backoff by runJob. When the deployment changed under the open tab, the page reloads and the job
 * resumes from `?job=`.
 */
export function useJob() {
  const [view, setView] = useState<JobView>({ open: false, title: "", message: "" });
  const busy = useRef(false);

  const run = useCallback(
    async (title: string, step: () => Promise<ActionResult<JobProgress>>, opts: RunOptions = {}): Promise<ActionResult<JobProgress>> => {
      if (busy.current) return { ok: false, error: "Another task is still running. Wait for it to finish.", code: "BUSY_LOCAL" };
      busy.current = true;
      setView({ open: true, title, message: "Starting…", fraction: 0 });
      if (opts.resume) setJobParam(opts.resume);
      let previous: JobProgress | null = null;
      // Classify thrown errors here (runJob would report an expired session as "the app was updated"): network
      // trouble becomes BUSY so runJob retries it with backoff; an expired session stops the job.
      let offline = false;
      const guarded = async (): Promise<ActionResult<JobProgress>> => {
        try {
          const r = await step();
          offline = false;
          return r;
        } catch (err) {
          const r = await classifyThrown(err);
          offline = r.code === "NETWORK";
          return offline ? { ...r, code: "BUSY" } : r;
        }
      };
      try {
        const result = await runJob(guarded, {
          maxSteps: opts.maxSteps,
          onProgress: (p) => {
            // runJob's retry notice keeps the last progress; say what is actually wrong and keep the bar where it was.
            if (!p.done && /^Notion is busy, retrying/.test(p.message)) {
              const message = offline ? p.message.replace("Notion is busy", "Can't reach the server") : p.message;
              setView((v) => ({ ...v, message }));
              return;
            }
            const shown = opts.map ? opts.map(p, previous) : p;
            previous = shown;
            setView((v) => ({ ...v, message: shown.message, fraction: shown.fraction }));
          },
        });
        // Resumable jobs reload and carry on from ?job=; others report the error (the toast offers Reload).
        if (!result.ok && result.code === "STALE_DEPLOYMENT" && opts.resume) {
          setView((v) => ({ ...v, message: "The app was updated. Reloading to continue…" }));
          window.setTimeout(() => window.location.reload(), 800);
          return result;
        }
        // Finished, or failed for a reason a reload would not fix: stop resuming on reload. After a busy spell or an
        // expired session (signing in comes back to this URL) the reload carries on.
        if (opts.resume && (result.ok || (result.code !== "BUSY" && result.code !== "NETWORK" && result.code !== "SESSION"))) setJobParam(null);
        return result;
      } finally {
        busy.current = false;
        setView((v) => (v.message.startsWith("The app was updated") ? v : { ...v, open: false }));
      }
    },
    [],
  );

  const dialog = <ProgressDialog open={view.open} title={view.title} message={view.message} fraction={view.fraction} />;
  return { run, dialog, running: view.open };
}
