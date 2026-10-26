"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useStore } from "zustand";
import { todayIn } from "@/domain/dates";
import type { ProjectPageData } from "@/server/queries";
import { continueCreateAction } from "@/app/(app)/projects/[id]/actions";
import { runJob } from "@/lib/run-job";
import { onQueueChange, pendingCount } from "@/lib/write-queue";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { EmptyState } from "@/components/common/empty-state";
import { ProgressDialog } from "@/components/common/progress-dialog";
import { FlowProvider, useFlowControls } from "@/components/flow/flow-canvas";
import { AddStepDialog, type AddStepRequest } from "./add-step-dialog";
import { ProjectContextProvider, type PanelSection, type ProjectContextValue } from "./context";
import { derive, toRaw } from "./derive";
import { DetailsSheet } from "./details-sheet";
import { FlowView } from "./flow-view";
import { HistoryView } from "./history-view";
import { ListView } from "./list-view";
import { ProjectHeader } from "./project-header";
import { ShortcutsDialog } from "./shortcuts-dialog";
import { StepPanel } from "./step-panel";
import { createProjectStore } from "./store";
import { SyncDialog } from "./sync-dialog";
import type { ProjectViewMode } from "./types";
import { createProjectApi } from "./use-project-api";
import { useProjectHotkeys } from "./use-project-hotkeys";
import { attempt, heldWrites, queueKey, reportFailure } from "./write";

export interface ProjectScreenProps {
  data: ProjectPageData;
  /** Server time when the read of `data` started. */
  readAt: string;
  timeZone: string;
  displayName: string;
  /** Server time of the render (relative times are drawn after mount). */
  now: string;
  initialView: ProjectViewMode;
  initialNodeId: string | null;
  resumeSyncJob: string | null;
  setupJob: string | null;
}

export function ProjectScreen(props: ProjectScreenProps) {
  return (
    <FlowProvider>
      <ProjectScreenInner {...props} />
    </FlowProvider>
  );
}

function updateUrl(patch: Record<string, string | null>) {
  const url = new URL(window.location.href);
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) url.searchParams.delete(k);
    else url.searchParams.set(k, v);
  }
  window.history.replaceState(window.history.state, "", url.toString());
}

function fileNameFrom(disposition: string | null): string | null {
  if (!disposition) return null;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
  if (star) {
    try {
      return decodeURIComponent(star[1]);
    } catch {
      /* fall through */
    }
  }
  const plain = /filename="([^"]+)"/i.exec(disposition);
  return plain ? plain[1] : null;
}

