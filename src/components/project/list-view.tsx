"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, MinusCircle, Paperclip, Pin, StickyNote, X } from "lucide-react";
import { toast } from "sonner";
import type { Value } from "@/domain/types";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import { StateBadge } from "@/components/state/state-badge";
import { ValueEditor } from "@/components/fields/value-editor";
import { EmptyState } from "@/components/common/empty-state";
import { useProject } from "./context";
import { useProjectHotkeys } from "./use-project-hotkeys";
import { relative, useNow } from "./format";
import { Kbd } from "./kbd";
import type { StepView } from "./types";

type Filter = "all" | "current" | "open" | "blocked" | "waiting" | "done";
const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "current", label: "Current" },
  { value: "open", label: "Open" },
  { value: "blocked", label: "Blocked" },
  { value: "waiting", label: "Waiting" },
  { value: "done", label: "Done" },
];
const FILTER_KEY = "gpm.project.list.filter";
const INLINE_TYPES = new Set(["TEXT", "NUMBER", "PERCENT"]);

function matches(s: StepView, f: Filter, hideNa: boolean): boolean {
  if (hideNa && s.state === "NOT_APPLICABLE") return false;
  switch (f) {
    case "all":
      return true;
    case "current":
      return s.isCurrent;
    case "open":
      return s.state !== "DONE" && s.state !== "NOT_APPLICABLE";
    case "blocked":
      return s.state === "BLOCKED";
    case "waiting":
      return s.state === "WAITING";
    case "done":
      return s.state === "DONE";
  }
}

/** Enter / Space on a focused button or checkbox belongs to that control, not to the list. */
function onControl(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return Boolean(t?.closest?.("button, a, [role='radio'], [role='checkbox'], [role='switch']"));
}

function inlineText(s: StepView): string {
  const v = s.value as Record<string, unknown> | null;
  if (!v) return "";
  if (s.fieldType === "TEXT") return String(v.text ?? "");
  if (s.fieldType === "NUMBER") return v.number === undefined ? "" : String(v.number);
  if (s.fieldType === "PERCENT") return v.percent === undefined ? "" : String(v.percent);
  return "";
}

/** Parses the inline input; `undefined` = not valid (keep editing). */
function parseInline(s: StepView, text: string): Value | null | undefined {
  const t = text.trim();
  if (!t) return null;
  if (s.fieldType === "TEXT") return { text: t };
  const n = Number(t.replace(/,/g, "").replace(/%$/, "").trim());
  if (!Number.isFinite(n)) return undefined;
  if (s.fieldType === "PERCENT") {
    if (n < 0 || n > 100) return undefined;
    return { percent: Math.round(n) };
  }
  return { number: n };
}

