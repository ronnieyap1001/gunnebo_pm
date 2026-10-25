"use client";

import { memo, useCallback, useEffect, useMemo, useOptimistic, useRef, useState } from "react";
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { toast } from "sonner";
import { Archive, ArchiveRestore, ChevronRight, Info, Lock, MoreHorizontal, Pencil, Search, X } from "lucide-react";
import type { Choice, FieldConfig, FieldType } from "@/domain/types";
import { FIELD_TYPE_META } from "@/domain/fieldTypes";
import type { ProjectFieldRow } from "@/server/queries";
import { newOpId } from "@/lib/write-queue";
import { useHotkeys } from "@/lib/hotkeys";
import { cn } from "@/lib/utils";
import {
  archiveProjectFieldAction,
  createProjectFieldAction,
  restoreProjectFieldAction,
  updateProjectFieldAction,
} from "@/app/(app)/library/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/common/empty-state";
import type { DefPatch } from "./definition-editor";
import { FieldPanel, FIELD_TYPES_FOR_FIELDS, SYSTEM_FIELD_NOTE, SYSTEM_FIELD_TYPES, type BlockingProject, type TypeBlock } from "./field-panel";
import { FieldTypeIcon } from "./field-type-icon";
import { NewItemDialog } from "./new-item-dialog";
import {
  ChoicesPreview,
  InlineName,
  Kbd,
  ROW_CLASS,
  ROW_SELECTED_CLASS,
  SortableRow,
  Td,
  Th,
  TypeSelect,
  fromOverlay,
  useStableHandlers,
} from "./table-parts";
import { TypeChangeDialog, type TypeChangeEffectProps } from "./type-change";
import { QUEUE, queuedWrite, reportFailure, runWrite, type Failure } from "./write";

type Row = ProjectFieldRow;
interface FieldPatch {
  label?: string;
  fieldType?: FieldType;
  choices?: Choice[];
  config?: FieldConfig;
  showInSummary?: boolean;
  order?: number;
}
type Act = { type: "patch"; id: string; patch: Partial<Row> } | { type: "remove"; id: string };

function byOrder(a: Row, b: Row) {
  return a.order - b.order || a.key.localeCompare(b.key);
}

function reducer(rows: Row[], a: Act): Row[] {
  switch (a.type) {
    case "patch":
      return rows
        .map((r) =>
          r.id === a.id
            ? { ...r, ...a.patch, fieldTypeLabel: a.patch.fieldType ? FIELD_TYPE_META[a.patch.fieldType].label : r.fieldTypeLabel }
            : r,
        )
        .sort(byOrder);
    case "remove":
      return rows.filter((r) => r.id !== a.id);
  }
}

function blockingOf(f: Failure): BlockingProject[] | null {
  const b = f.details?.blocking;
  return Array.isArray(b) ? (b as BlockingProject[]) : null;
}

function formatDay(iso: string | null): string {
  if (!iso) return "";
  try {
    return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" }).format(new Date(iso));
  } catch {
    return "";
  }
}

