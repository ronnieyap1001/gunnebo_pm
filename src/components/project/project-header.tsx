"use client";

import { useEffect, useState } from "react";
import {
  Archive,
  ChevronDown,
  ChevronUp,
  FileSpreadsheet,
  GitBranch,
  History,
  List,
  Loader2,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Workflow,
  X,
} from "lucide-react";
import { STATE_META } from "@/domain/state";
import type { ProjectStatus, State } from "@/domain/types";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { StateDot, StateIcon, stateClass } from "@/components/state/state-badge";
import { useProject } from "./context";
import { plural } from "./format";
import { Kbd } from "./kbd";
import type { ProjectViewMode } from "./types";
import { usePendingWrites } from "./use-queue";

const COLLAPSE_KEY = "gpm.project.header.collapsed";
const BAR_ORDER: State[] = ["DONE", "IN_PROGRESS", "WAITING", "BLOCKED", "NOT_STARTED", "NOT_APPLICABLE"];
const COUNT_ORDER: State[] = ["IN_PROGRESS", "WAITING", "BLOCKED", "NOT_STARTED", "NOT_APPLICABLE"];
const MAX_CHIPS = 6;

const STATUS_CLASS: Record<ProjectStatus, string> = {
  ACTIVE: stateClass("DONE"),
  ON_HOLD: stateClass("WAITING"),
  CLOSED: stateClass("NOT_STARTED"),
};

function StatusPill({ status, label }: { status: ProjectStatus; label: string }) {
  return (
    <span className={cn(STATUS_CLASS[status], "inline-flex h-5 shrink-0 items-center gap-1 rounded-full border px-2 text-[11px] font-medium")}>
      <span className="size-1.5 rounded-full bg-[var(--s-solid)]" aria-hidden />
      {label}
    </span>
  );
}

export function StateBar({ counts, total, className }: { counts: Record<State, number>; total: number; className?: string }) {
  return (
    <div
      className={cn("flex h-2 overflow-hidden rounded-full bg-muted", className)}
      role="img"
      aria-label={BAR_ORDER.filter((s) => counts[s]).map((s) => `${counts[s]} ${STATE_META[s].label.toLowerCase()}`).join(", ")}
    >
      {total > 0
        ? BAR_ORDER.map((s) =>
            counts[s] ? (
              <div
                key={s}
                className={cn(stateClass(s), "h-full bg-[var(--s-solid)]", s === "NOT_APPLICABLE" && "opacity-40")}
                style={{ width: `${(100 * counts[s]) / total}%` }}
              />
            ) : null,
          )
        : null}
    </div>
  );
}

