"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import type { HistoryItemDTO } from "@/server/queries";
import { stepHistoryAction } from "@/app/(app)/projects/[id]/actions";
import { Button } from "@/components/ui/button";
import { useProject } from "./context";
import { useNow } from "./format";
import { StepHistoryLine } from "./history-row";
import { useQueueIdleTick } from "./use-queue";
import { read } from "./write";

const FIRST = 5;
const PAGE = 25;

/** The step's last 5 History rows; "Show all" pages through the rest. Refreshes after every saved change. */
export function StepHistory({ stepId }: { stepId: string }) {
  const { projectId, raw, timeZone, displayName } = useProject();
  const tick = useQueueIdleTick(projectId);
  const now = useNow();
  const [items, setItems] = useState<HistoryItemDTO[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const req = useRef(0);
  const allRef = useRef(all);
  allRef.current = all;

  const load = useCallback(
    async (showAll: boolean) => {
      const n = ++req.current;
      const r = await read(() => stepHistoryAction(stepId, null, showAll ? PAGE : FIRST));
      if (n !== req.current) return;
      if (r.ok) {
        setItems(r.data.items);
        setCursor(r.data.nextCursor);
        setError(null);
      } else {
        setError(r.error);
      }
    },
    [stepId],
  );

  useEffect(() => {
    setItems(null);
    setAll(false);
    void load(false);
  }, [stepId, load]);

  // A saved change adds a row: refetch what is shown (first page only, so "Load more" keeps working).
  useEffect(() => {
    if (tick > 0) void load(allRef.current);
  }, [tick, load]);

  async function more() {
    setLoadingMore(true);
    if (!all) {
      setAll(true);
      await load(true);
      setLoadingMore(false);
      return;
    }
    const n = ++req.current;
    const r = await read(() => stepHistoryAction(stepId, cursor, PAGE));
    setLoadingMore(false);
    if (n !== req.current) return;
    if (r.ok) {
      setItems((prev) => [...(prev ?? []), ...r.data.items.filter((x) => !(prev ?? []).some((p) => p.id === x.id))]);
      setCursor(r.data.nextCursor);
    } else setError(r.error);
  }

  if (error && !items) {
    return (
      <div className="flex items-center gap-2 text-xs text-destructive">
        {error}
        <Button size="xs" variant="outline" onClick={() => void load(all)}>
          Try again
        </Button>
      </div>
    );
  }
  if (!items) {
    return (
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="size-3 animate-spin" aria-hidden /> Loading history…
      </p>
    );
  }
  if (!items.length) return <p className="text-xs text-muted-foreground">No changes yet.</p>;

  return (
    <div>
      <ul className="divide-y divide-border/60">
        {items.map((i) => (
          <StepHistoryLine key={i.id} item={i} timeZone={timeZone} displayName={displayName} code={raw.project.code} now={now} />
        ))}
      </ul>
      {cursor || (!all && items.length >= FIRST) ? (
        <Button size="xs" variant="ghost" className="mt-1 text-muted-foreground" onClick={() => void more()} disabled={loadingMore}>
          {loadingMore ? <Loader2 className="animate-spin" aria-hidden /> : null}
          {all ? "Load more" : "Show all"}
        </Button>
      ) : null}
    </div>
  );
}
