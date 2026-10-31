"use client";

import { CircleCheck, Unlink } from "lucide-react";
import type { MilestoneRow } from "@/server/queries";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Bottom strip: counts, and the milestones with no arrow in or out as chips that jump to them. */
export function InfoStrip({
  milestoneCount,
  arrowCount,
  unconnected,
  onPick,
}: {
  milestoneCount: number;
  arrowCount: number;
  unconnected: MilestoneRow[];
  onPick: (id: string) => void;
}) {
  return (
    <div className="flex min-h-9 shrink-0 items-center gap-3 border-t bg-background px-3 py-1 text-xs" aria-label="Template summary">
      <span className="shrink-0 text-muted-foreground tabular-nums">
        {plural(milestoneCount, "milestone")} · {plural(arrowCount, "arrow")}
      </span>
      {milestoneCount === 0 ? null : unconnected.length === 0 ? (
        <span className="flex items-center gap-1 text-muted-foreground">
          <CircleCheck className="size-3.5 text-[var(--state-d-solid)]" aria-hidden /> Every milestone is connected
        </span>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="flex shrink-0 items-center gap-1 font-medium text-[var(--state-w-fg)]">
            <Unlink className="size-3.5" aria-hidden />
            {plural(unconnected.length, "milestone")} without arrows:
          </span>
          <ul className="flex min-w-0 flex-1 gap-1 overflow-x-auto py-0.5" aria-label="Milestones without arrows">
            {unconnected.map((r) => (
              <li key={r.id} className="shrink-0">
                <button
                  type="button"
                  onClick={() => onPick(r.id)}
                  className="max-w-56 truncate rounded-md border border-dashed bg-background px-1.5 py-0.5 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
                  title={`Show “${r.name}”`}
                >
                  {r.seq !== null ? <span className="mr-1 text-muted-foreground tabular-nums">#{r.seq}</span> : null}
                  {r.name}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