export function ProjectHeader({
  mode,
  onMode,
  onEditDetails,
  onExport,
  exporting,
  onSync,
  onArchive,
  suggestClose,
  onSetClosed,
  onDismissClose,
}: {
  mode: ProjectViewMode;
  onMode: (m: ProjectViewMode) => void;
  onEditDetails: () => void;
  onExport: () => void;
  exporting: boolean;
  onSync: () => void;
  onArchive: () => void;
  suggestClose: boolean;
  onSetClosed: () => void;
  onDismissClose: () => void;
}) {
  const { raw, view, openStep, centerOn, readOnly, projectId, api } = useProject();
  const [collapsed, setCollapsed] = useState(false);
  const pending = usePendingWrites(projectId);
  useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(COLLAPSE_KEY) === "1");
    } catch {
      /* private mode */
    }
  }, []);
  function toggle() {
    setCollapsed((c) => {
      try {
        window.localStorage.setItem(COLLAPSE_KEY, c ? "0" : "1");
      } catch {
        /* ignore */
      }
      return !c;
    });
  }

  const p = raw.project;
  const typeDetail = raw.details.find((d) => d.systemKey === "projectType" && !d.empty);
  const summary = raw.details.filter((d) => d.showInSummary && !d.empty && !d.archived && d.fieldType !== "LONG_TEXT" && d.systemKey !== "projectType");
  const { progress } = view;
  const total = view.steps.length;
  const current = view.currentIds.map((id) => view.byId.get(id)!).filter(Boolean);
  const chips = current.slice(0, MAX_CHIPS);
  const overflow = current.slice(MAX_CHIPS);
  const showSync = !p.archived && p.status !== "CLOSED" && p.setup === "READY" && (raw.sync.pendingCount > 0 || raw.sync.templateChanged);

  function pickCurrent(id: string) {
    openStep(id);
    centerOn(id);
  }

  const menu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="More actions">
          <MoreHorizontal aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuItem onSelect={onEditDetails} disabled={readOnly}>
          <Pencil aria-hidden /> Edit details
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onExport} disabled={exporting}>
          {exporting ? <Loader2 className="animate-spin" aria-hidden /> : <FileSpreadsheet aria-hidden />} Export to Excel
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onSync} disabled={readOnly || p.setup !== "READY"}>
          <RefreshCw aria-hidden /> Sync from template…
          {raw.sync.pendingCount ? <DropdownMenuShortcut>{raw.sync.pendingCount}</DropdownMenuShortcut> : null}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {p.archived ? (
          <DropdownMenuItem onSelect={() => void api.restoreProject(p.code, false)}>
            <Archive aria-hidden /> Restore project
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem variant="destructive" onSelect={onArchive}>
            <Archive aria-hidden /> Archive project…
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const views = (
    <div role="tablist" aria-label="View" className="inline-flex shrink-0 rounded-md border p-0.5">
      {(
        [
          { m: "flow", label: "Flow", icon: Workflow, key: "V" },
          { m: "list", label: "List", icon: List, key: "V" },
          { m: "history", label: "History", icon: History, key: "H" },
        ] as const
      ).map((v) => (
        <Tooltip key={v.m}>
          <TooltipTrigger asChild>
            <button
              type="button"
              role="tab"
              aria-selected={mode === v.m}
              onClick={() => onMode(v.m)}
              className={cn(
                "inline-flex h-6 items-center gap-1 rounded px-2 text-xs font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                mode === v.m ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              <v.icon className="size-3.5" aria-hidden />
              {v.label}
            </button>
          </TooltipTrigger>
          <TooltipContent>
            {v.m === "history" ? "History" : "Flow / List"} <Kbd>{v.key}</Kbd>
          </TooltipContent>
        </Tooltip>
      ))}
    </div>
  );

  return (
    <header className="sticky top-0 z-20 shrink-0 border-b bg-background">
      <div className="flex min-h-11 items-center gap-2 px-4 pt-2 pb-1">
        <span className="shrink-0 rounded-md border bg-muted px-1.5 py-0.5 font-mono text-xs font-semibold tracking-tight">{p.code}</span>
        <h1 className="min-w-0 truncate text-sm font-semibold" title={p.name}>
          {p.name}
        </h1>
        <StatusPill status={p.status} label={p.statusLabel} />
        {typeDetail ? (
          <span className="inline-flex h-5 shrink-0 items-center rounded-full border px-2 text-[11px] text-muted-foreground">{typeDetail.display}</span>
        ) : null}
        {collapsed ? (
          <span className="ml-1 hidden min-w-0 items-center gap-2 text-xs text-muted-foreground md:flex">
            <StateBar counts={progress.counts} total={total} className="w-24" />
            <span className="tabular-nums">{progress.pct} %</span>
            {current[0] ? (
              <button type="button" onClick={() => pickCurrent(current[0].id)} className="truncate hover:text-foreground hover:underline">
                Current: {current[0].name}
                {current.length > 1 ? ` +${current.length - 1}` : ""}
              </button>
            ) : null}
          </span>
        ) : null}
        <div className="flex-1" />
        <span className="hidden text-[11px] text-muted-foreground sm:inline" aria-live="polite">
          {pending > 0 ? (
            <span className="inline-flex items-center gap-1">
              <Loader2 className="size-3 animate-spin" aria-hidden /> Saving…
            </span>
          ) : null}
        </span>
        {views}
        <Button size="sm" variant="outline" onClick={onEditDetails} disabled={readOnly}>
          <Pencil aria-hidden /> Edit details
        </Button>
        {menu}
        <Button variant="ghost" size="icon-sm" onClick={toggle} aria-label={collapsed ? "Show the project summary" : "Collapse the header"} aria-expanded={!collapsed}>
          {collapsed ? <ChevronDown aria-hidden /> : <ChevronUp aria-hidden />}
        </Button>
      </div>

      {!collapsed ? (
        <div className="space-y-1.5 px-4 pb-2">
          {summary.length ? (
            <p className="truncate text-xs text-muted-foreground">
              {summary.map((d, i) => (
                <span key={d.fieldId} title={d.label}>
                  {i > 0 ? " · " : ""}
                  {d.display}
                </span>
              ))}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            <StateBar counts={progress.counts} total={total} className="w-56" />
            <span className="font-medium tabular-nums">
              {progress.done} / {progress.applicable} done · {progress.pct} %
            </span>
            <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-muted-foreground">
              {COUNT_ORDER.filter((s) => progress.counts[s]).map((s) => (
                <span key={s} className="inline-flex items-center gap-1 tabular-nums">
                  <StateDot state={s} />
                  {progress.counts[s]} {s === "NOT_APPLICABLE" ? "N/A" : STATE_META[s].label.toLowerCase()}
                </span>
              ))}
            </span>
          </div>
          <div className="flex min-w-0 items-center gap-1.5 text-xs">
            <span className="shrink-0 text-muted-foreground">Current:</span>
            {current.length === 0 ? (
              <span className="text-muted-foreground">{progress.applicable > 0 && progress.done === progress.applicable ? "Everything is done." : "Nothing is current."}</span>
            ) : (
              <div className="flex min-w-0 flex-wrap items-center gap-1">
                {chips.map((s) => (
                  <CurrentChip key={s.id} name={s.name} state={s.state} seq={s.seq} onClick={() => pickCurrent(s.id)} />
                ))}
                {overflow.length ? (
                  <Popover>
                    <PopoverTrigger asChild>
                      <button type="button" className="inline-flex h-5 items-center rounded-full border px-2 text-[11px] text-muted-foreground hover:bg-muted">
                        +{overflow.length}
                      </button>
                    </PopoverTrigger>
                    <PopoverContent align="start" className="w-72 p-1">
                      <ul className="max-h-72 overflow-y-auto">
                        {overflow.map((s) => (
                          <li key={s.id}>
                            <button
                              type="button"
                              onClick={() => pickCurrent(s.id)}
                              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted"
                            >
                              <StateIcon state={s.state} />
                              <span className="w-6 shrink-0 text-xs text-muted-foreground tabular-nums">{s.seq}</span>
                              <span className="truncate">{s.name}</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    </PopoverContent>
                  </Popover>
                ) : null}
              </div>
            )}
          </div>
        </div>
      ) : null}

      {p.archived ? (
        <div className="flex items-center gap-2 border-t bg-muted/60 px-4 py-1.5 text-xs">
          <Archive className="size-3.5 text-muted-foreground" aria-hidden />
          <span className="flex-1">This project is archived. You can look at it, but restore it before changing anything.</span>
          <Button size="xs" variant="outline" onClick={() => void api.restoreProject(p.code, false)}>
            Restore project
          </Button>
        </div>
      ) : null}
      {showSync ? (
        <div className={cn(stateClass("IN_PROGRESS"), "flex items-center gap-2 border-t border-[var(--s-border)] bg-[var(--s-bg)] px-4 py-1.5 text-xs text-[var(--s-fg)]")}>
          <GitBranch className="size-3.5" aria-hidden />
          <span className="flex-1">
            Template changed since the last sync
            {raw.sync.pendingCount ? ` · ${plural(raw.sync.pendingCount, "change")} to review` : ""}
          </span>
          <Button size="xs" variant="outline" onClick={onSync}>
            Review
          </Button>
        </div>
      ) : null}
      {suggestClose && !p.archived && p.status !== "CLOSED" ? (
        <div className={cn(stateClass("DONE"), "flex items-center gap-2 border-t border-[var(--s-border)] bg-[var(--s-bg)] px-4 py-1.5 text-xs text-[var(--s-fg)]")}>
          <span className="flex-1">&ldquo;Project closed&rdquo; has a date. Set the status to Closed?</span>
          <Button size="xs" variant="outline" onClick={onSetClosed}>
            Set status to Closed
          </Button>
          <Button size="icon-xs" variant="ghost" aria-label="Not now" onClick={onDismissClose}>
            <X aria-hidden />
          </Button>
        </div>
      ) : null}
    </header>
  );
}

function CurrentChip({ name, state, seq, onClick }: { name: string; state: State; seq: number; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={`#${seq} ${name} (${STATE_META[state].label})`}
      className={cn(
        stateClass(state),
        "inline-flex h-5 max-w-56 items-center gap-1 rounded-full border border-[var(--s-border)] bg-[var(--s-bg)] px-2 text-[11px] font-medium text-[var(--s-fg)] ring-1 ring-[var(--current-ring)]/50 transition-colors hover:ring-[var(--current-ring)]",
      )}
    >
      <StateIcon state={state} className="size-3" />
      <span className="truncate">{name}</span>
    </button>
  );
}
