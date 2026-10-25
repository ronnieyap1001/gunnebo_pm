"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { CirclePause, Plus, Search, X } from "lucide-react";
import type { ProjectField, ProjectStatus, Ymd } from "@/domain/types";
import type { ProjectListRow } from "@/server/queries";
import { useHotkeys } from "@/lib/hotkeys";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/common/empty-state";
import { PageHeader } from "@/components/shell/page-header";
import { Kbd } from "@/components/shell/kbd";
import { callAction } from "@/components/shell/action-call";
import { useNow } from "@/components/shell/use-now";
import { listCreateJobsAction, type CreateJobDTO } from "@/app/(app)/projects/actions";
import { NewProjectDialog, type TakenCode } from "./new-project-dialog";
import { onRadioKeyDown } from "./radio-keys";
import { ProjectsTable, type Sort, type SortKey, type SummaryColumn } from "./projects-table";
import { CREATE_JOB_KIND, useCreateProject } from "./use-create-project";

type StatusFilter = ProjectStatus | "ALL";

const STATUS_CHIPS: { id: StatusFilter; label: string; param: string }[] = [
  { id: "ACTIVE", label: "Active", param: "active" },
  { id: "ON_HOLD", label: "On hold", param: "on-hold" },
  { id: "CLOSED", label: "Closed", param: "closed" },
  { id: "ALL", label: "All", param: "all" },
];

function parseStatus(v: string | null): StatusFilter {
  return STATUS_CHIPS.find((s) => s.param === v)?.id ?? "ACTIVE";
}

/** A dialog or menu (palette, shortcut list…) is open: screen keys stay quiet. */
function overlayOpen(): boolean {
  return Boolean(document.querySelector("[role='dialog'][data-state='open'],[role='menu'][data-state='open']"));
}

const STATUS_ORDER: Record<ProjectStatus, number> = { ACTIVE: 0, ON_HOLD: 1, CLOSED: 2 };

function compare(a: ProjectListRow, b: ProjectListRow, key: SortKey): number {
  switch (key) {
    case "code":
      return a.code.localeCompare(b.code, "en", { numeric: true });
    case "name":
      return a.name.localeCompare(b.name, "en", { sensitivity: "base" });
    case "progress":
      return a.progress.pct - b.progress.pct || a.code.localeCompare(b.code, "en", { numeric: true });
    case "updated":
      return a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0;
    case "status":
      return STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.code.localeCompare(b.code, "en", { numeric: true });
  }
}

/** Puts the search and status filter in the URL without a server round trip. */
function writeUrl(q: string, status: StatusFilter) {
  try {
    const url = new URL(window.location.href);
    if (q.trim()) url.searchParams.set("q", q.trim());
    else url.searchParams.delete("q");
    if (status !== "ACTIVE") url.searchParams.set("status", STATUS_CHIPS.find((s) => s.id === status)!.param);
    else url.searchParams.delete("status");
    window.history.replaceState(window.history.state, "", url.toString());
  } catch {
    /* best effort */
  }
}

export interface ProjectsScreenProps {
  rows: ProjectListRow[];
  takenCodes: Record<string, TakenCode>;
  columns: SummaryColumn[];
  formFields: ProjectField[];
  milestoneCount: number;
  today: Ymd;
  timeZone: string;
  serverNow: string;
}

