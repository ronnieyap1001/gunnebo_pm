"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ArrowUpRight, FileJson, Link2, Loader2, Paperclip, RotateCcw, Search, StickyNote, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { EmptyState } from "@/components/common/empty-state";
import { useHotkeys } from "@/lib/hotkeys";
import { cn } from "@/lib/utils";
import type { ActionResult } from "@/lib/action-result";
import { enqueue, newOpId } from "@/lib/write-queue";
import type { ArchiveData } from "@/server/queries";
import {
  loadProjectItemsAction,
  loadSnapshotsAction,
  restoreAttachmentAction,
  restoreMilestoneAction,
  restoreNoteAction,
  restoreProjectAction,
  restoreProjectFieldAction,
  restoreStepBatchAction,
} from "@/app/(app)/archive/actions";
import { ARCHIVE_TABS, type ArchiveProjectView, type ArchiveTab, type SnapshotRow } from "./archive-types";
import { callAction, toastError } from "./call";
import { fileSize, when, ymdIn } from "./format";
import { Notice } from "./notice";

const TAB_LABEL: Record<ArchiveTab, string> = {
  projects: "Projects",
  milestones: "Milestones",
  "project-fields": "Project fields",
  "project-items": "Project items",
  snapshots: "Template snapshots",
};

const STATUS_LABEL: Record<string, string> = { ACTIVE: "Active", ON_HOLD: "On hold", CLOSED: "Closed" };

function setUrl(params: Record<string, string | null>) {
  try {
    const url = new URL(window.location.href);
    for (const [k, v] of Object.entries(params)) {
      if (v) url.searchParams.set(k, v);
      else url.searchParams.delete(k);
    }
    window.history.replaceState(null, "", url.toString());
  } catch {
    /* best effort */
  }
}

function matches(q: string, ...parts: (string | null | undefined)[]): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  return parts.some((p) => p?.toLowerCase().includes(needle));
}

