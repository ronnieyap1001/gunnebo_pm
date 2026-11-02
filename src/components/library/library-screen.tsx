"use client";

import { startTransition, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Check, Keyboard, Loader2, Plus, TriangleAlert } from "lucide-react";
import type { LibraryView } from "@/server/queries";
import { useHotkeys } from "@/lib/hotkeys";
import { pendingCount } from "@/lib/write-queue";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader } from "@/components/shell/page-header";
import { FieldsTab } from "./fields-tab";
import { MilestonesTab } from "./milestones-tab";
import { Kbd, fromOverlay, useStableRows } from "./table-parts";
import { setSearchParams } from "./url-state";
import { QUEUE, setStaleRefresh, usePendingWrites } from "./write";

/** Don't reload the data more often than this when the tab regains focus. */
const FOCUS_REFRESH_MS = 5000;

/**
 * Keeps an open tab current: reloads the library when the window comes back into view (the template or a field may
 * have changed in another tab or on Template Flow) and after a write failed because this tab's data was stale.
 */
function useFreshData() {
  const router = useRouter();
  useEffect(() => {
    let last = Date.now();
    const refresh = () => startTransition(() => router.refresh());
    const onBack = () => {
      if (document.visibilityState !== "visible" || Date.now() - last < FOCUS_REFRESH_MS) return;
      // Never while a write is on its way: its own refresh brings the new data.
      if (pendingCount(QUEUE.library) + pendingCount(QUEUE.fields) > 0) return;
      last = Date.now();
      refresh();
    };
    setStaleRefresh(refresh);
    window.addEventListener("focus", onBack);
    document.addEventListener("visibilitychange", onBack);
    return () => {
      setStaleRefresh(null);
      window.removeEventListener("focus", onBack);
      document.removeEventListener("visibilitychange", onBack);
    };
  }, [router]);
}

export type LibraryTab = "milestones" | "project-fields";
export type { UrlState as LibraryUrlState };

interface UrlState {
  tab: LibraryTab;
  m: string | null;
  f: string | null;
}

function readUrl(search: string): UrlState {
  const p = new URLSearchParams(search);
  return { tab: p.get("tab") === "project-fields" ? "project-fields" : "milestones", m: p.get("m"), f: p.get("f") };
}

/**
 * Tab and selection live in local state for instant feedback and are mirrored to the URL (?tab=, ?m=, ?f=) with
 * native history calls; Back/Forward re-read the URL.
 */