export function ListView({ hotkeysEnabled }: { hotkeysEnabled: boolean }) {
  const { view, raw, api, readOnly, openStep, selectedId, timeZone } = useProject();
  const [filter, setFilter] = useState<Filter>("all");
  const [hideNa, setHideNa] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [active, setActive] = useState<string | null>(selectedId);
  const [editing, setEditing] = useState<string | null>(null);
  const [bulk, setBulk] = useState<{ done: number; total: number; na: boolean } | null>(null);
  const rowRefs = useRef(new Map<string, HTMLTableRowElement>());
  // With the side panel open the table is narrower: the latest note is in the panel anyway.
  const narrow = selectedId !== null;
  const now = useNow();

  useEffect(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem(FILTER_KEY) ?? "null") as { filter?: Filter; hideNa?: boolean } | null;
      if (saved?.filter && FILTERS.some((f) => f.value === saved.filter)) setFilter(saved.filter);
      if (typeof saved?.hideNa === "boolean") setHideNa(saved.hideNa);
    } catch {
      /* ignore */
    }
  }, []);
  function remember(next: { filter?: Filter; hideNa?: boolean }) {
    try {
      window.localStorage.setItem(FILTER_KEY, JSON.stringify({ filter, hideNa, ...next }));
    } catch {
      /* ignore */
    }
  }

  const rows = useMemo(() => view.steps.filter((s) => matches(s, filter, hideNa)), [view.steps, filter, hideNa]);
  const counts = useMemo(() => {
    const out: Record<Filter, number> = { all: 0, current: 0, open: 0, blocked: 0, waiting: 0, done: 0 };
    for (const s of view.steps) for (const f of FILTERS) if (matches(s, f.value, hideNa)) out[f.value]++;
    return out;
  }, [view.steps, hideNa]);

  // Keep the panel's step as the active row when it changes elsewhere (Current chips, J/K in the panel).
  useEffect(() => {
    if (selectedId) setActive(selectedId);
  }, [selectedId]);

  useEffect(() => {
    if (active) rowRefs.current.get(active)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  // Drop checks of rows that disappeared (archived).
  useEffect(() => {
    setChecked((c) => {
      const next = new Set([...c].filter((id) => view.byId.has(id)));
      return next.size === c.size ? c : next;
    });
  }, [view.byId]);

  function move(delta: number) {
    if (!rows.length) return;
    const i = active ? rows.findIndex((r) => r.id === active) : -1;
    const next = rows[Math.max(0, Math.min(rows.length - 1, i < 0 ? (delta > 0 ? 0 : rows.length - 1) : i + delta))];
    setActive(next.id);
    if (selectedId) openStep(next.id, null, { focus: false });
  }

  const activeStep = active ? view.byId.get(active) : undefined;

  useProjectHotkeys(
    {
      arrowdown: (e) => {
        e.preventDefault();
        move(1);
      },
      j: (e) => {
        e.preventDefault();
        move(1);
      },
      arrowup: (e) => {
        e.preventDefault();
        move(-1);
      },
      k: (e) => {
        e.preventDefault();
        move(-1);
      },
      enter: (e) => {
        if (!activeStep || readOnly || onControl(e)) return;
        e.preventDefault();
        setEditing(activeStep.id);
      },
      x: (e) => {
        if (!activeStep || readOnly) return;
        e.preventDefault();
        void api.setNotApplicable(activeStep.id, !activeStep.notApplicable);
      },
      n: (e) => {
        if (!activeStep) return;
        e.preventDefault();
        openStep(activeStep.id, "notes");
      },
      o: (e) => {
        if (!activeStep) return;
        e.preventDefault();
        openStep(activeStep.id);
      },
      " ": (e) => {
        if (!activeStep || readOnly || onControl(e)) return;
        e.preventDefault();
        toggleCheck(activeStep.id);
      },
    },
    hotkeysEnabled && editing === null,
  );

  function toggleCheck(id: string) {
    setChecked((c) => {
      const next = new Set(c);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const allChecked = rows.length > 0 && rows.every((r) => checked.has(r.id));
  const someChecked = rows.some((r) => checked.has(r.id));

  async function runBulk(na: boolean) {
    const ids = view.steps.filter((s) => checked.has(s.id) && s.notApplicable !== na).map((s) => s.id);
    if (!ids.length) {
      setChecked(new Set());
      return;
    }
    setBulk({ done: 0, total: ids.length, na });
    const r = await api.bulkNotApplicable(ids, na, (done, total) => setBulk({ done, total, na }));
    setBulk(null);
    if (r.ok) {
      setChecked(new Set());
      toast.success(na ? `Marked ${r.done} milestone${r.done === 1 ? "" : "s"} not applicable` : `Cleared N/A on ${r.done} milestone${r.done === 1 ? "" : "s"}`);
    }
  }

  function startNextEdit(fromId: string) {
    const i = rows.findIndex((r) => r.id === fromId);
    const next = rows[i + 1];
    if (next) {
      setActive(next.id);
      setEditing(next.id);
    } else setEditing(null);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
        <div role="radiogroup" aria-label="Show" className="inline-flex rounded-md border p-0.5">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              role="radio"
              aria-checked={filter === f.value}
              onClick={() => {
                setFilter(f.value);
                remember({ filter: f.value });
              }}
              className={cn(
                "inline-flex h-6 items-center gap-1 rounded px-2 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                filter === f.value ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {f.label}
              <span className="tabular-nums text-[10px] text-muted-foreground">{counts[f.value]}</span>
            </button>
          ))}
        </div>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Switch
            checked={hideNa}
            onCheckedChange={(v) => {
              setHideNa(v);
              remember({ hideNa: v });
            }}
            aria-label="Hide not applicable"
          />
          Hide N/A
        </label>
        <div className="flex-1" />
        {bulk ? (
          <div className="flex min-w-64 items-center gap-2 text-xs" role="status">
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
            <span className="tabular-nums">
              {bulk.na ? "Marking" : "Clearing"} {bulk.done} of {bulk.total}…
            </span>
            <Progress value={bulk.total ? (100 * bulk.done) / bulk.total : 0} className="w-28" />
          </div>
        ) : checked.size > 0 ? (
          <div className="flex items-center gap-1.5 text-xs">
            <span className="font-medium tabular-nums">{checked.size} selected</span>
            <Button size="xs" variant="outline" onClick={() => void runBulk(true)} disabled={readOnly}>
              <MinusCircle aria-hidden /> Mark not applicable
            </Button>
            <Button size="xs" variant="outline" onClick={() => void runBulk(false)} disabled={readOnly}>
              Clear N/A
            </Button>
            <Button size="icon-xs" variant="ghost" aria-label="Clear selection" onClick={() => setChecked(new Set())}>
              <X aria-hidden />
            </Button>
          </div>
        ) : (
          <p className="hidden text-[11px] text-muted-foreground lg:block">
            <Kbd>↑</Kbd> <Kbd>↓</Kbd> move · <Kbd>Enter</Kbd> edit · <Kbd>X</Kbd> N/A · <Kbd>N</Kbd> note · <Kbd>O</Kbd> open · <Kbd>Space</Kbd> select
          </p>
        )}
      </div>

      <div className="relative min-h-0 flex-1 overflow-auto">
        {rows.length === 0 ? (
          <EmptyState
            title={view.steps.length ? "No milestones match this filter" : "This project has no milestones"}
            action={
              view.steps.length ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setFilter("all");
                    setHideNa(false);
                    remember({ filter: "all", hideNa: false });
                  }}
                >
                  Show all milestones
                </Button>
              ) : undefined
            }
          >
            {view.steps.length ? "Try another filter." : "Add a project step from the Flow view, or Sync from the template."}
          </EmptyState>
        ) : (
          <table className="w-full min-w-[760px] table-fixed border-separate border-spacing-0 text-sm" aria-label="Milestones in flow order">
            <colgroup>
              <col className="w-9" />
              <col className="w-11" />
              <col className="w-32" />
              <col />
              <col className={narrow ? "w-48" : "w-56"} />
              <col className="w-28" />
              {narrow ? null : <col className="w-64" />}
              <col className="w-20" />
            </colgroup>
            <thead className="sticky top-0 z-10 bg-background text-left text-xs text-muted-foreground">
              <tr className="[&>th]:h-8 [&>th]:border-b [&>th]:px-2 [&>th]:font-medium">
                <th>
                  <Checkbox
                    checked={allChecked ? true : someChecked ? "indeterminate" : false}
                    onCheckedChange={(v) =>
                      setChecked((c) => {
                        const next = new Set(c);
                        for (const r of rows) {
                          if (v) next.add(r.id);
                          else next.delete(r.id);
                        }
                        return next;
                      })
                    }
                    aria-label="Select all shown"
                    disabled={readOnly}
                  />
                </th>
                <th className="text-right">#</th>
                <th>State</th>
                <th>Milestone</th>
                <th>Value</th>
                <th>Last changed</th>
                {narrow ? null : <th>Latest note</th>}
                <th className="text-right">
                  <span className="sr-only">Notes and files</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <Row
                  key={s.id}
                  s={s}
                  refFn={(el) => {
                    if (el) rowRefs.current.set(s.id, el);
                    else rowRefs.current.delete(s.id);
                  }}
                  active={active === s.id}
                  open={selectedId === s.id}
                  checked={checked.has(s.id)}
                  onCheck={() => toggleCheck(s.id)}
                  editing={editing === s.id}
                  onEdit={(on) => {
                    setActive(s.id);
                    setEditing(on ? s.id : null);
                  }}
                  onTabNext={() => startNextEdit(s.id)}
                  onActivate={() => setActive(s.id)}
                  onOpen={(section) => {
                    setActive(s.id);
                    openStep(s.id, section);
                  }}
                  onCommit={(v) => void api.setValue(s.id, v)}
                  readOnly={readOnly}
                  today={raw.today}
                  lastChanged={relative(s.lastChangedAt, now, timeZone)}
                  showNote={!narrow}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function Row({
  s,
  refFn,
  active,
  open,
  checked,
  onCheck,
  editing,
  onEdit,
  onTabNext,
  onActivate,
  onOpen,
  onCommit,
  readOnly,
  today,
  lastChanged,
  showNote,
}: {
  s: StepView;
  refFn: (el: HTMLTableRowElement | null) => void;
  active: boolean;
  open: boolean;
  checked: boolean;
  onCheck: () => void;
  editing: boolean;
  onEdit: (on: boolean) => void;
  onTabNext: () => void;
  onActivate: () => void;
  onOpen: (section?: "notes" | "files") => void;
  onCommit: (v: Value | null) => void;
  readOnly: boolean;
  today: string;
  lastChanged: string;
  showNote: boolean;
}) {
  return (
    <tr
      ref={refFn}
      onClick={onActivate}
      aria-selected={active}
      data-state={s.state}
      className={cn(
        "group h-8 [&>td]:border-b [&>td]:border-border/60 [&>td]:px-2",
        active ? "bg-muted/70 [&>td:first-child]:shadow-[inset_2px_0_0_var(--foreground)]" : "hover:bg-muted/40",
        checked && !active && "bg-accent/40",
        s.state === "NOT_APPLICABLE" && "text-muted-foreground",
      )}
    >
      <td onClick={(e) => e.stopPropagation()}>
        <Checkbox checked={checked} onCheckedChange={onCheck} aria-label={`Select ${s.name}`} disabled={readOnly} />
      </td>
      <td className="text-right text-xs text-muted-foreground tabular-nums">{s.seq}</td>
      <td>
        <StateBadge state={s.state} className="max-w-full truncate" />
      </td>
      <td className="truncate">
        <span className="flex min-w-0 items-center gap-1.5">
          {s.isCurrent ? (
            <span className="size-2 shrink-0 rounded-full bg-[var(--current-ring)]" title="Current milestone">
              <span className="sr-only">Current</span>
            </span>
          ) : null}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onOpen();
            }}
            className={cn("min-w-0 truncate text-left hover:underline", open && "font-medium")}
            title={s.name}
          >
            {s.name}
          </button>
          {s.projectOnly ? (
            <span title="Project-only step" className="shrink-0 rounded-sm border px-0.5 text-[9px] font-semibold leading-none text-muted-foreground">
              P
            </span>
          ) : null}
          {s.flag ? <Pin className="size-3 shrink-0 text-muted-foreground" aria-label={`Flagged ${s.flag === "BLOCKED" ? "Blocked" : "Waiting"}`} /> : null}
        </span>
      </td>
      <td className="truncate" onClick={(e) => e.stopPropagation()}>
        <ValueCell s={s} editing={editing} onEdit={onEdit} onTabNext={onTabNext} onCommit={onCommit} readOnly={readOnly} today={today} onOpen={onOpen} />
      </td>
      <td className="truncate text-xs text-muted-foreground tabular-nums">{lastChanged}</td>
      {showNote ? (
      <td className="truncate text-xs">
        {s.latestNote ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onOpen("notes");
            }}
            className="w-full truncate text-left text-muted-foreground hover:text-foreground hover:underline"
            title={s.latestNote.body}
          >
            {s.latestNote.body.replace(/\s+/g, " ")}
          </button>
        ) : null}
      </td>
      ) : null}
      <td className="text-right text-[11px] text-muted-foreground tabular-nums">
        <span className="inline-flex items-center gap-2">
          {s.noteCount ? (
            <span className="inline-flex items-center gap-0.5" title={`${s.noteCount} note(s)`}>
              <StickyNote className="size-3" aria-hidden />
              {s.noteCount}
            </span>
          ) : null}
          {s.attachmentCount ? (
            <span className="inline-flex items-center gap-0.5" title={`${s.attachmentCount} file(s) or link(s)`}>
              <Paperclip className="size-3" aria-hidden />
              {s.attachmentCount}
            </span>
          ) : null}
        </span>
      </td>
    </tr>
  );
}

