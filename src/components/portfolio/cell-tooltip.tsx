"use client";

import { useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { Loader2, StickyNote } from "lucide-react";
import { formatInstant, formatRelative } from "@/domain/dates";
import { stateFromCode } from "@/domain/state";
import type { CellDetails, PortfolioCell, PortfolioColumn, PortfolioRow } from "@/server/queries";
import { StateBadge } from "@/components/state/state-badge";
import { cellDetailsAction } from "@/app/(app)/portfolio/actions";
import { callAction } from "@/components/shell/action-call";

export type TipTarget =
  | { kind: "cell"; rect: DOMRect; row: PortfolioRow; column: PortfolioColumn; cell: PortfolioCell }
  | { kind: "missing"; rect: DOMRect; row: PortfolioRow; column: PortfolioColumn }
  | { kind: "other"; rect: DOMRect; row: PortfolioRow }
  | { kind: "header"; rect: DOMRect; column: PortfolioColumn | null };

export interface GridTooltipHandle {
  show(target: TipTarget): void;
  hide(): void;
}

/** Hover time before the tooltip loads last changed + latest note. */
const DETAILS_DELAY_MS = 150;
const GAP = 8;

/** "3d ago · 22 Oct 2026, 14:05", or just the date and time once it is older than a month. */
function whenText(iso: string, now: string, timeZone: string): string {
  const rel = formatRelative(iso, now, timeZone);
  const abs = formatInstant(iso, timeZone);
  return /ago$|just now/.test(rel) ? `${rel} · ${abs}` : abs;
}

export function seqLabel(seq: number): string {
  return String(seq).padStart(2, "0");
}

/**
 * The ONE tooltip of the Portfolio grid (cells and headers report through `show`/`hide`; nothing in the grid
 * re-renders on hover). Value and state come from the grid data; last changed and the latest note load lazily.
 */
export function GridTooltip({
  ref,
  now,
  timeZone,
  cacheKey,
}: {
  ref: React.Ref<GridTooltipHandle>;
  now: string;
  timeZone: string;
  /** Changes when the grid data is reloaded (the details cache is dropped then). */
  cacheKey: string;
}) {
  const [target, setTarget] = useState<TipTarget | null>(null);
  const [details, setDetails] = useState<{ stepId: string; data: CellDetails | null; failed?: boolean } | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const timer = useRef<number | null>(null);
  const cache = useRef(new Map<string, CellDetails | null>());
  const currentStep = useRef<string | null>(null);
  const lastKey = useRef(cacheKey);
  if (lastKey.current !== cacheKey) {
    lastKey.current = cacheKey;
    cache.current = new Map();
  }

  useImperativeHandle(
    ref,
    () => ({
      show(t) {
        if (timer.current) window.clearTimeout(timer.current);
        setTarget(t);
        const stepId = t.kind === "cell" ? t.cell.id : null;
        currentStep.current = stepId;
        if (!stepId) {
          setDetails(null);
          return;
        }
        if (cache.current.has(stepId)) {
          setDetails({ stepId, data: cache.current.get(stepId) ?? null });
          return;
        }
        setDetails(null);
        timer.current = window.setTimeout(async () => {
          const r = await callAction(() => cellDetailsAction(stepId), { retries: 1 });
          if (r.ok) cache.current.set(stepId, r.data);
          if (currentStep.current === stepId) setDetails({ stepId, data: r.ok ? r.data : null, failed: !r.ok });
        }, DETAILS_DELAY_MS);
      },
      hide() {
        if (timer.current) window.clearTimeout(timer.current);
        currentStep.current = null;
        setTarget(null);
        setPos(null);
      },
    }),
    [],
  );

  // Place next to the anchor, flipping to stay on screen.
  useLayoutEffect(() => {
    if (!target || !box.current) return;
    const r = target.rect;
    const w = box.current.offsetWidth;
    const h = box.current.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = target.kind === "header" ? r.left + r.width / 2 - w / 2 : r.right + GAP;
    let top = target.kind === "header" ? r.bottom + GAP : r.top - 4;
    if (left + w > vw - GAP) left = target.kind === "header" ? vw - GAP - w : r.left - GAP - w;
    if (left < GAP) left = GAP;
    if (top + h > vh - GAP) top = Math.max(GAP, vh - GAP - h);
    setPos({ left, top });
  }, [target, details]);

  if (!target) return null;

  const loadingDetails = target.kind === "cell" && (!details || details.stepId !== target.cell.id);
  const d = target.kind === "cell" && details?.stepId === target.cell.id ? details : null;

  return (
    <div
      ref={box}
      role="tooltip"
      className="pointer-events-none fixed z-50 w-72 rounded-lg border bg-popover p-2.5 text-xs text-popover-foreground shadow-lg"
      style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999 }}
    >
      {target.kind === "header" ? (
        target.column ? (
          <div className="space-y-0.5">
            <div className="text-[11px] text-muted-foreground">Milestone {seqLabel(target.column.seq)} in the Template Flow</div>
            <div className="text-[13px] font-medium">{target.column.name}</div>
          </div>
        ) : (
          <div className="space-y-0.5">
            <div className="text-[13px] font-medium">Other steps</div>
            <div className="text-muted-foreground">
              Project-only steps and steps that are no longer in the template, coloured by their worst state.
            </div>
          </div>
        )
      ) : (
        <div className="space-y-1.5">
          <div className="flex items-baseline gap-1.5">
            <span className="font-mono text-[11px] font-semibold">{target.row.code}</span>
            <span className="truncate text-muted-foreground">{target.row.name}</span>
          </div>
          {target.kind === "other" ? (
            <>
              <div className="text-[13px] font-medium">Other steps</div>
              {target.row.other.count ? (
                <div className="flex items-center gap-1.5">
                  {target.row.other.worst ? <StateBadge state={stateFromCode(target.row.other.worst)} /> : null}
                  <span className="text-muted-foreground">
                    {target.row.other.count} project-only or not-in-template {target.row.other.count === 1 ? "step" : "steps"} · worst state
                  </span>
                </div>
              ) : (
                <div className="text-muted-foreground">No project-only steps.</div>
              )}
            </>
          ) : (
            <>
              <div className="text-[13px] leading-snug font-medium">
                <span className="text-muted-foreground tabular-nums">{seqLabel(target.column.seq)}</span> {target.column.name}
              </div>
              {target.kind === "missing" ? (
                <div className="text-muted-foreground">
                  {target.row.status === "CLOSED"
                    ? "Not in this project (added to the template after it closed)."
                    : "Not in this project · sync: open the project and use Sync from template to add it."}
                </div>
              ) : (
                <>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <StateBadge state={stateFromCode(target.cell.s)} />
                    <span className="font-medium tabular-nums">{d?.data?.display ?? target.cell.v}</span>
                    {target.cell.cur ? (
                      <span className="inline-flex items-center gap-1 text-[11px] text-[var(--current-ring)]">
                        <span className="size-1.5 rounded-full bg-[var(--current-ring)]" aria-hidden />
                        Current
                      </span>
                    ) : null}
                  </div>
                  {d?.data?.reasonText ? <div className="text-[11px] text-muted-foreground">{d.data.reasonText}</div> : null}
                  <div className="border-t pt-1.5 text-[11px] text-muted-foreground">
                    {loadingDetails ? (
                      <span className="inline-flex items-center gap-1">
                        <Loader2 className="size-3 animate-spin" aria-hidden /> Loading last change and note…
                      </span>
                    ) : d?.failed ? (
                      "Couldn't load the details. Hover again to retry."
                    ) : d?.data ? (
                      <div className="space-y-1">
                        <div>
                          Last changed{" "}
                          {d.data.lastChangedAt ? (
                            <span className="text-foreground">{whenText(d.data.lastChangedAt, now, timeZone)}</span>
                          ) : (
                            "never"
                          )}
                        </div>
                        {d.data.latestNote ? (
                          <div className="flex gap-1.5 text-foreground">
                            <StickyNote className="mt-0.5 size-3 shrink-0 text-muted-foreground" aria-hidden />
                            <span className="line-clamp-4">
                              {d.data.latestNote.body}
                              <span className="text-muted-foreground">
                                {" "}
                                · {d.data.latestNote.author}, {formatRelative(d.data.latestNote.createdAt, now, timeZone)}
                              </span>
                            </span>
                          </div>
                        ) : (
                          <div>No notes</div>
                        )}
                      </div>
                    ) : (
                      "This milestone was removed from the project."
                    )}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
