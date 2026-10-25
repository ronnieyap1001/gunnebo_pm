"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ArrowRight, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import type { SyncItemKind } from "@/domain/syncPlan";
import type { SyncPreview } from "@/server/services";
import { continueSyncAction, previewSyncAction, startSyncAction } from "@/app/(app)/projects/[id]/actions";
import { runJob } from "@/lib/run-job";
import { enqueue, newOpId } from "@/lib/write-queue";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { ProgressDialog } from "@/components/common/progress-dialog";
import { StateBadge } from "@/components/state/state-badge";
import { useProject } from "./context";
import { plural } from "./format";
import { attempt, queueKey, read, reportFailure, withRetry } from "./write";

const GROUPS: { kind: SyncItemKind; title: string; hint: string }[] = [
  { kind: "addNode", title: "New milestones", hint: "Added to this project's flow." },
  { kind: "linkExisting", title: "Link existing steps", hint: "A project step matches a new template milestone; it is linked and keeps its value, notes and history." },
  { kind: "updateDefinition", title: "Renamed or re-described", hint: "Name and description follow the template." },
  { kind: "updateChoices", title: "Choice changes", hint: "Choices are never removed: retired ones keep the values that use them." },
  { kind: "changeType", title: "Field type changes", hint: "Only applied when the value converts without loss." },
  { kind: "markNA", title: "No longer in the template", hint: "Optional: mark these not applicable here." },
  { kind: "addEdge", title: "New arrows", hint: "Arrows you removed yourself are never added back." },
  { kind: "removeEdge", title: "Removed arrows", hint: "Archived, never deleted." },
];

function setJobInUrl(opId: string | null) {
  const url = new URL(window.location.href);
  if (opId) {
    url.searchParams.set("job", opId);
    url.searchParams.set("kind", "sync");
  } else {
    url.searchParams.delete("job");
    url.searchParams.delete("kind");
  }
  window.history.replaceState(window.history.state, "", url.toString());
}

