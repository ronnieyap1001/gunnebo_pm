"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ListChecks, Search, X } from "lucide-react";
import type { ProjectStatus } from "@/domain/types";
import type { PortfolioData } from "@/server/queries";
import { useHotkeys } from "@/lib/hotkeys";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/common/empty-state";
import { StateLegend } from "@/components/state/state-badge";
import { PageHeader } from "@/components/shell/page-header";
import { Kbd } from "@/components/shell/kbd";
import { useNow } from "@/components/shell/use-now";
import { GridTooltip, type GridTooltipHandle } from "./cell-tooltip";
import { DEFAULT_QUERY, isDefaultGridFilter, serializePortfolioQuery, type PortfolioQuery } from "./filters";
import { MultiFilter } from "./multi-filter";
import { OpenItemsPanel } from "./open-items-panel";
import { HATCH_STYLE, PortfolioGrid } from "./portfolio-grid";

const FILTERS_KEY = "gpm.portfolio.filters";
const PANEL_KEY = "gpm.portfolio.openItems";
const SEARCH_DEBOUNCE_MS = 300;

const STATUS_CHIPS: { id: ProjectStatus; label: string }[] = [
  { id: "ACTIVE", label: "Active" },
  { id: "ON_HOLD", label: "On hold" },
  { id: "CLOSED", label: "Closed" },
];

/** A dialog or menu (palette, shortcut list, a filter list…) is open: screen keys stay quiet. */
function overlayOpen(): boolean {
  return Boolean(document.querySelector("[role='dialog'][data-state='open'],[role='menu'][data-state='open']"));
}

function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeStorage(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* private mode */
  }
}

