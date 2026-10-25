"use client";

/** Building blocks shared by the Milestones and Project fields tables. */
import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useSortable } from "@dnd-kit/sortable";
import type { DraggableAttributes, DraggableSyntheticListeners } from "@dnd-kit/core";
import { ChevronDown, GripVertical } from "lucide-react";
import type { Choice, FieldType } from "@/domain/types";
import { FIELD_TYPE_META } from "@/domain/fieldTypes";
import { cn } from "@/lib/utils";
import { StateDot } from "@/components/state/state-badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { FieldTypeIcon } from "./field-type-icon";

// ---------------------------------------------------------------------------
// Sortable row + drag handle
// ---------------------------------------------------------------------------

export interface HandleBinding {
  attributes: DraggableAttributes;
  listeners: DraggableSyntheticListeners;
  setActivatorNodeRef: (el: HTMLElement | null) => void;
  disabled: boolean;
}

/**
 * A table row that can be dragged by its handle (first cell). Pass the other cells as `children`, created once per
 * row change (useMemo): dnd-kit re-renders every sortable row on many updates, and reusing the same child elements
 * keeps those re-renders down to the row and its handle.
 */
export function SortableRow({
  id,
  disabled,
  rowRef,
  handleLabel,
  className,
  children,
  ...rest
}: {
  id: string;
  disabled: boolean;
  rowRef?: (el: HTMLTableRowElement | null) => void;
  handleLabel: string;
  children: React.ReactNode;
} & Omit<React.HTMLAttributes<HTMLTableRowElement>, "children">) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id,
    disabled,
  });
  const style: React.CSSProperties = {
    transform: transform ? `translate3d(0, ${Math.round(transform.y)}px, 0)` : undefined,
    transition,
  };
  // A stable ref callback: a new one on every render would detach and re-attach the node in dnd-kit each time.
  const ref = useCallback(
    (el: HTMLTableRowElement | null) => {
      setNodeRef(el);
      rowRef?.(el);
    },
    [setNodeRef, rowRef],
  );
  return (
    <tr
      ref={ref}
      style={style}
      data-dragging={isDragging || undefined}
      className={cn(className, isDragging && "relative z-20 bg-background shadow-lg ring-1 ring-border")}
      {...rest}
    >
      <Td className="px-1.5">
        <DragHandle handle={{ attributes, listeners, setActivatorNodeRef, disabled }} label={handleLabel} />
      </Td>
      {children}
    </tr>
  );
}

export function DragHandle({ handle, label }: { handle: HandleBinding; label: string }) {
  const { attributes, listeners, setActivatorNodeRef, disabled } = handle;
  return (
    <button
      type="button"
      ref={setActivatorNodeRef}
      {...attributes}
      {...listeners}
      tabIndex={-1}
      aria-label={disabled ? `${label}: clear the search and filter to reorder` : `Drag ${label} to reorder (or select the row and press Alt+↑ / Alt+↓)`}
      title={disabled ? "Clear the search and type filter to reorder" : "Drag to reorder · Alt+↑/↓"}
      onClick={(e) => e.stopPropagation()}
      className={cn(
        "flex h-6 w-5 items-center justify-center rounded text-muted-foreground/60 transition-colors",
        disabled ? "cursor-not-allowed opacity-40" : "cursor-grab hover:bg-muted hover:text-foreground active:cursor-grabbing",
      )}
    >
      <GripVertical className="size-3.5" aria-hidden />
    </button>
  );
}

// ---------------------------------------------------------------------------
// Inline rename
// ---------------------------------------------------------------------------