export function LibraryScreen({ view, initial }: { view: LibraryView; initial: UrlState }) {
  const [url, setUrl] = useState<UrlState>(initial);
  const { tab, m: milestoneId, f: fieldId } = url;
  const milestones = useStableRows(view.milestones);
  const fields = useStableRows(view.projectFields);
  const [newOpen, setNewOpen] = useState(false);
  useFreshData();

  useEffect(() => {
    const onPop = () => setUrl(readUrl(window.location.search));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // A link inside the app (sidebar, command palette) can open /library with other parameters while this screen
  // stays mounted: follow the URL. The screen's own history writes come back here too; an older one that a newer
  // write has already replaced no longer matches the address bar and is ignored.
  const routerSearch = useSearchParams().toString();
  useEffect(() => {
    if (new URLSearchParams(window.location.search).toString() !== routerSearch) return;
    const next = readUrl(window.location.search);
    setUrl((u) => (u.tab === next.tab && u.m === next.m && u.f === next.f ? u : next));
  }, [routerSearch]);

  function selectMilestone(id: string | null) {
    setUrl((u) => ({ ...u, m: id }));
    setSearchParams({ m: id });
  }
  function selectField(id: string | null) {
    setUrl((u) => ({ ...u, f: id }));
    setSearchParams({ f: id });
  }
  const [helpOpen, setHelpOpen] = useState(false);
  const activeFields = view.projectFields.filter((f) => !f.archived).length;

  useHotkeys(
    {
      n: (e) => {
        if (fromOverlay(e)) return;
        e.preventDefault();
        setNewOpen(true);
      },
      "?": (e) => {
        if (fromOverlay(e) && !helpOpen) return;
        e.preventDefault();
        setHelpOpen((o) => !o);
      },
    },
    !newOpen,
  );

  function selectTab(t: string) {
    const next: LibraryTab = t === "project-fields" ? "project-fields" : "milestones";
    setNewOpen(false);
    setUrl({ tab: next, m: null, f: null });
    setSearchParams({ tab: next === "project-fields" ? next : null, m: null, f: null }, "push");
  }

  return (
    <div className="flex h-svh min-h-0 flex-col overflow-hidden">
      <PageHeader
        title="Milestone Library"
        description="The master list every new project copies, and the detail fields each project has."
        actions={
          <>
            <SavingIndicator />
            <Button variant="ghost" size="icon" className="size-8" aria-label="Keyboard shortcuts (?)" title="Keyboard shortcuts (?)" onClick={() => setHelpOpen(true)}>
              <Keyboard className="size-4" />
            </Button>
            <Button size="sm" className="h-8" onClick={() => setNewOpen(true)}>
              <Plus className="size-4" aria-hidden />
              {tab === "milestones" ? "Milestone" : "Field"}
              <Kbd className="ml-1 border-primary-foreground/30 bg-primary-foreground/15 text-primary-foreground">N</Kbd>
            </Button>
          </>
        }
      />
      <Tabs value={tab} onValueChange={selectTab} className="flex min-h-0 flex-1 flex-col gap-0">
        <div className="border-b px-4">
          <TabsList variant="line" className="h-10 gap-3 p-0" aria-label="Library sections">
            <TabsTrigger value="milestones" className="flex-none px-1 text-[13px]">
              Milestones
              <span className="rounded bg-muted px-1.5 text-[11px] font-medium text-muted-foreground tabular-nums">{view.milestones.length}</span>
            </TabsTrigger>
            <TabsTrigger value="project-fields" className="flex-none px-1 text-[13px]">
              Project fields
              <span className="rounded bg-muted px-1.5 text-[11px] font-medium text-muted-foreground tabular-nums">{activeFields}</span>
            </TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="milestones" className="flex min-h-0 flex-1 flex-col">
          <MilestonesTab
            milestones={milestones}
            archivedCount={view.archived.length}
            selectedId={milestoneId}
            onSelect={selectMilestone}
            newOpen={newOpen && tab === "milestones"}
            onNewOpenChange={setNewOpen}
          />
        </TabsContent>
        <TabsContent value="project-fields" className="flex min-h-0 flex-1 flex-col">
          <FieldsTab
            fields={fields}
            selectedId={fieldId}
            onSelect={selectField}
            newOpen={newOpen && tab === "project-fields"}
            onNewOpenChange={setNewOpen}
          />
        </TabsContent>
      </Tabs>
      <ShortcutsDialog open={helpOpen} onOpenChange={setHelpOpen} tab={tab} />
    </div>
  );
}

/** "Saving…" while library writes are queued or in flight, then "Saved" for two seconds after the last one. */
function SavingIndicator() {
  const { pending, lastOk } = usePendingWrites([QUEUE.library, QUEUE.fields]);
  const [prevPending, setPrevPending] = useState(pending);
  const [doneAt, setDoneAt] = useState(0);
  const [showDone, setShowDone] = useState(false);
  if (pending !== prevPending) {
    setPrevPending(pending);
    if (pending === 0 && prevPending > 0) setDoneAt(Date.now());
  }
  useEffect(() => {
    if (!doneAt) return;
    setShowDone(true);
    const t = setTimeout(() => setShowDone(false), lastOk ? 2000 : 5000);
    return () => clearTimeout(t);
  }, [doneAt, lastOk]);

  return (
    <span className="flex h-8 items-center gap-1.5 px-1 text-xs text-muted-foreground" role="status" aria-live="polite">
      {pending > 0 ? (
        <>
          <Loader2 className="size-3.5 animate-spin" aria-hidden /> Saving…
        </>
      ) : showDone && lastOk ? (
        <>
          <Check className="size-3.5 text-[var(--state-d-solid)]" aria-hidden /> Saved
        </>
      ) : showDone ? (
        <span className="flex items-center gap-1.5 text-destructive">
          <TriangleAlert className="size-3.5" aria-hidden /> Not saved
        </span>
      ) : null}
    </span>
  );
}

const SHORTCUTS: Record<LibraryTab, [string[], string][]> = {
  milestones: [
    [["N"], "New milestone"],
    [["/"], "Search"],
    [["J", "K"], "Next / previous row (follows in the panel)"],
    [["↑", "↓"], "Move between rows"],
    [["Enter"], "Rename the selected row"],
    [["O"], "Open the row in the side panel"],
    [["Alt", "↑ / ↓"], "Move the row up or down"],
    [["Esc"], "Close the panel / clear the search"],
    [["?"], "Show these shortcuts"],
  ],
  "project-fields": [
    [["N"], "New field"],
    [["/"], "Search"],
    [["J", "K"], "Next / previous row"],
    [["↑", "↓"], "Move between rows"],
    [["Enter"], "Rename the selected row"],
    [["O"], "Open the row in the side panel"],
    [["Alt", "↑ / ↓"], "Move the field up or down (form order)"],
    [["Esc"], "Close the panel / clear the search"],
    [["?"], "Show these shortcuts"],
  ],
};

function ShortcutsDialog({ open, onOpenChange, tab }: { open: boolean; onOpenChange: (o: boolean) => void; tab: LibraryTab }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>{tab === "milestones" ? "Milestones" : "Project fields"} tab</DialogDescription>
        </DialogHeader>
        <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 text-[13px]">
          {SHORTCUTS[tab].map(([keys, what]) => (
            <div key={what} className="contents">
              <dt className="flex items-center gap-1">
                {keys.map((k) => (
                  <Kbd key={k} className="h-5 min-w-5 text-[11px]">
                    {k}
                  </Kbd>
                ))}
              </dt>
              <dd className="text-muted-foreground">{what}</dd>
            </div>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  );
}