export function PortfolioScreen({
  data,
  hasUrlFilters,
  totalProjects,
  serverNow,
  timeZone,
}: {
  data: PortfolioData;
  /** The URL carried filters (otherwise the last-used ones come back from localStorage). */
  hasUrlFilters: boolean;
  /** READY projects of any status (to tell "no projects yet" from "none match"). */
  totalProjects: number;
  serverNow: string;
  timeZone: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const now = useNow(serverNow);
  const tooltip = useRef<GridTooltipHandle>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const served: PortfolioQuery = {
    status: data.filters.status,
    customer: data.filters.customer,
    type: data.filters.projectType,
    q: data.filters.q,
    waiting: data.filters.includeWaiting,
    dated: data.filters.includeDateDriven,
  };
  // The filters just asked for, shown at once while the server renders them. Every change builds on the latest
  // request (not on the last served page), so quick clicks never drop an earlier choice.
  const [requested, setRequested] = useState<PortfolioQuery | null>(null);
  const query = pending && requested ? requested : served;
  const latest = useRef(query);
  latest.current = query;
  useEffect(() => {
    if (!pending) setRequested(null);
  }, [pending]);

  const [search, setSearch] = useState(served.q);
  const [panelOpen, setPanelOpen] = useState(true);
  const searchTimer = useRef<number | null>(null);
  /** The last search sent; a served page that answers it must not overwrite what was typed since. */
  const sentQ = useRef(served.q);

  useEffect(() => {
    if (data.filters.q !== sentQ.current) {
      sentQ.current = data.filters.q;
      setSearch(data.filters.q);
    }
  }, [data.filters.q]);

  // Remember the panel state.
  useEffect(() => {
    if (readStorage(PANEL_KEY) === "0") setPanelOpen(false);
  }, []);

  // Remember the filters of every page that carries them; a bare /portfolio (first visit, the sidebar link, "G P")
  // brings the last-used ones back.
  const servedKey = serializePortfolioQuery(served);
  useEffect(() => {
    if (hasUrlFilters) {
      writeStorage(FILTERS_KEY, servedKey);
      return;
    }
    const saved = readStorage(FILTERS_KEY);
    if (saved && saved !== servedKey) startTransition(() => router.replace(`/portfolio?${saved}`, { scroll: false }));
  }, [hasUrlFilters, servedKey, router]);

  /** Applies a change to the latest requested filters (functional, so quick successive changes all count). */
  function navigate(change: (current: PortfolioQuery) => PortfolioQuery) {
    const next = change(latest.current);
    if (serializePortfolioQuery(next) === serializePortfolioQuery(latest.current)) return;
    latest.current = next;
    sentQ.current = next.q;
    setRequested(next);
    const qs = serializePortfolioQuery(next);
    writeStorage(FILTERS_KEY, qs);
    tooltip.current?.hide();
    startTransition(() => router.replace(qs ? `/portfolio?${qs}` : "/portfolio", { scroll: false }));
  }

  function toggleStatus(s: ProjectStatus) {
    navigate((cur) => {
      const has = cur.status.includes(s);
      if (has && cur.status.length === 1) return cur; // at least one status
      return { ...cur, status: has ? cur.status.filter((x) => x !== s) : [...cur.status, s] };
    });
  }

  function flushSearch(v: string) {
    if (searchTimer.current) window.clearTimeout(searchTimer.current);
    searchTimer.current = null;
    if (v.trim() !== latest.current.q) navigate((cur) => ({ ...cur, q: v.trim() }));
  }

  /** Empties the box and drops a search still waiting for its debounce. */
  function clearSearch() {
    if (searchTimer.current) window.clearTimeout(searchTimer.current);
    searchTimer.current = null;
    setSearch("");
  }

  function onSearchChange(v: string) {
    setSearch(v);
    if (searchTimer.current) window.clearTimeout(searchTimer.current);
    searchTimer.current = window.setTimeout(() => flushSearch(v), SEARCH_DEBOUNCE_MS);
  }

  useEffect(
    () => () => {
      if (searchTimer.current) window.clearTimeout(searchTimer.current);
    },
    [],
  );

  function togglePanel() {
    setPanelOpen((o) => {
      writeStorage(PANEL_KEY, o ? "0" : "1");
      return !o;
    });
  }

  useHotkeys({
    o: (e) => {
      if (overlayOpen()) return;
      e.preventDefault();
      togglePanel();
    },
    "/": (e) => {
      if (overlayOpen()) return;
      e.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select();
    },
  });

  const filtered = !isDefaultGridFilter(query);
  const cacheKey = `${data.today}|${data.rows.map((r) => r.projectId).join(",")}|${serverNow}`;

  return (
    <main className="flex h-svh min-h-0 flex-col">
      <PageHeader
        title="Portfolio"
        description="Every project by milestone. Hover a square for details; click it to open that milestone."
        actions={
          <Button
            variant={panelOpen ? "secondary" : "outline"}
            size="sm"
            onClick={togglePanel}
            aria-pressed={panelOpen}
            aria-keyshortcuts="o"
          >
            <ListChecks aria-hidden />
            My open items
            <span className="rounded-full bg-background/70 px-1.5 text-[11px] tabular-nums">{data.openItems.length}</span>
            <Kbd className="ml-0.5">O</Kbd>
          </Button>
        }
      />

      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
        <div className="relative w-60 max-w-full">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            ref={searchRef}
            type="search"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                flushSearch(search);
              }
              if (e.key === "Escape" && search) {
                e.preventDefault();
                onSearchChange("");
              }
            }}
            placeholder="Search code or name"
            aria-label="Search projects by code or name"
            aria-keyshortcuts="/"
            className="h-8 pr-8 pl-8"
          />
          {!search ? <Kbd className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2">/</Kbd> : null}
        </div>
        <div role="group" aria-label="Status" className="flex items-center gap-1">
          {STATUS_CHIPS.map((s) => {
            const on = query.status.includes(s.id);
            return (
              <button
                key={s.id}
                type="button"
                aria-pressed={on}
                onClick={() => toggleStatus(s.id)}
                title={on && query.status.length === 1 ? "At least one status stays selected" : undefined}
                className={cn(
                  "inline-flex h-7 items-center rounded-full border px-2.5 text-xs transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
                  on
                    ? "border-foreground/25 bg-accent font-medium text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                )}
              >
                {s.label}
              </button>
            );
          })}
        </div>
        <MultiFilter
          label="Customer"
          options={data.filterOptions.customers}
          selected={query.customer}
          onChange={(ids) => navigate((cur) => ({ ...cur, customer: ids }))}
        />
        <MultiFilter
          label="Type"
          options={data.filterOptions.projectTypes}
          selected={query.type}
          onChange={(ids) => navigate((cur) => ({ ...cur, type: ids }))}
        />
        {filtered ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs text-muted-foreground"
            onClick={() => {
              clearSearch();
              navigate((cur) => ({ ...DEFAULT_QUERY, waiting: cur.waiting, dated: cur.dated }));
            }}
          >
            <X aria-hidden /> Reset filters
          </Button>
        ) : null}
        <span className="ml-auto text-xs text-muted-foreground" aria-live="polite">
          {pending
            ? "Updating…"
            : `${data.rows.length} ${data.rows.length === 1 ? "project" : "projects"} · ${data.columns.length} milestones`}
        </span>
      </div>

      {pending ? (
        <div className="h-0.5 w-full animate-pulse bg-[var(--state-ip-solid)]" aria-hidden />
      ) : (
        <div className="h-0.5" aria-hidden />
      )}

      <div className="flex min-h-0 flex-1">
        <div className={cn("flex min-w-0 flex-1 flex-col transition-opacity", pending && "opacity-70")}>
          {totalProjects === 0 ? (
            <EmptyState
              className="flex-1"
              title="No projects yet"
              action={
                <Button asChild>
                  <Link href="/projects?new=1">Create a project</Link>
                </Button>
              }
            >
              The Portfolio shows every project against the milestones of the Template Flow. Create your first project on the{" "}
              <Link href="/projects" className="underline underline-offset-2">
                Projects
              </Link>{" "}
              screen.
            </EmptyState>
          ) : data.rows.length === 0 ? (
            <EmptyState
              className="flex-1"
              title="No projects match these filters"
              action={
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    clearSearch();
                    navigate((cur) => ({
                      ...DEFAULT_QUERY,
                      status: ["ACTIVE", "ON_HOLD", "CLOSED"],
                      waiting: cur.waiting,
                      dated: cur.dated,
                    }));
                  }}
                >
                  Show all projects
                </Button>
              }
            >
              {totalProjects} {totalProjects === 1 ? "project exists" : "projects exist"}, but none has the selected status, customer or
              type
              {query.q ? <> and matches &ldquo;{query.q}&rdquo;</> : null}.
            </EmptyState>
          ) : (
            <PortfolioGrid columns={data.columns} rows={data.rows} tooltip={tooltip} />
          )}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t px-4 py-1.5">
            <StateLegend />
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <span className="inline-block size-2.5 rounded-[2px] border border-border" style={HATCH_STYLE} aria-hidden />
              Not in this project · sync
            </span>
            <span className="ml-auto text-[11px] text-muted-foreground">
              Arrow keys move between squares · <Kbd>Enter</Kbd> opens
            </span>
          </div>
        </div>
        {panelOpen && totalProjects > 0 ? (
          <OpenItemsPanel
            items={data.openItems}
            hidden={data.hidden}
            includeWaiting={query.waiting}
            includeDateDriven={query.dated}
            onToggleWaiting={() => navigate((cur) => ({ ...cur, waiting: !cur.waiting }))}
            onToggleDateDriven={() => navigate((cur) => ({ ...cur, dated: !cur.dated }))}
            pending={pending}
            onClose={togglePanel}
            timeZone={timeZone}
          />
        ) : null}
      </div>
      <GridTooltip ref={tooltip} now={now} timeZone={timeZone} cacheKey={cacheKey} />
    </main>
  );
}
