"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { CalendarClock, Check, Clock, Loader2, StickyNote, X } from "lucide-react";
import { formatInstant } from "@/domain/dates";
import type { OpenItem } from "@/server/queries";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { StateDot } from "@/components/state/state-badge";
import { openItemNotesAction, type NoteSnippet } from "@/app/(app)/portfolio/actions";
import { callAction } from "@/components/shell/action-call";
import { Kbd } from "@/components/shell/kbd";

const AMBER_DAYS = 14;
const RED_DAYS = 30;

function Age({ days, since, timeZone }: { days: number | null; since: string | null; timeZone: string }) {
  if (days === null) return <span className="text-muted-foreground/60">—</span>;
  const red = days >= RED_DAYS;
  const amber = !red && days >= AMBER_DAYS;
  return (
    <span
      title={since ? `In this state since ${formatInstant(since, timeZone)} (${days} ${days === 1 ? "day" : "days"})` : undefined}
      className={cn(
        "rounded px-1 text-[11px] font-medium tabular-nums",
        red && "state-b bg-[var(--s-bg)] text-[var(--s-fg)]",
        amber && "state-w bg-[var(--s-bg)] text-[var(--s-fg)]",
        !red && !amber && "text-muted-foreground",
      )}
    >
      {days}d
      {red ? <span className="sr-only"> (30 days or more)</span> : amber ? <span className="sr-only"> (14 days or more)</span> : null}
    </span>
  );
}

function Chip({
  on,
  count,
  onClick,
  pending,
  icon: Icon,
  children,
}: {
  on: boolean;
  count: number;
  onClick: () => void;
  pending: boolean;
  icon: typeof Clock;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      disabled={pending}
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-60",
        on
          ? "border-foreground/25 bg-accent font-medium text-accent-foreground"
          : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
      )}
    >
      {on ? <Check className="size-3" aria-hidden /> : <Icon className="size-3" aria-hidden />}
      {children}
      {!on && count > 0 ? <span className="tabular-nums opacity-70">({count})</span> : null}
    </button>
  );
}

/**
 * "My open items": In progress + Blocked steps of the projects in the grid (Waiting and date-driven items behind
 * chips), oldest first. A row opens the step on its project's flow chart.
 */
export function OpenItemsPanel({
  items,
  hidden,
  includeWaiting,
  includeDateDriven,
  onToggleWaiting,
  onToggleDateDriven,
  pending,
  onClose,
  timeZone,
}: {
  items: OpenItem[];
  hidden: { waiting: number; dateDriven: number };
  includeWaiting: boolean;
  includeDateDriven: boolean;
  onToggleWaiting: () => void;
  onToggleDateDriven: () => void;
  pending: boolean;
  onClose: () => void;
  timeZone: string;
}) {
  const router = useRouter();
  const [notes, setNotes] = useState<Record<string, NoteSnippet>>({});
  const [notesLoading, setNotesLoading] = useState(false);

  // Latest note per item, loaded after the list shows (one notes read per project).
  const wanted = useMemo(() => {
    const by: Record<string, string[]> = {};
    for (const it of items.slice(0, 300)) (by[it.projectId] ??= []).push(it.stepId);
    return by;
  }, [items]);
  const wantedKey = useMemo(() => JSON.stringify(wanted), [wanted]);
  useEffect(() => {
    const byProject = JSON.parse(wantedKey) as Record<string, string[]>;
    if (!Object.keys(byProject).length) return;
    let cancelled = false;
    setNotesLoading(true);
    void callAction(() => openItemNotesAction(byProject), { retries: 1 }).then((r) => {
      if (cancelled) return;
      setNotesLoading(false);
      if (r.ok) setNotes(r.data);
    });
    return () => {
      cancelled = true;
    };
  }, [wantedKey]);

  const hiddenTotal = (includeWaiting ? 0 : hidden.waiting) + (includeDateDriven ? 0 : hidden.dateDriven);

  return (
    <aside aria-labelledby="open-items-title" className="flex w-[330px] shrink-0 flex-col border-l bg-background">
      <div className="flex h-11 items-center gap-2 border-b px-3">
        <h2 id="open-items-title" className="text-sm font-semibold">
          My open items
        </h2>
        <span className="rounded-full bg-muted px-1.5 text-[11px] text-muted-foreground tabular-nums">{items.length}</span>
        {pending ? <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-label="Updating" /> : null}
        <span className="ml-auto" />
        <Kbd>O</Kbd>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Hide My open items">
          <X aria-hidden />
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 border-b px-3 py-2">
        <Chip on={includeWaiting} count={hidden.waiting} onClick={onToggleWaiting} pending={pending} icon={Clock}>
          + Waiting
        </Chip>
        <Chip on={includeDateDriven} count={hidden.dateDriven} onClick={onToggleDateDriven} pending={pending} icon={CalendarClock}>
          Include date-driven items
        </Chip>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {items.length === 0 ? (
          <div className="px-4 py-10 text-center">
            <p className="text-sm font-medium">Nothing in progress or blocked</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {hiddenTotal > 0
                ? `${hiddenTotal} ${hiddenTotal === 1 ? "item is" : "items are"} hidden by the chips above.`
                : "Steps you start or flag show up here, oldest first."}
            </p>
          </div>
        ) : (
          <ul className={cn("divide-y divide-border/70", pending && "opacity-60")}>
            {items.map((it) => {
              const href = `/projects/${encodeURIComponent(it.projectId)}?view=flow&node=${encodeURIComponent(it.stepId)}`;
              const note = notes[it.stepId];
              return (
                <li key={it.stepId}>
                  <a
                    href={href}
                    onClick={(e) => {
                      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                      e.preventDefault();
                      router.push(href);
                    }}
                    className="block px-3 py-1.5 outline-none hover:bg-accent/60 focus-visible:bg-accent focus-visible:shadow-[inset_2px_0_0_var(--ring)]"
                  >
                    <span className="flex items-center gap-2">
                      <StateDot
                        state={it.state}
                        title={`${it.flag ? "Flagged " : ""}${it.state === "BLOCKED" ? "Blocked" : it.state === "WAITING" ? "Waiting" : "In progress"}`}
                      />
                      <span className="w-[68px] shrink-0 truncate font-mono text-[11px] font-semibold">{it.code}</span>
                      <span className="min-w-0 flex-1 truncate text-[13px]" title={it.name}>
                        {it.name}
                      </span>
                      <Age days={it.ageDays} since={it.since} timeZone={timeZone} />
                    </span>
                    <span className="mt-0.5 flex items-center gap-2 pl-[18px] text-xs text-muted-foreground">
                      <span className="max-w-[45%] shrink-0 truncate text-foreground/80 tabular-nums" title={it.value}>
                        {it.value}
                      </span>
                      {note ? (
                        <span className="flex min-w-0 items-center gap-1" title={note.body}>
                          <StickyNote className="size-3 shrink-0" aria-hidden />
                          <span className="truncate">{note.body}</span>
                        </span>
                      ) : notesLoading ? (
                        <span className="h-2.5 w-24 animate-pulse rounded bg-muted" aria-hidden />
                      ) : null}
                    </span>
                  </a>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </aside>
  );
}
