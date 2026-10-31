"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowUp, ChevronsUpDown, RefreshCw } from "lucide-react";
import { formatInstant, formatRelative } from "@/domain/dates";
import type { ProjectListRow } from "@/server/queries";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ProgressMini, StatusPill } from "./status-pill";

export interface SummaryColumn {
  fieldId: string;
  label: string;
  numeric: boolean;
  /** Free-text fields (End user, Site / country…): truncated, and only shown when the table has room. */
  wide: boolean;
  /** Shown from a medium table width up (Project type), so Name keeps room on a 1280 px screen. */
  medium?: boolean;
}

/** Free-text summary columns appear from this table width up. */
const WIDE_ONLY = "hidden @min-[1400px]:table-cell";
/** Lower-priority summary columns appear from this table width up. */
const MEDIUM_ONLY = "hidden @min-[1150px]:table-cell";
/** Choice and text summary cells truncate here (the full value is in the tooltip). */
const SUMMARY_MAX = "max-w-[140px]";

export type SortKey = "code" | "name" | "progress" | "updated" | "status";
export interface Sort {
  key: SortKey;
  dir: "asc" | "desc";
}

function SortHeader({
  label,
  k,
  sort,
  onSort,
  className,
}: {
  label: string;
  k: SortKey;
  sort: Sort;
  onSort: (k: SortKey) => void;
  className?: string;
}) {
  const active = sort.key === k;
  const Icon = !active ? ChevronsUpDown : sort.dir === "asc" ? ArrowUp : ArrowDown;
  return (
    <th
      scope="col"
      aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
      className={cn("h-9 px-2 text-left font-medium whitespace-nowrap", className)}
    >
      <button
        type="button"
        onClick={() => onSort(k)}
        className="-mx-1 inline-flex items-center gap-1 rounded px-1 py-0.5 hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        {label}
        <Icon className={cn("size-3", !active && "opacity-40")} aria-hidden />
      </button>
    </th>
  );
}