export function ProjectsScreen({ rows, takenCodes, columns, formFields, milestoneCount, today, timeZone, serverNow }: ProjectsScreenProps) {
  const searchParams = useSearchParams();
  const [q, setQ] = useState(() => searchParams.get("q") ?? "");
  const [status, setStatus] = useState<StatusFilter>(() => parseStatus(searchParams.get("status")));
  const [sort, setSort] = useState<Sort>({ key: "code", dir: "asc" });
  const [newOpen, setNewOpen] = useState(false);
  const [jobs, setJobs] = useState<CreateJobDTO[]>([]);
  const [runningJob, setRunningJob] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const now = useNow(serverNow);

  const reloadJobs = useCallback(async () => {
    const r = await callAction(() => listCreateJobsAction(), { retries: 1 });
    if (r.ok) setJobs(r.data);
  }, []);
  const creator = useCreateProject({ onStopped: () => void reloadJobs() });
  const runJob = creator.run;

  const runCreate = useCallback(
    async (job: { opId: string; code: string; total?: number; doneCount?: number }) => {
      setRunningJob(job.opId);
      const ok = await runJob(job);
      setRunningJob(null);
      if (!ok) void reloadJobs();
    },
    [runJob, reloadJobs],
  );

  // On load: interrupted creations (banner), a creation to resume from the URL, and ?new=1 from the palette.
  const handledUrl = useRef(false);
  useEffect(() => {
    void reloadJobs();
  }, [reloadJobs]);
  useEffect(() => {
    if (handledUrl.current) return;
    handledUrl.current = true;
    const job = searchParams.get("job");
    if (job && searchParams.get("kind") === CREATE_JOB_KIND && /^[A-Za-z0-9-]{8,64}$/.test(job)) {
      void runCreate({ opId: job, code: searchParams.get("code") || "the project" });
    }
  }, [searchParams, runCreate]);
  useEffect(() => {
    if (searchParams.get("new") !== "1") return;
    setNewOpen(true);
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete("new");
      window.history.replaceState(window.history.state, "", url.toString());
    } catch {
      /* ignore */
    }
  }, [searchParams]);

  const counts = useMemo(() => {
    const c: Record<StatusFilter, number> = { ACTIVE: 0, ON_HOLD: 0, CLOSED: 0, ALL: rows.length };
    for (const r of rows) c[r.status]++;
    return c;
  }, [rows]);

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = rows.filter(
      (r) =>
        (status === "ALL" || r.status === status) &&
        (!needle ||
          r.code.toLowerCase().includes(needle) ||
          r.name.toLowerCase().includes(needle) ||
          (r.customer ?? "").toLowerCase().includes(needle)),
    );
    const dir = sort.dir === "asc" ? 1 : -1;
    return [...list].sort((a, b) => dir * compare(a, b, sort.key));
  }, [rows, q, status, sort]);

  function changeStatus(s: StatusFilter) {
    setStatus(s);
    writeUrl(q, s);
  }
  function changeQuery(v: string) {
    setQ(v);
    writeUrl(v, status);
  }
  function onSort(k: SortKey) {
    setSort((s) =>
      s.key === k
        ? { key: k, dir: s.dir === "asc" ? "desc" : "asc" }
        : { key: k, dir: k === "updated" || k === "progress" ? "desc" : "asc" },
    );
  }

  useHotkeys(
    {
      c: (e) => {
        if (overlayOpen()) return;
        e.preventDefault();
        setNewOpen(true);
      },
      "/": (e) => {
        if (overlayOpen()) return;
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      },
    },
    !newOpen && !creator.running,
  );

  const pendingJobs = jobs.filter((j) => j.opId !== runningJob);
  const filtered = q.trim() || status !== "ACTIVE";

  return (
    <main className="flex h-svh min-h-0 flex-col">
      <PageHeader
        title="Projects"
        description={
          rows.length
            ? `${counts.ACTIVE} active · ${counts.ON_HOLD} on hold · ${counts.CLOSED} closed`
            : "Create a project to copy the Template Flow"
        }
        actions={
          <Button size="sm" onClick={() => setNewOpen(true)} aria-keyshortcuts="c">
            <Plus aria-hidden />
            New project
            <Kbd className="ml-1 border-primary-foreground/30 bg-primary-foreground/15 text-primary-foreground">C</Kbd>
          </Button>
        }
      />

      {pendingJobs.length ? (
        <div className="space-y-1.5 border-b px-4 py-2">
          {pendingJobs.map((j) => (
            <div
              key={j.opId}
              role="status"
              className="state-w flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-[var(--s-border)] bg-[var(--s-bg)] px-3 py-1.5 text-sm text-[var(--s-fg)]"
            >
              <CirclePause className="size-4 shrink-0" aria-hidden />
              <span className="min-w-0 flex-1">
                Creating <strong className="font-mono">{j.code}</strong> {j.name ? <>({j.name}) </> : null}was interrupted
                {j.doneCount > 0 ? ` after ${j.doneCount} of ${j.total} milestones` : ""}. Nothing is lost: it continues where it stopped.
              </span>
              <Button size="sm" variant="outline" className="h-7" onClick={() => void runCreate(j)} disabled={creator.running}>
                Resume creating {j.code}
              </Button>
            </div>
          ))}
        </div>
      ) : null}

      {rows.length === 0 ? (
        <EmptyState
          title="No projects yet"
          action={
            <Button onClick={() => setNewOpen(true)}>
              <Plus aria-hidden />
              Create your first project
            </Button>
          }
        >
          A new project copies the {milestoneCount} milestones and their arrows from the Template Flow. You then update it by clicking its
          flow chart.
        </EmptyState>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
            <div className="relative w-72 max-w-full">
              <Search
                className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
                aria-hidden
              />
              <Input
                ref={searchRef}
                type="search"
                value={q}
                onChange={(e) => changeQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape" && q) {
                    e.preventDefault();
                    changeQuery("");
                  }
                }}
                placeholder="Search code, name or customer"
                aria-label="Search projects by code, name or customer"
                aria-keyshortcuts="/"
                className="h-8 pr-8 pl-8"
              />
              {!q ? <Kbd className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2">/</Kbd> : null}
            </div>
            <div role="radiogroup" aria-label="Status" className="flex items-center gap-1">
              {STATUS_CHIPS.map((s) => {
                const on = status === s.id;
                return (
                  <button
                    key={s.id}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    tabIndex={on ? 0 : -1}
                    onClick={() => changeStatus(s.id)}
                    onKeyDown={(e) =>
                      onRadioKeyDown(
                        e,
                        STATUS_CHIPS.map((x) => x.id),
                        status,
                        changeStatus,
                      )
                    }
                    className={cn(
                      "inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
                      on
                        ? "border-foreground/25 bg-accent font-medium text-accent-foreground"
                        : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                    )}
                  >
                    {s.label}
                    <span className="tabular-nums opacity-70">{counts[s.id]}</span>
                  </button>
                );
              })}
            </div>
            <span className="ml-auto text-xs text-muted-foreground" aria-live="polite">
              {visible.length === rows.length ? `${rows.length} projects` : `${visible.length} of ${rows.length} projects`}
            </span>
          </div>

          <div className="min-h-0 flex-1 overflow-auto">
            {visible.length ? (
              <ProjectsTable rows={visible} columns={columns} sort={sort} onSort={onSort} now={now} timeZone={timeZone} />
            ) : (
              <EmptyState
                title="No projects match"
                action={
                  filtered ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setQ("");
                        setStatus("ALL");
                        writeUrl("", "ALL");
                      }}
                    >
                      <X aria-hidden />
                      Clear the filters
                    </Button>
                  ) : null
                }
              >
                {q.trim() ? (
                  <>
                    Nothing in {status === "ALL" ? "any status" : STATUS_CHIPS.find((s) => s.id === status)!.label.toLowerCase()} matches
                    &ldquo;{q.trim()}&rdquo;.
                  </>
                ) : (
                  <>No {STATUS_CHIPS.find((s) => s.id === status)!.label.toLowerCase()} projects.</>
                )}
              </EmptyState>
            )}
          </div>
        </>
      )}

      <NewProjectDialog
        open={newOpen}
        onOpenChange={setNewOpen}
        fields={formFields}
        takenCodes={takenCodes}
        milestoneCount={milestoneCount}
        today={today}
        onStarted={(job) => {
          setNewOpen(false);
          void runCreate({ opId: job.opId, code: job.code, total: job.total, doneCount: 0 });
        }}
      />
      {creator.dialog}
    </main>
  );
}
