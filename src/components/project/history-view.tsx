"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import type { EventSource } from "@/domain/types";
import { formatInstant } from "@/domain/dates";
import type { HistoryItemDTO } from "@/server/queries";
import { projectHistoryAction } from "@/app/(app)/projects/[id]/actions";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/common/empty-state";
import { useProject } from "./context";
import { eventLabel, HISTORY_TYPE_FILTERS, SOURCE_LABELS } from "./event-types";
import { stripCode } from "./format";
import { actorLabel, OldNew, SourceIcon } from "./history-row";
import { useQueueIdleTick } from "./use-queue";
import { read } from "./write";

const ALL = "all";

/**
 * The change itself: "Awaiting → LOI received" styled when the summary says no more than that, otherwise the
 * summary (with the step name dropped when the What column shows it) and the old → new values under it.
 */
function ChangeText({
  summary,
  stepName,
  oldDisplay,
  newDisplay,
}: {
  summary: string;
  stepName: string | null;
  oldDisplay: string | null;
  newDisplay: string | null;
}) {
  let text = summary;
  if (stepName && text.startsWith(`${stepName}: `)) text = text.slice(stepName.length + 2);
  const hasValues = Boolean(oldDisplay || newDisplay);
  const plain = `${oldDisplay ?? "—"} → ${newDisplay ?? "—"}`;
  const said = (v: string | null) => !v || text.includes(v);
  if (hasValues && (text === plain || text.startsWith(`${plain} (`))) {
    return (
      <span className="flex flex-wrap items-center gap-x-2">
        <OldNew oldDisplay={oldDisplay} newDisplay={newDisplay} />
        {text !== plain ? <span className="text-xs text-muted-foreground">{text.slice(plain.length).trim()}</span> : null}
      </span>
    );
  }
  return (
    <span className="block">
      <span className="block">{text}</span>
      {hasValues && !(said(oldDisplay) && said(newDisplay)) ? (
        <OldNew oldDisplay={oldDisplay} newDisplay={newDisplay} className="mt-0.5 text-xs" />
      ) : null}
    </span>
  );
}

