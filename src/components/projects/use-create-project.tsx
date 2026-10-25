"use client";

import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ProgressDialog } from "@/components/common/progress-dialog";
import { runJob, type JobProgress } from "@/lib/run-job";
import { continueCreateProjectAction } from "@/app/(app)/projects/actions";
import { toastFailure } from "@/components/shell/action-call";

export const CREATE_JOB_KIND = "createProject";

interface View {
  open: boolean;
  title: string;
  message: string;
  fraction?: number;
}

/** Keeps `?job=<opId>&kind=createProject&code=…` in the URL while a creation runs, so a reload resumes it. */
function setJobParams(job: { opId: string; code: string } | null) {
  try {
    const url = new URL(window.location.href);
    if (job) {
      url.searchParams.set("job", job.opId);
      url.searchParams.set("kind", CREATE_JOB_KIND);
      url.searchParams.set("code", job.code);
    } else {
      url.searchParams.delete("job");
      url.searchParams.delete("kind");
      url.searchParams.delete("code");
    }
    window.history.replaceState(window.history.state, "", url.toString());
  } catch {
    /* best effort */
  }
}

function copyingMessage(doneCount: number, total: number): string {
  return total > 0 ? `Copying milestones… ${doneCount} of ${total}` : "Copying milestones…";
}

/**
 * Runs (or resumes) the "create project" job: continueCreateProject is called until done, with the shared progress
 * dialog ("Copying milestones… 24 of 64"), then the new project opens. Every call reuses the job's opId.
 */
export function useCreateProject(opts: { onStopped?: () => void } = {}) {
  const router = useRouter();
  const [view, setView] = useState<View>({ open: false, title: "", message: "" });
  const busy = useRef(false);
  const onStopped = useRef(opts.onStopped);
  onStopped.current = opts.onStopped;

  const run = useCallback(
    async (job: { opId: string; code: string; total?: number; doneCount?: number }): Promise<boolean> => {
      if (busy.current) return false;
      busy.current = true;
      const title = `Creating ${job.code}`;
      setView({
        open: true,
        title,
        message: copyingMessage(job.doneCount ?? 0, job.total ?? 0),
        fraction: job.total ? (job.doneCount ?? 0) / job.total : 0,
      });
      setJobParams({ opId: job.opId, code: job.code });
      let keepOpen = false;
      try {
        const result = await runJob(() => continueCreateProjectAction(job.opId), {
          maxSteps: 200,
          onProgress: (p: JobProgress) => {
            const d = p as JobProgress & { doneCount?: number; total?: number };
            const message = p.message.startsWith("Notion is busy")
              ? p.message
              : p.done
                ? "Opening the project…"
                : copyingMessage(d.doneCount ?? 0, d.total ?? job.total ?? 0);
            setView((v) => ({ ...v, message, fraction: p.fraction }));
          },
        });
        if (result.ok) {
          const data = result.data as JobProgress & { projectId?: string; total?: number };
          setJobParams(null);
          toast.success(`${job.code} created`, {
            description: data.total ? `${data.total} milestones copied from the Template Flow.` : undefined,
          });
          if (data.projectId) {
            keepOpen = true;
            router.push(`/projects/${encodeURIComponent(data.projectId)}`);
          } else {
            router.refresh();
          }
          return true;
        }
        if (result.code === "STALE_DEPLOYMENT") {
          // The job id is in the URL: reload and carry on.
          keepOpen = true;
          setView((v) => ({ ...v, message: "The app was updated. Reloading to continue…" }));
          window.setTimeout(() => window.location.reload(), 800);
          return false;
        }
        if (result.code !== "BUSY" && result.code !== "NETWORK" && result.code !== "SESSION") setJobParams(null);
        toastFailure(result, {
          title: `Creating ${job.code} stopped`,
          retry: () => void run(job),
        });
        onStopped.current?.();
        return false;
      } finally {
        busy.current = false;
        if (!keepOpen) setView((v) => ({ ...v, open: false }));
      }
    },
    [router],
  );

  const dialog = <ProgressDialog open={view.open} title={view.title} message={view.message} fraction={view.fraction} />;
  return { run, dialog, running: view.open };
}
