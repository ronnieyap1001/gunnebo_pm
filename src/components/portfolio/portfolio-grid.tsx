"use client";

import { memo, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { Clock } from "lucide-react";
import { STATE_META, stateFromCode } from "@/domain/state";
import type { StateCode } from "@/domain/types";
import type { PortfolioColumn, PortfolioRow } from "@/server/queries";
import { cn } from "@/lib/utils";
import { ProgressMini } from "@/components/projects/status-pill";
import { seqLabel, type GridTooltipHandle, type TipTarget } from "./cell-tooltip";

/** Cell box: 20×20, with scroll margins so keyboard focus never hides under the sticky header or left block. */
const CELL =
  "relative mx-auto flex size-5 items-center justify-center rounded-[3px] outline-none scroll-mt-[176px] scroll-ml-[312px] scroll-mr-2 scroll-mb-2 hover:ring-1 hover:ring-foreground/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background";

const FILL: Record<StateCode, string> = {
  NS: "state-ns border border-[var(--s-border)] bg-[var(--s-bg)]",
  IP: "state-ip bg-[var(--s-solid)]",
  W: "state-w bg-[var(--s-solid)]",
  B: "state-b bg-[var(--s-solid)]",
  D: "state-d bg-[var(--s-solid)]",
  NA: "state-na border border-dashed border-[var(--s-border)]",
};

export const HATCH_STYLE: React.CSSProperties = {
  backgroundImage:
    "repeating-linear-gradient(135deg, color-mix(in oklch, var(--muted-foreground) 55%, transparent) 0 1.5px, transparent 1.5px 4.5px)",
};

/** Readable text on each fill, in both themes. */
const ON_FILL_TEXT: Record<StateCode, string> = {
  NS: "text-[var(--s-fg)]",
  IP: "text-[var(--s-bg)]",
  W: "text-[var(--state-w-fg)] dark:text-[var(--state-w-bg)]",
  B: "text-[var(--s-bg)]",
  D: "text-[var(--s-bg)]",
  NA: "text-[var(--s-fg)]",
};

const CURRENT_DOT = "pointer-events-none absolute size-2 rounded-full bg-[var(--current-ring)] ring-[1.5px] ring-background";

function Glyph({ s }: { s: StateCode }) {
  // A second signal besides colour for the two states that need attention.
  if (s === "B")
    return (
      <span aria-hidden className="text-[11px] leading-none font-bold text-[var(--state-b-bg)]">
        !
      </span>
    );
  if (s === "W") return <Clock aria-hidden strokeWidth={2.75} className="size-3 text-[var(--state-w-fg)] dark:text-[var(--state-w-bg)]" />;
  return null;
}

function cellHref(projectId: string, stepId: string): string {
  return `/projects/${encodeURIComponent(projectId)}?view=flow&node=${encodeURIComponent(stepId)}`;
}

interface GridProps {
  columns: PortfolioColumn[];
  rows: PortfolioRow[];
  tooltip: React.RefObject<GridTooltipHandle | null>;
}

/**
 * Portfolio grid: a plain table with a sticky header (vertical, numbered milestone names) and a sticky left block.
 * Every cell is a link to `/projects/{id}?view=flow&node={stepId}`. One delegated set of listeners handles the
 * tooltip, clicks and the roving keyboard focus (arrow keys, Home/End, Enter), so hovering never re-renders it.
 */
export const PortfolioGrid = memo(function PortfolioGrid({ columns, rows, tooltip }: GridProps) {
  const router = useRouter();
  const scroller = useRef<HTMLDivElement>(null);
  const hovered = useRef<Element | null>(null);
  const otherCol = columns.length;

  const targetFor = useCallback(
    (el: HTMLElement): TipTarget | null => {
      const rect = el.getBoundingClientRect();
      if (el.dataset.h !== undefined) {
        const ci = Number(el.dataset.h);
        return { kind: "header", rect, column: ci >= 0 && ci < columns.length ? columns[ci] : null };
      }
      const row = rows[Number(el.dataset.r)];
      if (!row) return null;
      const ci = Number(el.dataset.c);
      if (ci === otherCol) return { kind: "other", rect, row };
      const column = columns[ci];
      if (!column) return null;
      const cell = row.cells[ci];
      return cell ? { kind: "cell", rect, row, column, cell } : { kind: "missing", rect, row, column };
    },
    [columns, rows, otherCol],
  );

  function tipFrom(target: EventTarget | null): HTMLElement | null {
    return target instanceof Element ? target.closest<HTMLElement>("[data-r][data-c],[data-h]") : null;
  }

  function onPointerOver(e: React.PointerEvent) {
    if (e.pointerType === "touch") return;
    const el = tipFrom(e.target);
    if (el === hovered.current) return;
    hovered.current = el;
    const t = el ? targetFor(el) : null;
    if (t) tooltip.current?.show(t);
    else tooltip.current?.hide();
  }

  function onPointerLeave() {
    hovered.current = null;
    tooltip.current?.hide();
  }

  function focusCell(r: number, c: number) {
    const root = scroller.current;
    if (!root) return;
    const next = root.querySelector<HTMLElement>(`[data-r="${r}"][data-c="${c}"]`);
    if (!next) return;
    root.querySelectorAll<HTMLElement>('[data-r][data-c][tabindex="0"]').forEach((el) => {
      if (el !== next) el.tabIndex = -1;
    });
    next.tabIndex = 0;
    next.focus();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.altKey || e.metaKey) return;
    const el = e.target instanceof HTMLElement ? e.target.closest<HTMLElement>("[data-r][data-c]") : null;
    if (!el) return;
    let r = Number(el.dataset.r);
    let c = Number(el.dataset.c);
    const lastRow = rows.length - 1;
    switch (e.key) {
      case "ArrowRight":
        c = Math.min(otherCol, c + 1);
        break;
      case "ArrowLeft":
        c = Math.max(0, c - 1);
        break;
      case "ArrowDown":
        r = Math.min(lastRow, r + 1);
        break;
      case "ArrowUp":
        r = Math.max(0, r - 1);
        break;
      case "Home":
        c = 0;
        if (e.ctrlKey) r = 0;
        break;
      case "End":
        c = otherCol;
        if (e.ctrlKey) r = lastRow;
        break;
      case "PageDown":
        r = Math.min(lastRow, r + 10);
        break;
      case "PageUp":
        r = Math.max(0, r - 10);
        break;
      case "Escape":
        tooltip.current?.hide();
        return;
      default:
        return;
    }
    e.preventDefault();
    focusCell(r, c);
  }

  function onFocus(e: React.FocusEvent) {
    const el = tipFrom(e.target);
    if (!el || el.dataset.r === undefined) return;
    // Roving tabindex: the last focused cell is the one Tab returns to.
    scroller.current?.querySelectorAll<HTMLElement>('[data-r][data-c][tabindex="0"]').forEach((x) => {
      if (x !== el) x.tabIndex = -1;
    });
    el.tabIndex = 0;
    if (e.target instanceof HTMLElement && e.target.matches(":focus-visible")) {
      const t = targetFor(el);
      if (t) tooltip.current?.show(t);
    }
  }

  function onBlur(e: React.FocusEvent) {
    if (!tipFrom(e.relatedTarget)) tooltip.current?.hide();
  }

  function onClick(e: React.MouseEvent) {
    const a = e.target instanceof Element ? e.target.closest<HTMLAnchorElement>("a[href]") : null;
    if (!a || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    tooltip.current?.hide();
    router.push(a.getAttribute("href")!);
  }

  return (
    <div
      ref={scroller}
      className="relative min-h-0 flex-1 overflow-auto overscroll-contain"
      onPointerOver={onPointerOver}
      onPointerLeave={onPointerLeave}
      onScroll={() => tooltip.current?.hide()}
      onKeyDown={onKeyDown}
      onFocus={onFocus}
      onBlur={onBlur}
      onClick={onClick}
    >
      <table
        className="border-separate border-spacing-0 text-xs"
        aria-label="Portfolio: projects by milestone"
        aria-rowcount={rows.length + 1}
      >
        <thead>
          <tr>
            <th
              scope="col"
              className="sticky top-0 left-0 z-30 h-[168px] w-[300px] min-w-[300px] border-r border-b bg-background px-3 pb-2 text-left align-bottom font-medium text-muted-foreground"
            >
              <div className="flex items-end justify-between">
                <span>Project</span>
                <span>% done</span>
              </div>
            </th>
            {columns.map((col, ci) => (
              <th
                key={col.milestoneId}
                scope="col"
                data-h={ci}
                className={cn(
                  "sticky top-0 z-20 h-[168px] w-[22px] min-w-[22px] border-b bg-background p-0 align-bottom font-normal",
                  col.seq % 10 === 0 && "border-r border-r-border/60",
                )}
              >
                <div className="flex h-[164px] w-[22px] items-end justify-center pb-1.5">
                  <span className="max-h-[156px] rotate-180 truncate text-[11px] leading-[22px] whitespace-nowrap text-muted-foreground [writing-mode:vertical-rl]">
                    <span className="font-medium text-foreground tabular-nums">{seqLabel(col.seq)}</span> {col.name}
                  </span>
                </div>
              </th>
            ))}
            <th
              scope="col"
              data-h={-1}
              className="sticky top-0 z-20 h-[168px] w-[34px] min-w-[34px] border-b border-l bg-background p-0 pr-2 align-bottom font-normal"
            >
              <div className="flex h-[164px] items-end justify-center pb-1.5">
                <span className="rotate-180 text-[11px] leading-[22px] font-medium text-foreground [writing-mode:vertical-rl]">Other</span>
              </div>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={row.projectId} className="group/row">
              <th
                scope="row"
                className="sticky left-0 z-10 h-9 w-[300px] min-w-[300px] max-w-[300px] border-r border-b border-b-border/60 bg-background px-3 py-1 text-left font-normal group-hover/row:bg-muted"
              >
                <div className="flex items-center gap-2">
                  <a
                    href={`/projects/${encodeURIComponent(row.projectId)}`}
                    tabIndex={-1}
                    className="w-[66px] shrink-0 truncate font-mono text-[11px] font-semibold hover:underline"
                    title={row.code}
                  >
                    {row.code}
                  </a>
                  <div className="min-w-0 flex-1 leading-tight">
                    <div className="truncate text-[12.5px]" title={row.name}>
                      {row.name}
                    </div>
                    <div className="truncate text-[11px] text-muted-foreground">
                      {row.customer ?? "No customer"}
                      {row.status !== "ACTIVE" ? <> · {row.status === "ON_HOLD" ? "On hold" : "Closed"}</> : null}
                    </div>
                  </div>
                  <ProgressMini
                    pct={row.progress.pct}
                    done={row.progress.done}
                    applicable={row.progress.applicable}
                    barClassName="w-8"
                    className="shrink-0 gap-1"
                  />
                </div>
              </th>
              {row.cells.map((cell, ci) => {
                const col = columns[ci];
                const first = ri === 0 && ci === 0;
                const tenth = col.seq % 10 === 0;
                if (!cell) {
                  const closed = row.status === "CLOSED";
                  return (
                    <td
                      key={col.milestoneId}
                      className={cn("border-b border-b-border/60 p-px group-hover/row:bg-muted", tenth && "border-r border-r-border/60")}
                    >
                      <a
                        href={`/projects/${encodeURIComponent(row.projectId)}`}
                        data-r={ri}
                        data-c={ci}
                        tabIndex={first ? 0 : -1}
                        aria-label={`${row.code}, ${seqLabel(col.seq)} ${col.name}: ${closed ? "not in this project" : "not in this project, sync from template to add it"}`}
                        className={cn(CELL, !closed && "border border-border")}
                        style={closed ? undefined : HATCH_STYLE}
                      >
                        {closed ? <span className="text-muted-foreground/70">—</span> : null}
                      </a>
                    </td>
                  );
                }
                const label = STATE_META[stateFromCode(cell.s)].label;
                return (
                  <td
                    key={col.milestoneId}
                    className={cn("border-b border-b-border/60 p-px group-hover/row:bg-muted", tenth && "border-r border-r-border/60")}
                  >
                    <a
                      href={cellHref(row.projectId, cell.id)}
                      data-r={ri}
                      data-c={ci}
                      tabIndex={first ? 0 : -1}
                      aria-label={`${row.code}, ${seqLabel(col.seq)} ${col.name}: ${cell.v && cell.v !== "—" ? `${cell.v}, ` : ""}${label}${cell.cur ? ", current" : ""}`}
                      className={cn(CELL, FILL[cell.s])}
                    >
                      <Glyph s={cell.s} />
                      {cell.cur ? <span className={CURRENT_DOT} aria-hidden /> : null}
                    </a>
                  </td>
                );
              })}
              <td className="border-b border-l border-b-border/60 p-px pr-2 group-hover/row:bg-muted">
                {row.other.count && row.other.stepIds[0] ? (
                  <a
                    href={cellHref(row.projectId, row.other.stepIds[0])}
                    data-r={ri}
                    data-c={otherCol}
                    tabIndex={-1}
                    aria-label={`${row.code}, other steps: ${row.other.count}${row.other.worst ? `, worst ${STATE_META[stateFromCode(row.other.worst)].label}` : ""}`}
                    className={cn(
                      CELL,
                      "w-auto min-w-5 px-1 text-[10px] font-semibold tabular-nums",
                      FILL[row.other.worst ?? "NS"],
                      ON_FILL_TEXT[row.other.worst ?? "NS"],
                    )}
                  >
                    {row.other.count}
                  </a>
                ) : (
                  <span
                    data-r={ri}
                    data-c={otherCol}
                    tabIndex={-1}
                    aria-label={`${row.code}, no other steps`}
                    className={cn(CELL, "text-muted-foreground/50")}
                  >
                    ·
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
});