function ProjectScreenInner({ data, readAt, timeZone, displayName, initialView, initialNodeId, resumeSyncJob, setupJob }: ProjectScreenProps) {
  const router = useRouter();
  const controls = useFlowControls();
  const projectId = data.project.id;
  const [store] = useState(() => createProjectStore(toRaw(data, readAt)));
  const raw = useStore(store, (s) => s.raw);
  const view = useMemo(() => derive(raw, timeZone), [raw, timeZone]);

  // New page props (router.refresh after focus / midnight) replace the server data; local changes stay on top.
  const firstProps = useRef(true);
  useEffect(() => {
    if (firstProps.current) {
      firstProps.current = false;
      return;
    }
    store.getState().setServer(toRaw(data, readAt));
  }, [data, readAt, store]);

  const [mode, setModeState] = useState<ProjectViewMode>(initialView);
  const [selectedId, setSelectedId] = useState<string | null>(initialNodeId);
  const [section, setSection] = useState<PanelSection>(null);
  const [sectionNonce, setSectionNonce] = useState(0);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [syncOpen, setSyncOpen] = useState(false);
  const [archiveAsk, setArchiveAsk] = useState(false);
  const [addReq, setAddReq] = useState<AddStepRequest | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [closeAsked, setCloseAsked] = useState(false);
  const [closeDismissed, setCloseDismissed] = useState(false);

  // A selected step that disappeared (archived elsewhere) closes the panel.
  useEffect(() => {
    if (selectedId && !view.byId.has(selectedId) && !selectedId.startsWith("tmp-")) {
      setSelectedId(null);
      updateUrl({ node: null });
    }
  }, [selectedId, view.byId]);

  const setMode = useCallback((m: ProjectViewMode) => {
    setModeState(m);
    updateUrl({ view: m === "flow" ? null : m });
  }, []);

  const [focusValue, setFocusValue] = useState(true);
  const openStep = useCallback((id: string | null, sec: PanelSection = null, opts: { focus?: boolean } = {}) => {
    setSelectedId(id);
    setSection(sec);
    setSectionNonce((n) => n + 1);
    setFocusValue(opts.focus !== false);
    updateUrl({ node: id });
  }, []);

  const api = useMemo(
    () =>
      createProjectApi({
        projectId,
        store,
        displayName,
        onSuggestClose: () => {
          setCloseAsked(true);
          setCloseDismissed(false);
        },
        navigate: (href) => router.push(href),
      }),
    [projectId, store, displayName, router],
  );

  const centerOn = useCallback((id: string) => controls.centerOn(id), [controls]);

  // ---------------------------------------------------------------------------
  // Fresh data: on focus / tab visible, and when the date changes in the app's time zone (colours flip at midnight).
  // Never while writes are in flight: the refresh waits until the queue is empty.
  // ---------------------------------------------------------------------------
  const deferred = useRef(false);
  const lastRefresh = useRef(0);
  const refresh = useCallback(() => {
    if (pendingCount(queueKey(projectId)) > 0) {
      deferred.current = true;
      return;
    }
    // Signed out with changes kept for Retry: a refresh would go to the sign-in page and lose them.
    if (heldWrites() > 0) return;
    if (Date.now() - lastRefresh.current < 5000) return;
    lastRefresh.current = Date.now();
    router.refresh();
  }, [projectId, router]);

  useEffect(() => {
    const key = queueKey(projectId);
    const off = onQueueChange((k, n) => {
      if (k === key && n === 0 && deferred.current) {
        deferred.current = false;
        lastRefresh.current = 0;
        refresh();
      }
    });
    const onFocus = () => refresh();
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      off();
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [projectId, refresh]);

  const today = raw.today;
  useEffect(() => {
    const t = setInterval(() => {
      if (todayIn(timeZone, new Date()) !== today) {
        lastRefresh.current = 0;
        refresh();
      }
    }, 60_000);
    return () => clearInterval(t);
  }, [timeZone, today, refresh]);

  // ---------------------------------------------------------------------------
  // Keyboard
  // ---------------------------------------------------------------------------
  const overlay = detailsOpen || syncOpen || archiveAsk || addReq !== null || helpOpen;
  const stepIndex = selectedId ? view.steps.findIndex((s) => s.id === selectedId) : -1;

  const goStep = useCallback(
    (delta: number) => {
      if (!view.steps.length) return;
      const i = stepIndex < 0 ? (delta > 0 ? -1 : view.steps.length) : stepIndex;
      const next = view.steps[Math.max(0, Math.min(view.steps.length - 1, i + delta))];
      openStep(next.id, null, { focus: false });
      if (mode === "flow") controls.centerOn(next.id);
    },
    [view.steps, stepIndex, openStep, mode, controls],
  );

  useProjectHotkeys(
    {
      v: (e) => {
        e.preventDefault();
        setMode(mode === "flow" ? "list" : "flow");
      },
      h: (e) => {
        e.preventDefault();
        setMode(mode === "history" ? "flow" : "history");
      },
      "?": (e) => {
        e.preventDefault();
        setHelpOpen(true);
      },
    },
    !overlay,
  );
  // J / K also work with nothing selected (they start at the first / last milestone): the keyboard way into the chart.
  useProjectHotkeys(
    {
      j: (e) => {
        e.preventDefault();
        goStep(1);
      },
      k: (e) => {
        e.preventDefault();
        goStep(-1);
      },
      x: (e) => {
        const s = selectedId ? view.byId.get(selectedId) : undefined;
        if (!s || raw.project.archived) return;
        e.preventDefault();
        void api.setNotApplicable(s.id, !s.notApplicable);
      },
      n: (e) => {
        if (!selectedId) return;
        e.preventDefault();
        openStep(selectedId, "notes");
      },
    },
    !overlay && mode !== "list" && raw.project.setup === "READY",
  );

  // ---------------------------------------------------------------------------
  // Export
  // ---------------------------------------------------------------------------
  async function exportXlsx() {
    if (exporting) return;
    setExporting(true);
    const id = toast.loading("Preparing the Excel file…");
    try {
      const res = await fetch(`/api/export/project/${encodeURIComponent(projectId)}`, { cache: "no-store", credentials: "same-origin" });
      if (res.status === 401) {
        toast.dismiss(id);
        reportFailure({ ok: false, error: "Session expired. Sign in again", code: "SESSION" }, () => void exportXlsx(), "export");
        return;
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(body.error ?? "The export failed. Try again.", { id });
        return;
      }
      const blob = await res.blob();
      const name = fileNameFrom(res.headers.get("content-disposition")) ?? `${raw.project.code}.xlsx`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      toast.success("Excel file ready", { id, description: name });
    } catch {
      toast.error("Couldn't reach the server. Check your connection and try again.", { id });
    } finally {
      setExporting(false);
    }
  }

  const ctx: ProjectContextValue = {
    projectId,
    store,
    raw,
    view,
    timeZone,
    displayName,
    api,
    readOnly: raw.project.archived || raw.project.setup !== "READY",
    openStep,
    selectedId,
    centerOn,
  };

  const suggestClose = (raw.suggestClose || closeAsked) && !closeDismissed;
  const selected = selectedId ? view.byId.get(selectedId) : undefined;

  return (
    <ProjectContextProvider value={ctx}>
      <div className="flex h-svh min-h-0 flex-col">
        <ProjectHeader
          mode={mode}
          onMode={setMode}
          onEditDetails={() => setDetailsOpen(true)}
          onExport={() => void exportXlsx()}
          exporting={exporting}
          onSync={() => setSyncOpen(true)}
          onArchive={() => setArchiveAsk(true)}
          suggestClose={suggestClose}
          onSetClosed={() => {
            setCloseDismissed(true);
            void api.updateProject({ status: "CLOSED" }).then((r) => {
              if (r.ok) toast.success(`${raw.project.code} is now Closed`);
            });
          }}
          onDismissClose={() => setCloseDismissed(true)}
        />
        <div className="relative flex min-h-0 flex-1">
          <main className="flex min-w-0 flex-1 flex-col" aria-label={mode === "flow" ? "Flow chart" : mode === "list" ? "Milestone list" : "History"}>
            {raw.project.setup !== "READY" ? (
              <SetupPending setupJob={setupJob} onDone={() => router.refresh()} onArchive={() => setArchiveAsk(true)} />
            ) : mode === "flow" ? (
              <FlowView initialFocusId={selectedId} hotkeysEnabled={!overlay} onAddStep={(r) => setAddReq(r)} />
            ) : mode === "list" ? (
              <ListView hotkeysEnabled={!overlay} />
            ) : (
              <HistoryView />
            )}
          </main>
          {selected ? (
            <StepPanel
              stepId={selected.id}
              focusValue={focusValue}
              section={section}
              sectionNonce={sectionNonce}
              onClose={() => openStep(null)}
              onPrev={() => goStep(-1)}
              onNext={() => goStep(1)}
              onInsertAfter={(id) => setAddReq({ afterStepId: id })}
            />
          ) : null}
        </div>
      </div>

      <DetailsSheet open={detailsOpen} onOpenChange={setDetailsOpen} />
      <SyncDialog open={syncOpen} onOpenChange={setSyncOpen} resumeOpId={resumeSyncJob} />
      <AddStepDialog
        request={addReq}
        onClose={() => setAddReq(null)}
        onAdded={(id) => {
          openStep(id);
          if (mode === "flow") requestAnimationFrame(() => controls.centerOn(id));
        }}
      />
      <ConfirmDialog
        open={archiveAsk}
        onOpenChange={setArchiveAsk}
        title={`Archive ${raw.project.code}?`}
        description={
          <>
            <p>
              &ldquo;{raw.project.name}&rdquo; is hidden from Projects and the Portfolio. Nothing is deleted: its milestones, notes, files and history
              stay, and you can restore it from the Archive at any time.
            </p>
            <p>The code {raw.project.code} stays reserved.</p>
          </>
        }
        confirmLabel="Archive project"
        destructive
        onConfirm={() => {
          setArchiveAsk(false);
          void api.archiveProject();
        }}
      />
      <ShortcutsDialog open={helpOpen} onOpenChange={setHelpOpen} />
    </ProjectContextProvider>
  );
}

/**
 * A project whose copy from the template has not finished: finish it here (resumable job; while another tab or window
 * is still copying, the dialog waits for it) or, when the copy can't be resumed, archive it.
 */
function SetupPending({ setupJob, onDone, onArchive }: { setupJob: string | null; onDone: () => void; onArchive: () => void }) {
  const [running, setRunning] = useState<{ message: string; fraction?: number } | null>(null);
  async function resume() {
    if (!setupJob) return;
    setRunning({ message: "Continuing…", fraction: 0 });
    const r = await runJob((driver) => attempt(() => continueCreateAction(setupJob, driver)), {
      onProgress: (p) => setRunning({ message: p.message, fraction: p.fraction }),
    });
    setRunning(null);
    if (r.ok) {
      toast.success("The project is ready");
      onDone();
    } else reportFailure(r, () => void resume());
  }
  return (
    <>
      <EmptyState
        title="This project is still being set up"
        action={
          setupJob ? (
            <Button onClick={() => void resume()} disabled={Boolean(running)}>
              {running ? <Loader2 className="animate-spin" aria-hidden /> : null}
              Finish copying the milestones
            </Button>
          ) : (
            <Button variant="outline" onClick={onArchive}>
              Archive this project
            </Button>
          )
        }
      >
        {setupJob
          ? "Copying the milestones from the template has not finished. If another tab or window is still copying them, this waits for it; otherwise it carries on where the copy stopped. Nothing is copied twice."
          : "Copying the milestones from the template was interrupted and can't be resumed. Archive this project and create it again."}
      </EmptyState>
      <ProgressDialog open={Boolean(running)} title="Setting up the project" message={running?.message ?? ""} fraction={running?.fraction} />
    </>
  );
}