export function InlineName({
  value,
  editing,
  onStartEdit,
  onCommit,
  onDone,
  label,
  maxLength = 500,
}: {
  value: string;
  editing: boolean;
  onStartEdit: () => void;
  /** Called with the trimmed new name when it changed and is not empty. */
  onCommit: (name: string) => void;
  /** Editing ended (committed or cancelled); `how` tells which key ended it. */
  onDone: (how: "enter" | "escape" | "blur") => void;
  label: string;
  maxLength?: number;
}) {
  const finished = useRef(false);
  const [draft, setDraft] = useState(value);
  // Start every edit from the current name (also when it starts from the keyboard).
  const [wasEditing, setWasEditing] = useState(editing);
  if (editing !== wasEditing) {
    setWasEditing(editing);
    if (editing) setDraft(value);
  }

  if (editing) {
    const finish = (how: "enter" | "escape" | "blur") => {
      if (finished.current) return;
      finished.current = true;
      const t = draft.trim().replace(/\s+/g, " ");
      if (how !== "escape" && t && t !== value) onCommit(t);
      onDone(how);
    };
    return (
      <input
        autoFocus
        value={draft}
        maxLength={maxLength}
        aria-label={`Rename ${label}`}
        onFocus={(e) => {
          finished.current = false;
          e.currentTarget.select();
        }}
        onChange={(e) => setDraft(e.target.value)}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.nativeEvent.isComposing) return;
          if (e.key === "Enter") {
            e.preventDefault();
            finish("enter");
          } else if (e.key === "Escape") {
            e.preventDefault();
            finish("escape");
          }
        }}
        onBlur={() => finish("blur")}
        className="h-6 w-full min-w-0 rounded-md border border-ring bg-background px-1.5 text-[13px] outline-none ring-2 ring-ring/30"
      />
    );
  }
  return (
    <button
      type="button"
      tabIndex={-1}
      // The full name too: long names are cut off in the cell.
      title={`${value}\nClick to rename`}
      onClick={(e) => {
        e.stopPropagation();
        onStartEdit();
      }}
      className="block max-w-full cursor-text truncate rounded-sm text-left font-medium decoration-muted-foreground/60 decoration-dotted underline-offset-4 hover:underline"
    >
      {value}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Choices preview: state dots + labels, "+n"
// ---------------------------------------------------------------------------

function ChoiceDot({ choice, withStates }: { choice: Choice; withStates: boolean }) {
  if (withStates) return <StateDot state={choice.state ?? "NOT_STARTED"} className="size-2" />;
  return <span aria-hidden className="inline-block size-1.5 shrink-0 rounded-full bg-muted-foreground/50" />;
}

export const ChoicesPreview = memo(function ChoicesPreview({
  fieldType,
  choices,
  withStates,
  budget = 30,
}: {
  fieldType: FieldType;
  choices: Choice[];
  withStates: boolean;
  /** Roughly how many characters of labels fit in the cell; the rest becomes "+n". */
  budget?: number;
}) {
  const meta = FIELD_TYPE_META[fieldType];
  if (!meta.hasChoices) return <span className="text-muted-foreground/50">—</span>;
  const active = choices.filter((c) => !c.archived);
  if (active.length === 0) return <span className="text-xs text-muted-foreground italic">No choices yet</span>;
  const states = withStates && meta.choicesHaveState;
  const shown: Choice[] = [];
  let used = 0;
  for (const c of active) {
    const cost = c.label.length + 3;
    if (shown.length > 0 && used + cost > budget + 3) break;
    shown.push(c);
    used += cost;
  }
  const rest = active.length - shown.length;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="flex min-w-0 items-center gap-2.5 overflow-hidden text-xs">
          {shown.map((c) => (
            <span key={c.id} className="inline-flex min-w-0 shrink items-center gap-1">
              <ChoiceDot choice={c} withStates={states} />
              <span className="truncate">{c.label}</span>
            </span>
          ))}
          {rest > 0 ? <span className="shrink-0 font-medium text-muted-foreground tabular-nums">+{rest}</span> : null}
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="start" className="block max-w-sm">
        <ul className="space-y-0.5">
          {active.map((c) => (
            <li key={c.id} className="flex items-center gap-1.5">
              {states ? <StateDot state={c.state ?? "NOT_STARTED"} className="size-2 ring-1 ring-background/40" /> : <span aria-hidden>·</span>}
              <span>{c.label}</span>
            </li>
          ))}
        </ul>
      </TooltipContent>
    </Tooltip>
  );
});

// ---------------------------------------------------------------------------
// Compact field type select for table cells
// ---------------------------------------------------------------------------

const TYPE_TRIGGER_CLASS =
  "flex h-7 w-full min-w-0 items-center gap-1.5 rounded-[min(var(--radius-md),10px)] border border-transparent bg-transparent px-1.5 text-left text-[13px] whitespace-nowrap outline-none transition-colors hover:border-input focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-input/30";

/**
 * Compact field type select for table cells. Renders a light button until first used, then the real select
 * (a Radix select keeps all its options mounted even while closed, which is costly across 60+ rows).
 */