function hostOf(url: string | null): string {
  if (!url) return "";
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function ArchiveScreen({
  data,
  project,
  snapshots: initialSnapshots,
  timeZone,
  initialTab,
}: {
  /** Archived projects, milestones and fields (its `project` is unused: see `project`). */
  data: ArchiveData;
  /** The project chosen in the URL (`?project=`), with its archived items. */
  project: ArchiveProjectView | null;
  snapshots: { items: SnapshotRow[]; nextCursor: string | null };
  timeZone: string;
  initialTab: ArchiveTab;
}) {
  const router = useRouter();
  const [tab, setTab] = useState<ArchiveTab>(initialTab);
  const [q, setQ] = useState("");
  /** Rows restored in this tab (or being restored): hidden at once, shown again if the restore fails. */
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const [busyIds, setBusyIds] = useState<Set<string>>(() => new Set());
  const [projectId, setProjectId] = useState<string | null>(project?.id ?? null);
  const [items, setItems] = useState<ArchiveProjectView | null>(project);
  const [loadingItems, setLoadingItems] = useState(false);
  const [snapshots, setSnapshots] = useState(initialSnapshots);
  const [loadingMore, setLoadingMore] = useState(false);
  const loadSeq = useRef(0);
  /** opId of a restore that failed, per row: restoring that row again re-sends the same opId. */
  const failedOps = useRef(new Map<string, string>());

  useEffect(() => {
    setItems(project);
    setProjectId(project?.id ?? null);
  }, [project]);
  useEffect(() => setSnapshots(initialSnapshots), [initialSnapshots]);

  function changeTab(next: ArchiveTab) {
    setTab(next);
    setUrl({ tab: next === "projects" ? null : next });
  }

  useHotkeys({
    "1": () => changeTab("projects"),
    "2": () => changeTab("milestones"),
    "3": () => changeTab("project-fields"),
    "4": () => changeTab("project-items"),
    "5": () => changeTab("snapshots"),
  });

  /** Keys 1–5 also work while the (closed) project picker has focus; the shared hook skips comboboxes. */
  function tabKeyOnPicker(e: React.KeyboardEvent) {
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    const i = ["1", "2", "3", "4", "5"].indexOf(e.key);
    if (i < 0) return;
    e.preventDefault();
    changeTab(ARCHIVE_TABS[i]);
  }

  const hide = (ids: string[], on: boolean) =>
    setHidden((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  const markBusy = (id: string, on: boolean) =>
    setBusyIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  /**
   * Optimistic restore: the rows disappear at once; on failure they come back with a plain-English toast.
   * One opId per click, reused for retries; writes for one project go through that project's queue.
   */
  async function restore<T>(opts: {
    ids: string[];
    queueKey?: string;
    call: (opId: string) => Promise<ActionResult<T>>;
    success: (data: T) => { title: string; description?: string; action?: { label: string; href: string } };
  }) {
    const rowKey = opts.ids[0];
    const opId = failedOps.current.get(rowKey) ?? newOpId();
    hide(opts.ids, true);
    markBusy(rowKey, true);
    const task = () => callAction(() => opts.call(opId));
    const r = opts.queueKey ? await enqueue(opts.queueKey, task) : await task();
    markBusy(rowKey, false);
    if (!r.ok) {
      failedOps.current.set(rowKey, opId);
      hide(opts.ids, false);
      toastError(r, "Could not restore", {
        // Only while this row is still waiting for this restore (not restored meanwhile by a click on the row).
        retry: () => {
          if (failedOps.current.get(rowKey) === opId) void restore(opts);
        },
      });
      return;
    }
    failedOps.current.delete(rowKey);
    const msg = opts.success(r.data);
    toast.success(msg.title, {
      description: msg.description,
      action: msg.action ? { label: msg.action.label, onClick: () => router.push(msg.action!.href) } : undefined,
    });
  }

  const skipped = (n: number) => (n ? `${n} ${n === 1 ? "arrow was" : "arrows were"} not put back because ${n === 1 ? "it" : "they"} would create a loop or a missing step.` : undefined);

  // ---- Rows ---------------------------------------------------------------
  const projects = data.projects.filter((p) => !hidden.has(p.id) && matches(q, p.code, p.name));
  const batchSize = useMemo(() => {
    const m = new Map<string, number>();
    for (const x of data.milestones) if (x.archiveBatch) m.set(x.archiveBatch, (m.get(x.archiveBatch) ?? 0) + 1);
    return m;
  }, [data.milestones]);
  const milestones = data.milestones.filter((m) => !hidden.has(m.id) && matches(q, m.name, m.key));
  const fields = data.projectFields.filter((f) => !hidden.has(f.id) && matches(q, f.label, f.key));
  const steps = (items?.steps ?? []).filter((s) => !hidden.has(s.id) && matches(q, s.name));
  const notes = (items?.notes ?? []).filter((n) => !hidden.has(n.id) && matches(q, n.body, n.author));
  const files = (items?.attachments ?? []).filter((a) => !hidden.has(a.id) && matches(q, a.name, a.url));
  const snapRows = snapshots.items.filter((s) => matches(q, s.summary, s.reason));

  const counts: Record<ArchiveTab, number | null> = {
    projects: data.projects.filter((p) => !hidden.has(p.id)).length,
    milestones: data.milestones.filter((m) => !hidden.has(m.id)).length,
    "project-fields": data.projectFields.filter((f) => !hidden.has(f.id)).length,
    "project-items": items ? [...items.steps, ...items.notes, ...items.attachments].filter((x) => !hidden.has(x.id)).length : null,
    snapshots: snapshots.nextCursor ? null : snapshots.items.length,
  };

  async function chooseProject(id: string) {
    setProjectId(id);
    setUrl({ project: id, tab: "project-items" });
    const seq = ++loadSeq.current;
    setLoadingItems(true);
    const r = await callAction(() => loadProjectItemsAction(id));
    if (seq !== loadSeq.current) return;
    setLoadingItems(false);
    if (!r.ok) {
      toastError(r, "Could not load this project's archive");
      return;
    }
    setItems(r.data);
  }

  async function loadMoreSnapshots() {
    if (!snapshots.nextCursor) return;
    setLoadingMore(true);
    const cursor = snapshots.nextCursor;
    const r = await callAction(() => loadSnapshotsAction(cursor));
    setLoadingMore(false);
    if (!r.ok) {
      toastError(r, "Could not load older snapshots");
      return;
    }
    setSnapshots((s) => ({ items: [...s.items, ...r.data.items], nextCursor: r.data.nextCursor }));
  }

  // A project restored on this page counts as active from now on.
  const choices = data.projectChoices.map((p) => (p.archived && hidden.has(p.id) ? { ...p, archived: false } : p));
  const chosen = choices.find((p) => p.id === projectId) ?? null;
  const activeChoices = choices.filter((p) => !p.archived);
  const archivedChoices = choices.filter((p) => p.archived);

  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <Tabs value={tab} onValueChange={(v) => changeTab(v as ArchiveTab)} className="flex min-h-0 flex-1 flex-col gap-0">
        <div className="flex flex-wrap items-center gap-3 border-b px-4 py-2">
          <TabsList aria-label="Archive sections">
            {ARCHIVE_TABS.map((t, i) => (
              <TabsTrigger key={t} value={t} className="px-2.5 text-[13px]" title={`${TAB_LABEL[t]} (shortcut ${i + 1})`}>
                {TAB_LABEL[t]}
                {counts[t] !== null ? (
                  <span className="rounded-full bg-muted-foreground/10 px-1.5 text-[11px] tabular-nums text-muted-foreground">{counts[t]}</span>
                ) : null}
              </TabsTrigger>
            ))}
          </TabsList>
          <div className="relative ml-auto w-full max-w-64">
            <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Filter this list"
              aria-label="Filter archived items"
              className="h-8 pr-7 pl-7 text-[13px]"
            />
            {q ? (
              <button
                type="button"
                onClick={() => setQ("")}
                className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
                aria-label="Clear filter"
              >
                <X className="size-3.5" />
              </button>
            ) : null}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-auto">
          <TabsContent value="projects" className="m-0">
            {projects.length ? (
              <DenseTable head={["Code", "Project", "Status", "Archived", ""]} widths={["w-32", "", "w-28", "w-44", "w-28"]}>
                {projects.map((p) => (
                  <Row key={p.id}>
                    <Cell>
                      <Badge variant="outline" className="font-mono text-[11px]">
                        {p.code}
                      </Badge>
                    </Cell>
                    <Cell className="font-medium" title={p.name}>
                      {p.name}
                    </Cell>
                    <Cell className="text-muted-foreground">{STATUS_LABEL[p.status] ?? p.status}</Cell>
                    <DateCell iso={p.archivedAt} timeZone={timeZone} />
                    <Cell className="text-right">
                      <RestoreButton
                        busy={busyIds.has(p.id)}
                        label={`Restore project ${p.code}`}
                        onClick={() =>
                          restore({
                            ids: [p.id],
                            queueKey: p.id,
                            call: (opId) => restoreProjectAction(opId, p.id),
                            success: () => ({
                              title: `Project ${p.code} restored`,
                              description: "It is back in Projects and the Portfolio.",
                              action: { label: "Open", href: `/projects/${p.id}` },
                            }),
                          })
                        }
                      />
                    </Cell>
                  </Row>
                ))}
              </DenseTable>
            ) : (
              <Empty filtered={Boolean(q) && data.projects.length > 0} title="No archived projects">
                Archiving a project (⋯ → Archive on the project page) hides it everywhere. It shows up here so you can bring it back; its code
                stays reserved.
              </Empty>
            )}
          </TabsContent>

          <TabsContent value="milestones" className="m-0">
            {milestones.length ? (
              <DenseTable head={["Milestone", "ID for automations", "Archived with", "Archived", ""]} widths={["", "w-56", "w-40", "w-44", "w-28"]}>
                {milestones.map((m) => {
                  const together = m.archiveBatch ? batchSize.get(m.archiveBatch) ?? 1 : 1;
                  const batchIds = m.archiveBatch ? data.milestones.filter((x) => x.archiveBatch === m.archiveBatch).map((x) => x.id) : [m.id];
                  return (
                    <Row key={m.id}>
                      <Cell className="font-medium" title={m.name}>
                        {m.name}
                      </Cell>
                      <Cell className="font-mono text-[11px] text-muted-foreground" title={m.key}>
                        {m.key}
                      </Cell>
                      <Cell className="text-muted-foreground">
                        {together > 1 ? `${together - 1} other ${together === 2 ? "milestone" : "milestones"}` : "—"}
                      </Cell>
                      <DateCell iso={m.archivedAt} timeZone={timeZone} />
                      <Cell className="text-right">
                        <RestoreButton
                          busy={busyIds.has(m.id)}
                          label={together > 1 ? `Restore “${m.name}” and the ${together - 1} archived with it` : `Restore “${m.name}”`}
                          text={together > 1 ? `Restore ${together}` : undefined}
                          onClick={() =>
                            restore({
                              ids: batchIds,
                              call: (opId) => restoreMilestoneAction(opId, m.id),
                              success: (r) => ({
                                title: r.restoredIds.length > 1 ? `${r.restoredIds.length} milestones restored` : `“${m.name}” restored`,
                                description: skipped(r.skippedEdgeIds.length) ?? "It is back in the Milestone Library and Template Flow. Projects get it when you sync them.",
                                action: { label: "Show in Template Flow", href: `/template?m=${m.id}` },
                              }),
                            })
                          }
                        />
                      </Cell>
                    </Row>
                  );
                })}
              </DenseTable>
            ) : (
              <Empty filtered={Boolean(q) && data.milestones.length > 0} title="No archived milestones">
                Milestones you delete in the Milestone Library or Template Flow are archived here. Choices are restored inside the choice editor
                instead.
              </Empty>
            )}
          </TabsContent>

          <TabsContent value="project-fields" className="m-0">
            {fields.length ? (
              <DenseTable head={["Project field", "ID for automations", "Archived", ""]} widths={["", "w-56", "w-44", "w-28"]}>
                {fields.map((f) => (
                  <Row key={f.id}>
                    <Cell className="font-medium" title={f.label}>
                      {f.label}
                    </Cell>
                    <Cell className="font-mono text-[11px] text-muted-foreground" title={f.key}>
                      {f.key}
                    </Cell>
                    <DateCell iso={f.archivedAt} timeZone={timeZone} />
                    <Cell className="text-right">
                      <RestoreButton
                        busy={busyIds.has(f.id)}
                        label={`Restore field “${f.label}”`}
                        onClick={() =>
                          restore({
                            ids: [f.id],
                            call: (opId) => restoreProjectFieldAction(opId, f.id),
                            success: () => ({
                              title: `“${f.label}” restored`,
                              description: "Projects show the field again, with the values they had.",
                              action: { label: "Open Library", href: "/library?tab=project-fields" },
                            }),
                          })
                        }
                      />
                    </Cell>
                  </Row>
                ))}
              </DenseTable>
            ) : (
              <Empty filtered={Boolean(q) && data.projectFields.length > 0} title="No archived project fields">
                Project detail fields you archive in Milestone Library → Project fields appear here.
              </Empty>
            )}
          </TabsContent>

          <TabsContent value="project-items" className="m-0">
            <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
              <label htmlFor="archive-project" className="text-xs text-muted-foreground">
                Project
              </label>
              <Select value={projectId ?? undefined} onValueChange={(v) => void chooseProject(v)}>
                <SelectTrigger id="archive-project" size="sm" className="w-80 max-w-full text-[13px]" onKeyDown={tabKeyOnPicker}>
                  <SelectValue placeholder="Choose a project" />
                </SelectTrigger>
                <SelectContent>
                  {activeChoices.length ? (
                    <SelectGroup>
                      <SelectLabel>Projects</SelectLabel>
                      {activeChoices.map((p) => (
                        <SelectItem key={p.id} value={p.id}>
                          <span className="font-mono text-[11px]">{p.code}</span> {p.name}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  ) : null}
                  {archivedChoices.length ? (
                    <SelectGroup>
                      <SelectLabel>Archived projects</SelectLabel>
                      {archivedChoices.map((p) => (
                        <SelectItem key={p.id} value={p.id}>
                          <span className="font-mono text-[11px]">{p.code}</span> {p.name}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  ) : null}
                </SelectContent>
              </Select>
              {loadingItems ? <Loader2 className="size-4 animate-spin text-muted-foreground" aria-label="Loading" /> : null}
              {chosen && !chosen.archived ? (
                <Button asChild variant="ghost" size="sm" className="ml-auto">
                  <Link href={`/projects/${chosen.id}`}>Open project</Link>
                </Button>
              ) : null}
            </div>

            {!projectId ? (
              <EmptyState title="Choose a project">
                Archived project-only steps, deleted notes and removed files &amp; links are kept per project. Choose one above to see them.
              </EmptyState>
            ) : loadingItems && (!items || items.id !== projectId) ? (
              <ItemsSkeleton />
            ) : items ? (
              <div className="space-y-5 px-4 py-4">
                {chosen?.archived ? (
                  <Notice tone="info">
                    This project is archived. You can restore its items here; restore the project itself under Projects to work on it again.
                  </Notice>
                ) : null}

                <ItemSection title="Project-only steps" count={steps.length}>
                  {steps.length ? (
                    <DenseTable head={["Step", "Archived with", "Archived", ""]} widths={["", "w-40", "w-44", "w-28"]} flush>
                      {steps.map((s) => {
                        const batch = s.archiveBatch ? items.steps.filter((x) => x.archiveBatch === s.archiveBatch) : [s];
                        return (
                          <Row key={s.id}>
                            <Cell className="font-medium" title={s.name}>
                              {s.name}
                            </Cell>
                            <Cell className="text-muted-foreground">
                              {batch.length > 1 ? `${batch.length - 1} other ${batch.length === 2 ? "step" : "steps"}` : "—"}
                            </Cell>
                            <DateCell iso={s.archivedAt} timeZone={timeZone} />
                            <Cell className="text-right">
                              {s.archiveBatch ? (
                                <RestoreButton
                                  busy={busyIds.has(s.id)}
                                  label={`Restore step “${s.name}”`}
                                  text={batch.length > 1 ? `Restore ${batch.length}` : undefined}
                                  onClick={() =>
                                    restore({
                                      ids: batch.map((x) => x.id),
                                      queueKey: items.id,
                                      call: (opId) => restoreStepBatchAction(opId, items.id, s.archiveBatch!),
                                      success: (r) => ({
                                        title: r.restoredIds.length > 1 ? `${r.restoredIds.length} steps restored` : `“${s.name}” restored`,
                                        description: skipped(r.skippedEdgeIds.length) ?? `It is back in ${items.code}'s flow with its arrows.`,
                                        action: { label: "Show in project", href: `/projects/${items.id}?node=${s.id}` },
                                      }),
                                    })
                                  }
                                />
                              ) : (
                                <span className="text-xs text-muted-foreground" title="This step was archived without an undo record.">
                                  Can&apos;t restore
                                </span>
                              )}
                            </Cell>
                          </Row>
                        );
                      })}
                    </DenseTable>
                  ) : (
                    <SectionEmpty filtered={Boolean(q) && items.steps.some((x) => !hidden.has(x.id))}>
                      No archived project-only steps. Steps from the template are marked Not applicable instead of archived.
                    </SectionEmpty>
                  )}
                </ItemSection>

                <ItemSection title="Notes" count={notes.length}>
                  {notes.length ? (
                    <DenseTable head={["Note", "On", "Written", ""]} widths={["", "w-56", "w-44", "w-28"]} flush>
                      {notes.map((n) => (
                        <Row key={n.id}>
                          <Cell className="max-w-0 whitespace-normal">
                            <div className="flex items-start gap-1.5">
                              <StickyNote className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                              <span className="line-clamp-2" title={n.body}>
                                {n.body}
                              </span>
                            </div>
                            <div className="pl-5 text-[11px] text-muted-foreground">{n.author}</div>
                          </Cell>
                          <Cell className="text-muted-foreground">
                            <Context projectId={items.id} stepId={n.stepId} name={n.stepId ? items.stepNames[n.stepId] : undefined} />
                          </Cell>
                          <DateCell iso={n.editedAt ?? n.createdAt} timeZone={timeZone} />
                          <Cell className="text-right">
                            <RestoreButton
                              busy={busyIds.has(n.id)}
                              label="Restore note"
                              onClick={() =>
                                restore({
                                  ids: [n.id],
                                  queueKey: items.id,
                                  call: (opId) => restoreNoteAction(opId, items.id, n.id),
                                  success: () => ({
                                    title: "Note restored",
                                    action: n.stepId ? { label: "Show", href: `/projects/${items.id}?node=${n.stepId}` } : undefined,
                                  }),
                                })
                              }
                            />
                          </Cell>
                        </Row>
                      ))}
                    </DenseTable>
                  ) : (
                    <SectionEmpty filtered={Boolean(q) && items.notes.some((x) => !hidden.has(x.id))}>
                      No deleted notes. Deleted notes come here; their text also stays in the history.
                    </SectionEmpty>
                  )}
                </ItemSection>

                <ItemSection title="Files & links" count={files.length}>
                  {files.length ? (
                    <DenseTable head={["File or link", "On", "Added", ""]} widths={["", "w-56", "w-44", "w-28"]} flush>
                      {files.map((a) => (
                        <Row key={a.id}>
                          <Cell className="max-w-0">
                            <div className="flex items-center gap-1.5">
                              {a.kind === "LINK" ? (
                                <Link2 className="size-3.5 shrink-0 text-muted-foreground" aria-label="Link" />
                              ) : (
                                <Paperclip className="size-3.5 shrink-0 text-muted-foreground" aria-label="File" />
                              )}
                              <span className="truncate font-medium" title={a.name}>
                                {a.name}
                              </span>
                              <span className="shrink-0 text-[11px] text-muted-foreground">
                                {a.kind === "LINK" ? hostOf(a.url) : fileSize(a.size)}
                              </span>
                            </div>
                          </Cell>
                          <Cell className="text-muted-foreground">
                            <Context projectId={items.id} stepId={a.stepId} name={a.stepId ? items.stepNames[a.stepId] : undefined} />
                          </Cell>
                          <DateCell iso={a.createdAt} timeZone={timeZone} />
                          <Cell className="text-right">
                            <RestoreButton
                              busy={busyIds.has(a.id)}
                              label={`Restore ${a.kind === "LINK" ? "link" : "file"} “${a.name}”`}
                              onClick={() =>
                                restore({
                                  ids: [a.id],
                                  queueKey: items.id,
                                  call: (opId) => restoreAttachmentAction(opId, a.id),
                                  success: () => ({
                                    title: `${a.kind === "LINK" ? "Link" : "File"} “${a.name}” restored`,
                                    action: a.stepId ? { label: "Show", href: `/projects/${items.id}?node=${a.stepId}` } : undefined,
                                  }),
                                })
                              }
                            />
                          </Cell>
                        </Row>
                      ))}
                    </DenseTable>
                  ) : (
                    <SectionEmpty filtered={Boolean(q) && items.attachments.some((x) => !hidden.has(x.id))}>No removed files or links.</SectionEmpty>
                  )}
                </ItemSection>
              </div>
            ) : (
              <EmptyState title="Project not found">It may have been removed in Notion. Choose another project.</EmptyState>
            )}
          </TabsContent>

          <TabsContent value="snapshots" className="m-0">
            {snapRows.length ? (
              <>
                <p className="border-b px-4 py-2 text-xs text-muted-foreground">
                  The app saves the whole template before every import and reset. To go back, download a snapshot and use Import JSON in
                  Template Flow.
                </p>
                <DenseTable head={["Saved", "What", "Template", ""]} widths={["w-44", "", "w-64", "w-44"]}>
                  {snapRows.map((s) => (
                    <Row key={s.id}>
                      <DateCell iso={s.occurredAt} timeZone={timeZone} />
                      <Cell className="max-w-0 truncate" title={s.summary}>
                        {s.summary}
                      </Cell>
                      <Cell className="text-muted-foreground tabular-nums">
                        {s.milestoneCount !== null ? `${s.milestoneCount} milestones · ${s.edgeCount} arrows` : "—"}
                        {s.revision !== null ? <span className="ml-1.5 text-[11px]">rev {s.revision}</span> : null}
                      </Cell>
                      <Cell className="text-right">
                        <SnapshotDownload row={s} timeZone={timeZone} />
                      </Cell>
                    </Row>
                  ))}
                </DenseTable>
                {snapshots.nextCursor ? (
                  <div className="flex justify-center py-3">
                    <Button variant="outline" size="sm" onClick={() => void loadMoreSnapshots()} disabled={loadingMore}>
                      {loadingMore ? <Loader2 className="animate-spin" aria-hidden /> : null}
                      Show older snapshots
                    </Button>
                  </div>
                ) : null}
              </>
            ) : (
              <Empty filtered={Boolean(q) && snapshots.items.length > 0} title="No template snapshots yet">
                Before every template import and every “Reset template to seed”, the app saves the whole template here so you can go back.
              </Empty>
            )}
          </TabsContent>
        </div>
      </Tabs>
    </main>
  );
}

function SnapshotDownload({ row, timeZone }: { row: SnapshotRow; timeZone: string }) {
  const [busy, setBusy] = useState(false);
  if (!row.hasFile) return <span className="text-xs text-muted-foreground">No file saved</span>;
  async function download() {
    setBusy(true);
    try {
      const res = await fetch(`/api/template-snapshot/${encodeURIComponent(row.id)}`, { cache: "no-store" });
      if (res.status === 401) {
        toastError({ error: "Session expired. Sign in again.", code: "SESSION" });
        return;
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        toast.error("Could not download the snapshot", { description: body?.error ?? "Try again in a moment." });
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `gunnebo-pm-template-before-${row.reason ?? "import"}-${ymdIn(row.occurredAt, timeZone)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch {
      toast.error("Could not download the snapshot", { description: "Check your connection and try again." });
    } finally {
      setBusy(false);
    }
  }
  return (
    <Button variant="outline" size="sm" onClick={() => void download()} disabled={busy} aria-label={`Download snapshot from ${when(row.occurredAt, timeZone)} as JSON`}>
      {busy ? <Loader2 className="animate-spin" aria-hidden /> : <FileJson aria-hidden />}
      Download JSON
    </Button>
  );
}

function RestoreButton({ busy, label, text, onClick }: { busy: boolean; label: string; text?: string; onClick: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="outline" size="xs" onClick={onClick} disabled={busy} aria-label={label}>
          {busy ? <Loader2 className="animate-spin" aria-hidden /> : <RotateCcw aria-hidden />}
          {text ?? "Restore"}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function Context({ projectId, stepId, name }: { projectId: string; stepId: string | null; name?: string }) {
  if (!stepId) return <span>Project</span>;
  return (
    <Link
      href={`/projects/${projectId}?node=${stepId}`}
      className="inline-flex max-w-full items-center gap-0.5 text-foreground/80 underline decoration-muted-foreground/40 underline-offset-4 hover:text-foreground hover:decoration-foreground"
      title={name ? `Open the project at “${name}”` : "Open the project at this milestone"}
    >
      <span className="truncate">{name ?? "Milestone"}</span>
      <ArrowUpRight className="size-3 shrink-0" aria-hidden />
    </Link>
  );
}

function DenseTable({
  head,
  widths,
  children,
  flush,
}: {
  head: string[];
  widths: string[];
  children: React.ReactNode;
  flush?: boolean;
}) {
  return (
    <div className={cn(flush && "overflow-hidden rounded-lg border")}>
      <table className="w-full table-fixed border-collapse text-[13px]">
        <thead className="sticky top-0 z-10 bg-background">
          <tr className="h-8 border-b text-left text-xs text-muted-foreground">
            {head.map((h, i) => (
              <th key={i} scope="col" className={cn("px-3 font-medium first:pl-4 last:pr-4", widths[i])}>
                {h ? h : <span className="sr-only">Actions</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return <tr className="h-9 border-b last:border-b-0 hover:bg-muted/40">{children}</tr>;
}

function Cell({ children, className, title }: { children: React.ReactNode; className?: string; title?: string }) {
  return (
    <td className={cn("truncate px-3 py-1 first:pl-4 last:pr-4", className)} title={title}>
      {children}
    </td>
  );
}

function DateCell({ iso, timeZone }: { iso: string | null; timeZone: string }) {
  return <Cell className="tabular-nums text-muted-foreground">{when(iso, timeZone)}</Cell>;
}

function ItemSection({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="flex items-center gap-2 text-sm font-semibold">
        {title}
        <span className="rounded-full bg-muted px-1.5 text-[11px] font-normal tabular-nums text-muted-foreground">{count}</span>
      </h2>
      {children}
    </section>
  );
}

function SectionEmpty({ children, filtered }: { children: React.ReactNode; filtered?: boolean }) {
  return (
    <p className="rounded-lg border border-dashed px-3 py-3 text-xs text-muted-foreground">
      {filtered ? "Nothing here matches the filter." : children}
    </p>
  );
}

function Empty({ title, filtered, children }: { title: string; filtered: boolean; children: React.ReactNode }) {
  if (filtered) return <EmptyState title="Nothing matches the filter">Clear the filter to see every archived item.</EmptyState>;
  return <EmptyState title={title}>{children}</EmptyState>;
}

function ItemsSkeleton() {
  return (
    <div className="space-y-3 px-4 py-4" aria-hidden>
      {[0, 1, 2].map((i) => (
        <div key={i} className="space-y-2">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
      ))}
    </div>
  );
}