function ValueCell({
  s,
  editing,
  onEdit,
  onTabNext,
  onCommit,
  readOnly,
  today,
  onOpen,
}: {
  s: StepView;
  editing: boolean;
  onEdit: (on: boolean) => void;
  onTabNext: () => void;
  onCommit: (v: Value | null) => void;
  readOnly: boolean;
  today: string;
  onOpen: (section?: "notes" | "files") => void;
}) {
  const inline = INLINE_TYPES.has(s.fieldType);
  const empty = s.display === "—";
  const display = (
    <button
      type="button"
      disabled={readOnly}
      onClick={() => (s.fieldType === "FILE" ? onOpen("files") : onEdit(true))}
      className={cn(
        "-mx-1 flex h-6 w-[calc(100%+0.5rem)] items-center rounded px-1 text-left tabular-nums hover:bg-background hover:ring-1 hover:ring-border disabled:hover:bg-transparent disabled:hover:ring-0",
        empty && "text-muted-foreground",
      )}
      title={s.fieldType === "FILE" ? "Add files or links in the panel" : `${s.display} (click or Enter to edit)`}
    >
      <span className="truncate">{s.display}</span>
    </button>
  );

  if (inline && editing) return <InlineInput s={s} onDone={() => onEdit(false)} onTabNext={onTabNext} onCommit={onCommit} />;
  if (inline || s.fieldType === "FILE") return display;

  return (
    <Popover open={editing} onOpenChange={(o) => onEdit(o)}>
      <PopoverAnchor asChild>{display}</PopoverAnchor>
      <PopoverContent align="start" className="w-72 p-3" onOpenAutoFocus={(e) => e.preventDefault()}>
        <div className="mb-2 truncate text-xs font-medium text-muted-foreground">{s.name}</div>
        <ValueEditor
          def={{ fieldType: s.fieldType, choices: s.choices, config: s.config }}
          value={s.value}
          today={today}
          label={s.name}
          compact
          autoFocus
          onCommit={(v) => {
            onCommit(v);
            if (s.fieldType === "DROPDOWN" || s.fieldType === "CHECKBOX") onEdit(false);
          }}
        />
        <p className="mt-2 text-[11px] text-muted-foreground">{s.reasonText}</p>
      </PopoverContent>
    </Popover>
  );
}