export const TypeSelect = memo(function TypeSelect({
  value,
  types,
  onPick,
  label,
  disabled,
  disabledReason,
}: {
  value: FieldType;
  types: readonly FieldType[];
  onPick: (t: FieldType) => void;
  label: string;
  disabled?: boolean;
  disabledReason?: string;
}) {
  const [active, setActive] = useState(false);
  /** The table row, so focus can go back to it when the list closes. */
  const rowEl = useRef<HTMLElement | null>(null);
  const options = types.includes(value) ? types : [value, ...types];
  if (!active) {
    return (
      <button
        type="button"
        tabIndex={-1}
        disabled={disabled}
        title={disabled ? disabledReason : undefined}
        aria-label={`Field type of ${label}: ${FIELD_TYPE_META[value].label}`}
        aria-haspopup="listbox"
        className={cn(TYPE_TRIGGER_CLASS, "group/type")}
        onClick={(e) => {
          rowEl.current = e.currentTarget.closest("tr");
          setActive(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
            e.preventDefault();
            e.stopPropagation();
            rowEl.current = e.currentTarget.closest("tr");
            setActive(true);
          }
        }}
      >
        <FieldTypeIcon type={value} className="text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">{FIELD_TYPE_META[value].label}</span>
        <ChevronDown aria-hidden className="size-3.5 text-muted-foreground opacity-0 group-hover/type:opacity-100" />
      </button>
    );
  }
  return (
    <Select
      defaultOpen
      value={value}
      onValueChange={(v) => v !== value && onPick(v as FieldType)}
      onOpenChange={(open) => {
        if (open) return;
        const tr = rowEl.current;
        setActive(false);
        requestAnimationFrame(() => tr?.focus({ preventScroll: true }));
      }}
      disabled={disabled}
    >
      <SelectTrigger
        size="sm"
        autoFocus
        aria-label={`Field type of ${label}`}
        title={disabled ? disabledReason : undefined}
        className="h-7 w-full min-w-0 border-transparent bg-transparent px-1.5 text-[13px] shadow-none hover:border-input focus-visible:border-ring dark:bg-transparent dark:hover:bg-input/30"
        onKeyDown={(e) => e.stopPropagation()}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent
        position="popper"
        align="start"
        // Focus goes back to the row (see onOpenChange), not to the trigger, which goes away.
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        {options.map((t) => (
          <SelectItem key={t} value={t}>
            <FieldTypeIcon type={t} className="text-muted-foreground" />
            {FIELD_TYPE_META[t].label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
});

/** True when a key press comes from inside an open menu, list box or dialog (page shortcuts stay quiet there). */
export function fromOverlay(e: KeyboardEvent): boolean {
  const t = e.target;
  // Only open ones: while a dialog or list plays its closing animation, focus is still inside it.
  return (
    t instanceof Element &&
    Boolean(t.closest(":is([role=listbox],[role=menu],[role=dialog],[role=alertdialog]):not([data-state=closed])"))
  );
}

/** Keyboard key hint, e.g. <Kbd>N</Kbd>. */
export function Kbd({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        "inline-flex h-4.5 min-w-4.5 items-center justify-center rounded border bg-muted px-1 font-sans text-[10px] font-medium text-muted-foreground",
        className,
      )}
    >
      {children}
    </kbd>
  );
}

// ---------------------------------------------------------------------------
// Render helpers
// ---------------------------------------------------------------------------

type AnyFn = (...args: never[]) => unknown;

/**
 * Stable wrappers around the latest handlers, so memoized rows don't re-render when the parent does. Call the
 * returned functions only from events and effects (they read the handlers of the last commit).
 */
export function useStableHandlers<T extends { [K in keyof T]: AnyFn }>(handlers: T): T {
  const ref = useRef(handlers);
  useLayoutEffect(() => {
    ref.current = handlers;
  });
  // The set of keys never changes for a component, so the wrappers are created once.
  return useMemo(() => {
    const out: Record<string, AnyFn> = {};
    for (const k of Object.keys(handlers)) {
      out[k] = (...args: never[]) => (ref.current as Record<string, AnyFn>)[k](...args);
    }
    return out as T;
  }, []);
}

/**
 * Keeps the previous object for every row whose content didn't change, so a page refresh after a write re-renders
 * only the rows that changed.
 */
export function useStableRows<T extends { id: string }>(rows: T[]): T[] {
  const cache = useRef(new Map<string, { json: string; row: T }>());
  return useMemo(() => {
    const next = new Map<string, { json: string; row: T }>();
    const out = rows.map((r) => {
      const json = JSON.stringify(r);
      const prev = cache.current.get(r.id);
      const row = prev && prev.json === json ? prev.row : r;
      next.set(r.id, { json, row });
      return row;
    });
    cache.current = next;
    return out;
  }, [rows]);
}

/** A table cell; `stop` keeps clicks (also from portalled menus inside it) from reaching the row. */
export function Td({ className, children, stop }: { className?: string; children?: React.ReactNode; stop?: boolean }) {
  return (
    <td
      className={cn("h-8 overflow-hidden border-b border-border/60 px-2 py-0 align-middle", className)}
      onClick={stop ? (e) => e.stopPropagation() : undefined}
    >
      {children}
    </td>
  );
}

export function Th({ className, children }: { className?: string; children?: React.ReactNode }) {
  return (
    <th scope="col" className={cn("sticky top-0 z-10 h-8 border-b bg-background px-2 font-medium whitespace-nowrap", className)}>
      {children}
    </th>
  );
}

export const ROW_CLASS = cn(
  "group h-8 cursor-pointer outline-none",
  "hover:bg-muted/50 focus-visible:bg-muted/60 focus-visible:shadow-[inset_2px_0_0_var(--ring)]",
);
export const ROW_SELECTED_CLASS = "bg-accent shadow-[inset_2px_0_0_var(--primary)] hover:bg-accent";