/** The project's change log, newest first, 50 per page, filtered by type and source. */
export function HistoryView() {
  const { projectId, raw, view, timeZone, displayName, openStep } = useProject();
  const [type, setType] = useState<string>(ALL);
  const [source, setSource] = useState<string>(ALL);
  const [items, setItems] = useState<HistoryItemDTO[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tick = useQueueIdleTick(projectId);
  const req = useRef(0);

  const filters = useCallback(
    () => ({ type: type === ALL ? undefined : type, source: source === ALL ? undefined : (source as EventSource) }),
    [type, source],
  );

  const load = useCallback(async () => {
    const n = ++req.current;
    setLoading(true);
    const r = await read(() => projectHistoryAction(projectId, filters(), null));
    if (n !== req.current) return;
    setLoading(false);
    if (r.ok) {
      setItems(r.data.items);
      setCursor(r.data.nextCursor);
      setError(null);
    } else setError(r.error);
  }, [projectId, filters]);

  useEffect(() => {
    setItems(null);
    void load();
  }, [load]);

  useEffect(() => {
    if (tick > 0) void load();
  }, [tick, load]);

  async function more() {
    if (!cursor) return;
    const n = ++req.current;
    setLoading(true);
    const r = await read(() => projectHistoryAction(projectId, filters(), cursor));
    if (n !== req.current) return;
    setLoading(false);
    if (r.ok) {
      setItems((prev) => {
        const seen = new Set((prev ?? []).map((x) => x.id));
        return [...(prev ?? []), ...r.data.items.filter((x) => !seen.has(x.id))];
      });
      setCursor(r.data.nextCursor);
    } else setError(r.error);
  }

  const stepName = (id: string | null) => (id ? (view.byId.get(id)?.name ?? raw.archivedSteps.find((s) => s.id === id)?.name ?? null) : null);
  const filtered = type !== ALL || source !== ALL;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
        <Select value={type} onValueChange={setType}>
          <SelectTrigger size="sm" className="h-7 w-52 text-xs" aria-label="Type of change">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All changes</SelectItem>
            {HISTORY_TYPE_FILTERS.map((f) => (
              <SelectItem key={f.value} value={f.value}>
                {f.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={source} onValueChange={setSource}>
          <SelectTrigger size="sm" className="h-7 w-40 text-xs" aria-label="Made by">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Any source</SelectItem>
            {(Object.keys(SOURCE_LABELS) as EventSource[]).map((s) => (
              <SelectItem key={s} value={s}>
                {SOURCE_LABELS[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {filtered ? (
          <Button
            size="xs"
            variant="ghost"
            onClick={() => {
              setType(ALL);
              setSource(ALL);
            }}
          >
            Clear filters
          </Button>
        ) : null}
        <div className="flex-1" />
        <span className="text-[11px] text-muted-foreground">Times in {timeZone.replace(/_/g, " ")}</span>
        <Button size="icon-sm" variant="ghost" aria-label="Refresh history" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={cn(loading && "animate-spin")} aria-hidden />
        </Button>
      </div>

      <div className="relative min-h-0 flex-1 overflow-auto">
        {error && !items ? (
          <EmptyState
            title="History could not be loaded"
            action={
              <Button size="sm" variant="outline" onClick={() => void load()}>
                Try again
              </Button>
            }
          >
            {error}
          </EmptyState>
        ) : !items ? (
          <div className="space-y-2 p-4" aria-busy="true" aria-label="Loading history">
            {Array.from({ length: 10 }, (_, i) => (
              <Skeleton key={i} className="h-7 w-full" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <EmptyState title={filtered ? "Nothing matches these filters" : "No history yet"}>
            {filtered ? "Try another type or source." : "Every change to this project will be listed here."}
          </EmptyState>
        ) : (
          <>
            <table className="w-full table-fixed border-separate border-spacing-0 text-sm">
              <colgroup>
                <col className="w-40" />
                <col className="w-28" />
                <col className="w-52" />
                <col />
              </colgroup>
              <thead className="sticky top-0 z-10 bg-background text-left text-xs text-muted-foreground">
                <tr className="[&>th]:h-8 [&>th]:border-b [&>th]:px-3 [&>th]:font-medium">
                  <th>When</th>
                  <th>Who</th>
                  <th>What</th>
                  <th>Change</th>
                </tr>
              </thead>
              <tbody>
                {items.map((h) => {
                  const name = h.stepIds.length > 1 ? `${h.stepIds.length} milestones` : stepName(h.stepId);
                  const clickable = h.stepIds.length === 1 && view.byId.has(h.stepIds[0]);
                  return (
                    <tr
                      key={h.id}
                      className={cn("[&>td]:border-b [&>td]:border-border/60 [&>td]:px-3 [&>td]:py-1.5 [&>td]:align-top", clickable && "cursor-pointer hover:bg-muted/40")}
                      onClick={clickable ? () => openStep(h.stepIds[0]) : undefined}
                    >
                      <td className="text-xs whitespace-nowrap text-muted-foreground tabular-nums">
                        <time dateTime={h.occurredAt}>{formatInstant(h.occurredAt, timeZone)}</time>
                      </td>
                      <td className="text-xs">
                        <span className="inline-flex items-center gap-1">
                          <SourceIcon source={h.source} />
                          {actorLabel(h.actor, displayName)}
                        </span>
                      </td>
                      <td className="text-xs">
                        <div className="font-medium">{eventLabel(h.type)}</div>
                        {name ? <div className="truncate text-muted-foreground">{name}</div> : null}
                      </td>
                      <td className="text-sm [overflow-wrap:anywhere]">
                        <ChangeText summary={stripCode(h.summary, raw.project.code)} stepName={h.stepIds.length === 1 ? name : null} oldDisplay={h.oldDisplay} newDisplay={h.newDisplay} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="flex justify-center p-3">
              {cursor ? (
                <Button size="sm" variant="outline" onClick={() => void more()} disabled={loading}>
                  {loading ? <Loader2 className="animate-spin" aria-hidden /> : null}
                  Load more
                </Button>
              ) : (
                <span className="text-xs text-muted-foreground">
                  {items.length} change{items.length === 1 ? "" : "s"} · that&apos;s everything
                </span>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