function InlineInput({ s, onDone, onTabNext, onCommit }: { s: StepView; onDone: () => void; onTabNext: () => void; onCommit: (v: Value | null) => void }) {
  const [text, setText] = useState(inlineText(s));
  const [invalid, setInvalid] = useState(false);
  const done = useRef(false);

  function commit(): boolean {
    const v = parseInline(s, text);
    if (v === undefined) {
      setInvalid(true);
      return false;
    }
    if (JSON.stringify(v) !== JSON.stringify(s.value ?? null)) onCommit(v);
    return true;
  }

  return (
    <div className="flex items-center gap-1">
      <Input
        autoFocus
        value={text}
        inputMode={s.fieldType === "TEXT" ? undefined : "decimal"}
        onChange={(e) => {
          setText(e.target.value);
          setInvalid(false);
        }}
        aria-invalid={invalid || undefined}
        aria-label={`${s.name} value`}
        title={invalid ? (s.fieldType === "PERCENT" ? "Enter a whole number from 0 to 100" : "Enter a number") : undefined}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (commit()) {
              done.current = true;
              onDone();
            }
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            done.current = true;
            onDone();
          } else if (e.key === "Tab" && !e.shiftKey) {
            e.preventDefault();
            if (commit()) {
              done.current = true;
              onTabNext();
            }
          }
        }}
        onBlur={() => {
          if (done.current) return;
          if (!commit()) {
            toast.error(`"${text.trim()}" was not saved`, {
              description: s.fieldType === "PERCENT" ? "Enter a whole number from 0 to 100." : "Enter a number, for example 12 or 4.5.",
            });
          }
          onDone();
        }}
        className="h-6 px-1.5 text-sm tabular-nums"
      />
      {s.fieldType === "PERCENT" ? <span className="text-xs text-muted-foreground">%</span> : null}
      {s.fieldType === "NUMBER" && s.config.unit ? <span className="text-xs text-muted-foreground">{s.config.unit}</span> : null}
    </div>
  );
}