export function FieldsTab({
  fields,
  selectedId,
  onSelect,
  newOpen,
  onNewOpenChange,
}: {
  fields: Row[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  newOpen: boolean;
  onNewOpenChange: (open: boolean) => void;
}) {
  const [rows, apply] = useOptimistic(fields, reducer);
  const [query, setQuery] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [typeChange, setTypeChange] = useState<{ row: Row; to: FieldType } | null>(null);
  const [blocks, setBlocks] = useState<Record<string, TypeBlock>>({});
  const [showArchived, setShowArchived] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const rowEls = useRef(new Map<string, HTMLTableRowElement>());
  const lastCreate = useRef<{ key: string; opId: string } | null>(null);

  const active = useMemo(() => rows.filter((r) => !r.archived), [rows]);
  const archived = useMemo(() => rows.filter((r) => r.archived), [rows]);
  const q = query.trim().toLowerCase();
  const filtering = q !== "";
  const visible = useMemo(
    () =>
      q
        ? active.filter((r) => [r.label, r.key, ...r.choices.filter((c) => !c.archived).map((c) => c.label)].join("\n").toLowerCase().includes(q))
        : active,
    [active, q],
  );
  // Same ids → same array, so the sortable rows don't all re-render when one row changes.
  const idsKey = visible.map((r) => r.id).join("\n");
  const visibleIds = useMemo(() => (idsKey ? idsKey.split("\n") : []), [idsKey]);
  const selected = selectedId ? (active.find((r) => r.id === selectedId) ?? null) : null;
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const focusRow = useCallback((id: string) => {
    setFocusId(id);
    requestAnimationFrame(() => {
      const el = rowEls.current.get(id);
      el?.focus({ preventScroll: true });
      el?.scrollIntoView({ block: "nearest" });
    });
  }, []);

  /** Scrolls a row into view as soon as it is on screen (a new field arrives with the refreshed data). */
  const revealId = useRef<string | null>(null);
  useEffect(() => {
    const id = revealId.current;
    const el = id ? rowEls.current.get(id) : undefined;
    if (el) {
      revealId.current = null;
      el.scrollIntoView({ block: "nearest" });
    }
  }, [rows]);

  /** Another active field already has this label (case-insensitive). */
  function labelTaken(label: string, exceptId?: string): string | null {
    const n = label.trim().toLowerCase();
    const other = active.find((r) => r.id !== exceptId && r.label.trim().toLowerCase() === n);
    return other ? `There is already a project field called “${other.label}”. Pick another label.` : null;
  }

  /** Closing the panel puts the keyboard focus back on its row. */
  function closePanel() {
    const id = selectedId;
    onSelect(null);
    if (id && active.some((r) => r.id === id)) focusRow(id);
  }

  function step(delta: number, fromId?: string | null) {
    if (visible.length === 0) return;
    const current = fromId ?? (selected ? selected.id : focusId);
    const i = current ? visible.findIndex((r) => r.id === current) : -1;
    const next = visible[i < 0 ? (delta > 0 ? 0 : visible.length - 1) : Math.max(0, Math.min(visible.length - 1, i + delta))];
    if (!next) return;
    focusRow(next.id);
    if (selected) onSelect(next.id);
  }

  const anyDialog = newOpen || typeChange !== null;
  useHotkeys(
    {
      "/": (e) => {
        if (fromOverlay(e)) return;
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      },
      j: (e) => {
        if (fromOverlay(e)) return;
        e.preventDefault();
        step(1);
      },
      k: (e) => {
        if (fromOverlay(e)) return;
        e.preventDefault();
        step(-1);
      },
    },
    !anyDialog,
  );

  // ---------------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------------

  function update(row: Row, patch: FieldPatch, optimistic: Partial<Row>) {
    runWrite({
      queue: QUEUE.fields,
      optimistic: () => apply({ type: "patch", id: row.id, patch: optimistic }),
      run: (opId) => updateProjectFieldAction(opId, row.id, patch),
      onSuccess: () => {
        if (patch.fieldType) setBlocks(({ [row.id]: _gone, ...rest }) => rest);
      },
      onFailure: (f) => {
        const blocking = blockingOf(f);
        if (patch.fieldType && blocking) {
          const to = patch.fieldType;
          setBlocks((b) => ({ ...b, [row.id]: { to, message: f.error, blocking } }));
          onSelect(row.id);
          toast.error(`Can't change “${row.label}” to ${FIELD_TYPE_META[to].label}`, {
            description: `${blocking.length} project${blocking.length === 1 ? " has a value" : "s have values"} that can't be converted. They are listed in the panel.`,
          });
          return true;
        }
        return false;
      },
    });
  }

  function save(row: Row, patch: DefPatch) {
    const out: FieldPatch = {};
    const optimistic: Partial<Row> = {};
    if (patch.name !== undefined) {
      out.label = patch.name;
      optimistic.label = patch.name;
    }
    if (patch.fieldType !== undefined) out.fieldType = optimistic.fieldType = patch.fieldType;
    if (patch.choices !== undefined) out.choices = optimistic.choices = patch.choices;
    if (patch.config !== undefined) out.config = optimistic.config = patch.config;
    if (Object.keys(out).length === 0) return;
    update(row, out, optimistic);
  }

  function toggleSummary(row: Row, on: boolean) {
    update(row, { showInSummary: on }, { showInSummary: on });
  }

  function reorder(row: Row, toIndex: number) {
    const from = active.findIndex((r) => r.id === row.id);
    if (from < 0 || toIndex === from || toIndex < 0 || toIndex >= active.length) return;
    const next = arrayMove(active, from, toIndex);
    const prev = next[toIndex - 1];
    const after = next[toIndex + 1];
    const order = prev && after ? (prev.order + after.order) / 2 : prev ? prev.order + 1 : after ? after.order - 1 : 1;
    update(row, { order }, { order });
  }

  function moveBy(row: Row, delta: number) {
    if (filtering) {
      toast.info("Clear the search to reorder.", { id: "reorder-filter" });
      return;
    }
    reorder(row, active.findIndex((r) => r.id === row.id) + delta);
    focusRow(row.id);
  }

  function onDragEnd(e: DragEndEvent) {
    const { active: a, over } = e;
    if (!over || a.id === over.id) return;
    const row = active.find((r) => r.id === a.id);
    const toIndex = active.findIndex((r) => r.id === over.id);
    if (row && toIndex >= 0) reorder(row, toIndex);
  }

  function restore(row: Row) {
    runWrite({
      queue: QUEUE.fields,
      optimistic: () => apply({ type: "patch", id: row.id, patch: { archived: false, archivedAt: null } }),
      run: (opId) => restoreProjectFieldAction(opId, row.id),
      onSuccess: () => {
        toast.success(`Restored “${row.label}”`);
      },
    });
  }

  function archive(row: Row) {
    if (row.systemKey) {
      toast.error(`“${row.label}” is used by the Portfolio filters and can't be archived. You can rename it.`);
      return;
    }
    if (selectedId === row.id) onSelect(null);
    // Keep the keyboard on the table: the next row (or the previous one at the end) takes the focus.
    const i = visible.findIndex((r) => r.id === row.id);
    const neighbour = i >= 0 ? (visible[i + 1] ?? visible[i - 1]) : undefined;
    const focused = document.activeElement;
    if (neighbour && (!focused || focused === document.body || focused.closest("tbody, aside[aria-label='Details'], [role=menu]"))) {
      setTimeout(() => focusRow(neighbour.id), 0);
    }
    runWrite({
      queue: QUEUE.fields,
      optimistic: () => apply({ type: "patch", id: row.id, patch: { archived: true, archivedAt: new Date().toISOString() } }),
      run: (opId) => archiveProjectFieldAction(opId, row.id),
      onSuccess: () => {
        toast(`Archived “${row.label}”`, {
          duration: 8000,
          description: "Values in projects are kept and come back if you restore it.",
          action: { label: "Undo", onClick: () => restore(row) },
        });
      },
    });
  }

  async function create(label: string, fieldType: FieldType): Promise<string | null> {
    const key = `${label}|${fieldType}`;
    if (lastCreate.current?.key !== key) lastCreate.current = { key, opId: newOpId() };
    const opId = lastCreate.current.opId;
    const r = await queuedWrite(QUEUE.fields, () => createProjectFieldAction(opId, { label, fieldType }));
    if (!r.ok) {
      if (r.code === "SESSION" || r.code === "STALE_DEPLOYMENT") reportFailure(r);
      return r.error;
    }
    lastCreate.current = null;
    setQuery("");
    onSelect(r.data.id);
    revealId.current = r.data.id;
    requestAnimationFrame(() => {
      const el = rowEls.current.get(r.data.id);
      if (el && revealId.current === r.data.id) {
        revealId.current = null;
        el.scrollIntoView({ block: "nearest" });
      }
    });
    toast.success(`Added the project field “${r.data.label}”`, { description: "Every project shows it in Edit details." });
    return null;
  }

  function onRowKeyDown(e: React.KeyboardEvent<HTMLTableRowElement>, row: Row) {
    if (e.target !== e.currentTarget) return;
    if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      moveBy(row, e.key === "ArrowUp" ? -1 : 1);
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        step(1, row.id);
        break;
      case "ArrowUp":
        e.preventDefault();
        step(-1, row.id);
        break;
      case "Enter":
        e.preventDefault();
        setEditingId(row.id);
        break;
      case " ":
      case "o":
      case "e":
        e.preventDefault();
        onSelect(row.id);
        break;
    }
  }

  const typeEffect: TypeChangeEffectProps | null = typeChange
    ? {
        from: typeChange.row.fieldType,
        to: typeChange.to,
        kind: "field",
        usedIn: typeChange.row.usedIn,
        choiceCount: typeChange.row.choices.filter((c) => !c.archived).length,
      }
    : null;
  const rowHandlers = useStableHandlers<RowHandlers>({
    register: (id, el) => {
      if (el) rowEls.current.set(id, el);
      else rowEls.current.delete(id);
    },
    focused: (id) => setFocusId(id),
    click: (id) => {
      setFocusId(id);
      onSelect(id);
    },
    keyDown: onRowKeyDown,
    startEdit: (id) => {
      setFocusId(id);
      setEditingId(id);
      if (selected) onSelect(id);
    },
    commitName: (row, label) => {
      const taken = labelTaken(label, row.id);
      if (taken) toast.error(taken);
      else save(row, { name: label });
    },
    doneEdit: (id, how) => {
      setEditingId(null);
      if (how !== "blur") focusRow(id);
    },
    pickType: (row, to) => setTypeChange({ row, to }),
    toggleSummary: (row, on) => toggleSummary(row, on),
    edit: (id) => onSelect(id),
    archive: (row) => archive(row),
  });
  const tabStopId = focusId && visible.some((r) => r.id === focusId) ? focusId : (selected?.id ?? visible[0]?.id);

  return (
    <div className="relative flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
          <div className="relative w-80 max-w-full">
            <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  if (query) setQuery("");
                  else e.currentTarget.blur();
                } else if (e.key === "ArrowDown" || e.key === "Enter") {
                  e.preventDefault();
                  if (visible[0]) focusRow(visible[0].id);
                }
              }}
              placeholder="Search fields and choices"
              aria-label="Search project fields"
              className="h-8 pr-8 pl-8 text-[13px]"
            />
            {query ? (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => setQuery("")}
                className="absolute top-1/2 right-1.5 flex size-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-muted"
              >
                <X className="size-3.5" />
              </button>
            ) : (
              <Kbd className="absolute top-1/2 right-2 -translate-y-1/2">/</Kbd>
            )}
          </div>
          <span className="text-xs text-muted-foreground tabular-nums" aria-live="polite">
            {filtering ? `${visible.length} of ${active.length} fields` : `${active.length} fields`}
          </span>
        </div>

        <div className="flex items-center gap-2 border-b bg-muted/40 px-4 py-1.5 text-xs text-muted-foreground">
          <Info className="size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1">
            The details every project has, besides Code, Name and Status. Changes show in all projects straight away.
          </span>
        </div>

        <div className="@container relative min-h-0 flex-1 overflow-auto">
          {active.length === 0 ? (
            <EmptyState
              title="No project fields"
              action={
                <Button size="sm" onClick={() => onNewOpenChange(true)}>
                  Add a field
                </Button>
              }
            >
              Add fields such as Customer or Site to describe each project.
            </EmptyState>
          ) : visible.length === 0 ? (
            <EmptyState
              title="No fields match"
              action={
                <Button variant="outline" size="sm" onClick={() => setQuery("")}>
                  Clear search
                </Button>
              }
            >
              Nothing matches “{query.trim()}”.
            </EmptyState>
          ) : (
            <DndContext id="library-fields" sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
              <table className="w-full table-fixed border-separate border-spacing-0 text-[13px]">
                <caption className="sr-only">
                  Project fields in the order the project form shows them. Select a row and press Enter to rename, O to
                  edit, Alt+Arrow keys to move.
                </caption>
                <thead>
                  <tr className="text-left text-xs text-muted-foreground">
                    <Th className="w-8">
                      <span className="sr-only">Reorder</span>
                    </Th>
                    <Th>Label</Th>
                    <Th className="w-40">Field type</Th>
                    <Th className="w-[18rem] @max-[56rem]:hidden">Choices</Th>
                    <Th className="w-36">Shown in summary</Th>
                    <Th className="w-28 @max-[40rem]:hidden">Used in</Th>
                    <Th className="w-10">
                      <span className="sr-only">Actions</span>
                    </Th>
                  </tr>
                </thead>
                <SortableContext items={visibleIds} strategy={verticalListSortingStrategy}>
                  <tbody>
                    {visible.map((row) => (
                      <FieldRowView
                        key={row.id}
                        row={row}
                        selected={row.id === selected?.id}
                        editing={editingId === row.id}
                        tabStop={row.id === tabStopId}
                        reorderDisabled={filtering}
                        h={rowHandlers}
                      />
                    ))}
                  </tbody>
                </SortableContext>
              </table>
            </DndContext>
          )}

          {archived.length > 0 ? (
            <section className="border-t px-4 py-3" aria-label="Archived project fields">
              <button
                type="button"
                className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
                aria-expanded={showArchived}
                onClick={() => setShowArchived((s) => !s)}
              >
                <ChevronRight className={cn("size-3.5 transition-transform", showArchived && "rotate-90")} aria-hidden />
                {archived.length} archived field{archived.length === 1 ? "" : "s"}
              </button>
              {showArchived ? (
                <ul className="mt-2 divide-y rounded-md border">
                  {archived.map((r) => (
                    <li key={r.id} className="flex h-9 items-center gap-3 px-3 text-[13px]">
                      <FieldTypeIcon type={r.fieldType} className="text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate text-muted-foreground line-through decoration-muted-foreground/40">{r.label}</span>
                      <span className="text-xs text-muted-foreground">{r.fieldTypeLabel}</span>
                      {r.archivedAt ? <span className="text-xs text-muted-foreground">Archived {formatDay(r.archivedAt)}</span> : null}
                      <Button variant="outline" size="sm" className="h-7" onClick={() => restore(r)}>
                        <ArchiveRestore className="size-3.5" aria-hidden /> Restore
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>
          ) : null}
        </div>
      </div>

      <FieldPanel
        row={selected}
        block={selected ? (blocks[selected.id] ?? null) : null}
        onDismissBlock={() => selected && setBlocks(({ [selected.id]: _gone, ...rest }) => rest)}
        onClose={closePanel}
        validateName={(row, label) => labelTaken(label, row.id)}
        onSave={save}
        onToggleSummary={toggleSummary}
        onArchive={archive}
      />

      <NewItemDialog
        open={newOpen}
        onOpenChange={onNewOpenChange}
        title="New project field"
        description="Every project gets this field in its details, empty until you fill it in."
        nameLabel="Label"
        namePlaceholder="e.g. Sales contact"
        fieldTypes={FIELD_TYPES_FOR_FIELDS}
        defaultType="TEXT"
        submitLabel="Add field"
        validateName={(label) => labelTaken(label)}
        onCreate={create}
      />

      <TypeChangeDialog
        open={typeChange !== null}
        onOpenChange={(o) => {
          if (!o) setTypeChange(null);
        }}
        name={typeChange?.row.label ?? ""}
        effect={typeEffect}
        onConfirm={() => {
          if (typeChange) save(typeChange.row, { fieldType: typeChange.to });
        }}
      />
    </div>
  );
}

function SystemBadge() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="outline" className="h-5 shrink-0 gap-1 px-1.5 text-[11px] font-medium text-muted-foreground">
          <Lock aria-hidden className="size-3" /> System
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="max-w-64">{SYSTEM_FIELD_NOTE}</TooltipContent>
    </Tooltip>
  );
}

interface RowHandlers {
  register: (id: string, el: HTMLTableRowElement | null) => void;
  focused: (id: string) => void;
  click: (id: string) => void;
  keyDown: (e: React.KeyboardEvent<HTMLTableRowElement>, row: Row) => void;
  startEdit: (id: string) => void;
  commitName: (row: Row, name: string) => void;
  doneEdit: (id: string, how: "enter" | "escape" | "blur") => void;
  pickType: (row: Row, to: FieldType) => void;
  toggleSummary: (row: Row, on: boolean) => void;
  edit: (id: string) => void;
  archive: (row: Row) => void;
}

const FieldRowView = memo(function FieldRowView({
  row,
  selected,
  editing,
  tabStop,
  reorderDisabled,
  h,
}: {
  row: Row;
  selected: boolean;
  editing: boolean;
  tabStop: boolean;
  reorderDisabled: boolean;
  h: RowHandlers;
}) {
  const rowRef = useCallback((el: HTMLTableRowElement | null) => h.register(row.id, el), [h, row.id]);
  const system = row.systemKey !== null;
  const cells = useMemo(
    () => (
      <>
        <Td>
          <div className="flex min-w-0 items-center gap-2">
            <div className="min-w-0">
              <InlineName
                value={row.label}
                label={row.label}
                editing={editing}
                onStartEdit={() => h.startEdit(row.id)}
                onCommit={(label) => h.commitName(row, label)}
                onDone={(how) => h.doneEdit(row.id, how)}
              />
            </div>
            {system && !editing ? <SystemBadge /> : null}
          </div>
        </Td>
        <Td className="px-1" stop>
          <TypeSelect
            value={row.fieldType}
            types={system ? SYSTEM_FIELD_TYPES : FIELD_TYPES_FOR_FIELDS}
            label={row.label}
            onPick={(to) => h.pickType(row, to)}
          />
        </Td>
        <Td className="@max-[56rem]:hidden">
          <ChoicesPreview fieldType={row.fieldType} choices={row.choices} withStates={false} budget={34} />
        </Td>
        <Td stop>
          <span className="flex items-center gap-2">
            <Switch
              size="sm"
              checked={row.showInSummary}
              onCheckedChange={(on) => h.toggleSummary(row, on)}
              aria-label={`Show ${row.label} in the project summary`}
            />
            <span className="text-xs text-muted-foreground">{row.showInSummary ? "Shown" : "Hidden"}</span>
          </span>
        </Td>
        <Td className="text-muted-foreground tabular-nums @max-[40rem]:hidden">
          {row.usedIn > 0 ? `${row.usedIn} project${row.usedIn === 1 ? "" : "s"}` : <span className="text-muted-foreground/50">—</span>}
        </Td>
        <Td className="px-1" stop>
          <FieldMenu row={row} onEdit={() => h.edit(row.id)} onArchive={() => h.archive(row)} />
        </Td>
      </>
    ),
    [row, editing, h, system],
  );
  return (
    <SortableRow
      id={row.id}
      disabled={reorderDisabled}
      rowRef={rowRef}
      handleLabel={row.label}
      tabIndex={tabStop ? 0 : -1}
      aria-current={selected ? "true" : undefined}
      onFocus={(e) => {
        if (e.target === e.currentTarget) h.focused(row.id);
      }}
      onClick={() => h.click(row.id)}
      onKeyDown={(e) => h.keyDown(e, row)}
      className={cn(ROW_CLASS, selected && ROW_SELECTED_CLASS)}
    >
      {cells}
    </SortableRow>
  );
});

function FieldMenu({ row, onEdit, onArchive }: { row: Row; onEdit: () => void; onArchive: () => void }) {
  const system = row.systemKey !== null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          tabIndex={-1}
          className="size-7 text-muted-foreground opacity-60 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
          aria-label={`Actions for ${row.label}`}
        >
          <MoreHorizontal className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuItem onSelect={onEdit}>
          <Pencil /> Edit
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" disabled={system} onSelect={onArchive}>
          <Archive /> {system ? "System field: can't archive" : "Archive"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