/** Dense projects table: one 32 px row per project; a row click (or Enter) opens the project. */
export function ProjectsTable({
  rows,
  columns,
  sort,
  onSort,
  now,
  timeZone,
}: {
  rows: ProjectListRow[];
  columns: SummaryColumn[];
  sort: Sort;
  onSort: (k: SortKey) => void;
  now: string;
  timeZone: string;
}) {
  const router = useRouter();

  function open(id: string, newTab: boolean) {
    const href = `/projects/${encodeURIComponent(id)}`;
    if (newTab) window.open(href, "_blank", "noopener");
    else router.push(href);
  }

  function onRowKeyDown(e: React.KeyboardEvent<HTMLTableRowElement>, id: string) {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter") {
      e.preventDefault();
      open(id, e.metaKey || e.ctrlKey);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const sibling = (
        e.key === "ArrowDown" ? e.currentTarget.nextElementSibling : e.currentTarget.previousElementSibling
      ) as HTMLElement | null;
      sibling?.focus();
    }
  }

  return (
    <div className="@container">
      <table className="w-full border-separate border-spacing-0 text-[13px]">
        <thead className="sticky top-0 z-10 bg-background text-xs text-muted-foreground">
          <tr className="[&>th]:border-b">
            <SortHeader label="Code" k="code" sort={sort} onSort={onSort} className="w-28 pl-4" />
            <SortHeader label="Name" k="name" sort={sort} onSort={onSort} />
            {columns.map((c) => (
              <th
                key={c.fieldId}
                scope="col"
                className={cn(
                  "h-9 px-2 text-left font-medium whitespace-nowrap",
                  c.numeric && "text-right",
                  c.wide && cn(WIDE_ONLY, "w-[11%]"),
                  c.medium && !c.wide && MEDIUM_ONLY,
                )}
              >
                {c.label}
              </th>
            ))}
            <SortHeader label="Status" k="status" sort={sort} onSort={onSort} />
            <SortHeader label="% done" k="progress" sort={sort} onSort={onSort} />
            <th scope="col" className="h-9 px-2 text-left font-medium whitespace-nowrap">
              Current milestone
            </th>
            <SortHeader label="Updated" k="updated" sort={sort} onSort={onSort} className="pr-4" />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const extra = r.currentNames.length - 1;
            const href = `/projects/${encodeURIComponent(r.id)}`;
            return (
              <tr
                key={r.id}
                tabIndex={0}
                data-project-row={r.id}
                aria-label={`${r.code} ${r.name}`}
                onClick={(e) => {
                  if ((e.target as HTMLElement).closest("a,button")) return;
                  open(r.id, e.metaKey || e.ctrlKey);
                }}
                onKeyDown={(e) => onRowKeyDown(e, r.id)}
                className="group h-8 cursor-pointer outline-none hover:bg-accent/50 focus-visible:bg-accent/60 focus-visible:shadow-[inset_2px_0_0_var(--ring)] [&>td]:border-b [&>td]:border-border/70"
              >
                <td className="pl-4 pr-2 whitespace-nowrap">
                  <Link href={href} prefetch={false} tabIndex={-1} className="font-mono text-xs font-semibold hover:underline">
                    {r.code}
                  </Link>
                </td>
                <td className="w-[26%] max-w-0 min-w-[180px] px-2">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate" title={r.name}>
                      {r.name}
                    </span>
                    {r.setup === "CREATING" ? (
                      <span className="state-w shrink-0 rounded-full border border-[var(--s-border)] bg-[var(--s-bg)] px-1.5 text-[10px] font-medium text-[var(--s-fg)]">
                        Setting up
                      </span>
                    ) : null}
                    {r.templateChanged ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="inline-flex shrink-0 items-center text-[var(--s-solid)] state-ip" tabIndex={-1}>
                            <span className="size-1.5 rounded-full bg-current" aria-hidden />
                            <RefreshCw className="ml-0.5 size-3 opacity-70" aria-hidden />
                            <span className="sr-only">Template changed since the last sync</span>
                          </span>
                        </TooltipTrigger>
                        <TooltipContent>Template changed since the last sync. Open the project to sync it.</TooltipContent>
                      </Tooltip>
                    ) : null}
                  </span>
                </td>
                {columns.map((c) => {
                  const v = r.summary.find((s) => s.fieldId === c.fieldId)?.display;
                  return (
                    <td
                      key={c.fieldId}
                      className={cn(
                        "px-2 whitespace-nowrap",
                        c.numeric && "text-right tabular-nums",
                        c.wide ? cn(WIDE_ONLY, "w-[11%] max-w-0") : !c.numeric && SUMMARY_MAX,
                        c.medium && !c.wide && MEDIUM_ONLY,
                      )}
                    >
                      {v ? (
                        <span className="block truncate" title={v}>
                          {v}
                        </span>
                      ) : (
                        <span className="text-muted-foreground/60" aria-label="empty">
                          —
                        </span>
                      )}
                    </td>
                  );
                })}
                <td className="px-2 whitespace-nowrap">
                  <StatusPill status={r.status} />
                </td>
                <td className="px-2 whitespace-nowrap">
                  <ProgressMini pct={r.progress.pct} done={r.progress.done} applicable={r.progress.applicable} />
                </td>
                <td className="w-[22%] max-w-0 min-w-[160px] px-2">
                  {r.firstCurrent ? (
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span
                        className="size-2 shrink-0 rounded-full ring-2 ring-[var(--current-ring)] ring-offset-1 ring-offset-background"
                        aria-hidden
                      />
                      <span className="truncate" title={r.currentNames.join("\n")}>
                        {r.firstCurrent}
                      </span>
                      {extra > 0 ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="shrink-0 rounded bg-muted px-1 text-[11px] text-muted-foreground tabular-nums">+{extra}</span>
                          </TooltipTrigger>
                          <TooltipContent className="block max-w-sm">
                            <span className="mb-1 block font-medium">Current milestones</span>
                            {r.currentNames.map((n, i) => (
                              <span key={i} className="block">
                                {n}
                              </span>
                            ))}
                          </TooltipContent>
                        </Tooltip>
                      ) : null}
                    </span>
                  ) : (
                    <span className="text-muted-foreground/60">—</span>
                  )}
                </td>
                <td className="pr-4 pl-2 whitespace-nowrap text-muted-foreground tabular-nums" title={formatInstant(r.updatedAt, timeZone)}>
                  {formatRelative(r.updatedAt, now, timeZone)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