/** "Sync from template…": preview with checkboxes, then a resumable job with progress. */
export function SyncDialog({ open, onOpenChange, resumeOpId }: { open: boolean; onOpenChange: (o: boolean) => void; resumeOpId: string | null }) {
  const { projectId, raw, api } = useProject();
  const [preview, setPreview] = useState<SyncPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState<{ message: string; fraction?: number } | null>(null);
  const resumed = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const opId = newOpId();
    const r = await read(() => previewSyncAction(opId, projectId));
    setLoading(false);
    if (r.ok) {
      setPreview(r.data);
      setSelected(new Set(r.data.items.filter((i) => i.selectable && i.defaultChecked && !i.dismissed).map((i) => i.id)));
    } else {
      setError(r.error);
    }
  }, [projectId]);

  useEffect(() => {
    if (open) void load();
    else {
      setPreview(null);
      setError(null);
    }
  }, [open, load]);

  const runSync = useCallback(
    async (opId: string, startWith?: string[]) => {
      setRunning({ message: "Starting…", fraction: 0 });
      setJobInUrl(opId);
      const result = await enqueue(queueKey(projectId), async () => {
        if (startWith) {
          const s = await withRetry(() => startSyncAction(opId, { projectId, selectedIds: startWith }));
          if (!s.ok) return s;
        }
        return runJob(() => attempt(() => continueSyncAction(opId)), {
          onProgress: (p) => setRunning({ message: p.message, fraction: p.fraction }),
        });
      });
      setRunning(null);
      if (result.ok) {
        setJobInUrl(null);
        await api.reload();
        const n = startWith?.length ?? 0;
        toast.success("Synced from template", { description: startWith ? (n ? `${plural(n, "change")} applied.` : "The project is marked up to date.") : "The sync finished." });
        return true;
      }
      if (result.code === "STALE_PLAN") {
        setJobInUrl(null);
        toast.error(result.error);
        onOpenChange(true);
        await load();
        return false;
      }
      if (result.code === "NOT_FOUND") setJobInUrl(null);
      reportFailure(result, () => void runSync(opId, startWith));
      return false;
    },
    [projectId, api, load, onOpenChange],
  );

  // Resume a sync that was running when the page was closed or reloaded (?job=…&kind=sync).
  useEffect(() => {
    if (!resumeOpId || resumed.current) return;
    resumed.current = true;
    void runSync(resumeOpId);
  }, [resumeOpId, runSync]);

  const grouped = useMemo(() => {
    const items = preview?.items ?? [];
    return GROUPS.map((g) => ({ ...g, items: items.filter((i) => i.kind === g.kind) })).filter((g) => g.items.length);
  }, [preview]);

  function toggle(id: string, on: boolean) {
    setSelected((s) => {
      const next = new Set(s);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function apply() {
    if (!preview) return;
    const ids = preview.items.filter((i) => i.selectable && selected.has(i.id)).map((i) => i.id);
    onOpenChange(false);
    void runSync(newOpId(), ids);
  }

  const selectable = preview?.items.filter((i) => i.selectable) ?? [];
  const count = selectable.filter((i) => selected.has(i.id)).length;
  const closed = raw.project.status === "CLOSED";

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="flex max-h-[85vh] flex-col gap-0 p-0 sm:max-w-2xl">
          <DialogHeader className="border-b p-4">
            <DialogTitle>Sync from template</DialogTitle>
            <DialogDescription>
              Brings template changes into {raw.project.code}. Values, notes, files, N/A marks, flags and your own steps and arrows are never changed.
            </DialogDescription>
          </DialogHeader>
          <div className="relative min-h-0 flex-1 overflow-y-auto p-4">
            {loading && !preview ? (
              <div className="space-y-2" aria-busy="true" aria-label="Checking the template">
                <Skeleton className="h-4 w-48" />
                {Array.from({ length: 5 }, (_, i) => (
                  <Skeleton key={i} className="h-10 w-full" />
                ))}
              </div>
            ) : error ? (
              <div className="flex flex-col items-center gap-2 py-8 text-center text-sm">
                <p className="text-destructive">{error}</p>
                <Button size="sm" variant="outline" onClick={() => void load()}>
                  <RefreshCw aria-hidden /> Try again
                </Button>
              </div>
            ) : preview ? (
              <div className="space-y-4">
                <p className="text-xs text-muted-foreground">
                  Template revision {preview.templateRevision}; this project was last synced at revision {preview.projectRevision}.
                </p>
                {closed ? (
                  <p className="flex items-start gap-1.5 rounded-md border border-[var(--state-w-border)] bg-[var(--state-w-bg)] px-3 py-2 text-xs text-[var(--state-w-fg)]">
                    <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden /> This project is Closed. New milestones will change its progress.
                  </p>
                ) : null}
                {preview.warnings.length ? (
                  <ul className="space-y-1 rounded-md border border-[var(--state-w-border)] bg-[var(--state-w-bg)] px-3 py-2 text-xs text-[var(--state-w-fg)]">
                    {preview.warnings.map((w) => (
                      <li key={w} className="flex items-start gap-1.5">
                        <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
                        {w}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {grouped.length === 0 ? (
                  <div className="py-8 text-center">
                    <p className="text-sm font-medium">This project is up to date with the template.</p>
                    {raw.sync.templateChanged ? (
                      <p className="mt-1 text-xs text-muted-foreground">The template changed, but nothing in it affects this project. Apply to mark it up to date.</p>
                    ) : null}
                  </div>
                ) : (
                  grouped.map((g) => {
                    const sel = g.items.filter((i) => i.selectable);
                    const all = sel.length > 0 && sel.every((i) => selected.has(i.id));
                    const some = sel.some((i) => selected.has(i.id));
                    return (
                      <section key={g.kind} aria-label={g.title} className="space-y-1.5">
                        <div className="flex items-center gap-2">
                          <Checkbox
                            checked={all ? true : some ? "indeterminate" : false}
                            disabled={!sel.length}
                            onCheckedChange={(v) => {
                              for (const i of sel) toggle(i.id, v === true);
                            }}
                            aria-label={`Select all: ${g.title}`}
                          />
                          <h3 className="text-sm font-semibold">{g.title}</h3>
                          <span className="text-xs text-muted-foreground tabular-nums">
                            {sel.filter((i) => selected.has(i.id)).length} of {g.items.length}
                          </span>
                        </div>
                        <p className="pl-6 text-[11px] text-muted-foreground">{g.hint}</p>
                        <ul className="divide-y rounded-md border">
                          {g.items.map((i) => (
                            <li key={i.id} className={cn("flex items-start gap-2 px-3 py-2", !i.selectable && "bg-muted/40")}>
                              <Checkbox
                                id={`sync-${i.id}`}
                                className="mt-0.5"
                                checked={i.selectable && selected.has(i.id)}
                                disabled={!i.selectable}
                                onCheckedChange={(v) => toggle(i.id, v === true)}
                              />
                              <label htmlFor={`sync-${i.id}`} className={cn("min-w-0 flex-1 text-sm", !i.selectable && "text-muted-foreground")}>
                                <span className="font-medium">{i.title}</span>
                                {i.dismissed ? (
                                  <span className="ml-1.5 rounded-full border px-1.5 text-[10px] text-muted-foreground">declined before</span>
                                ) : null}
                                {!i.selectable ? <span className="ml-1.5 rounded-full border px-1.5 text-[10px]">can&apos;t apply</span> : null}
                                {i.detail ? <span className="mt-0.5 block text-xs text-muted-foreground">{i.detail}</span> : null}
                              </label>
                              {i.stateChange ? (
                                <span className="flex shrink-0 items-center gap-1" aria-label={`Colour changes from ${i.stateChange.from} to ${i.stateChange.to}`}>
                                  <StateBadge state={i.stateChange.from} />
                                  <ArrowRight className="size-3 text-muted-foreground" aria-hidden />
                                  <StateBadge state={i.stateChange.to} />
                                </span>
                              ) : null}
                            </li>
                          ))}
                        </ul>
                      </section>
                    );
                  })
                )}
              </div>
            ) : null}
          </div>
          <DialogFooter className="mx-0 mb-0 items-center p-4 sm:justify-between">
            <p className="text-[11px] text-muted-foreground">Unticked changes are declined; they come back if the template changes them again.</p>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              {preview && grouped.length === 0 && !raw.sync.templateChanged ? (
                <Button onClick={() => onOpenChange(false)}>Done</Button>
              ) : (
                <Button onClick={apply} disabled={!preview || loading || Boolean(running)}>
                  {loading ? <Loader2 className="animate-spin" aria-hidden /> : null}
                  {grouped.length === 0 ? "Mark up to date" : count ? `Apply ${plural(count, "change")}` : "Decline all"}
                </Button>
              )}
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ProgressDialog open={Boolean(running)} title="Syncing from the template" message={running?.message ?? ""} fraction={running?.fraction} />
    </>
  );
}
