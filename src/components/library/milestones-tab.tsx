"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { memo, useCallback, useEffect, useMemo, useOptimistic, useRef, useState } from "react";
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { toast } from "sonner";
import { Archive, Info, MoreHorizontal, Pencil, Search, Workflow, X } from "lucide-react";
import type { Choice, FieldType } from "@/domain/types";
import { FIELD_TYPES } from "@/domain/types";
import { FIELD_TYPE_META } from "@/domain/fieldTypes";
import type { MilestoneRow } from "@/server/queries";
import { newOpId } from "@/lib/write-queue";
import { useHotkeys } from "@/lib/hotkeys";
import { cn } from "@/lib/utils";
import {
  applyChoicesToAction,
  archiveMilestoneAction,
  createMilestoneAction,
  reorderMilestoneAction,
  restoreBatchAction,
  updateMilestoneAction,
} from "@/app/(app)/library/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/common/empty-state";
import type { DefPatch, OtherDef } from "./definition-editor";
import { FieldTypeIcon } from "./field-type-icon";
import { MilestonePanel } from "./milestone-panel";
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
import { QUEUE, queuedWrite, reportFailure, runWrite } from "./write";

type Row = MilestoneRow;
type Act =
  | { type: "patch"; id: string; patch: Partial<Row> }
  | { type: "move"; id: string; toIndex: number }
  | { type: "remove"; id: string };

function reducer(rows: Row[], a: Act): Row[] {
  switch (a.type) {
    case "patch":
      return rows.map((r) =>
        r.id === a.id
          ? { ...r, ...a.patch, fieldTypeLabel: a.patch.fieldType ? FIELD_TYPE_META[a.patch.fieldType].label : r.fieldTypeLabel }
          : r,
      );
    case "move": {
      const from = rows.findIndex((r) => r.id === a.id);
      if (from < 0) return rows;
      return arrayMove(rows, from, Math.max(0, Math.min(rows.length - 1, a.toIndex)));
    }
    case "remove":
      return rows.filter((r) => r.id !== a.id);
  }
}

function matches(r: Row, q: string): boolean {
  if (!q) return true;
  const hay = [r.name, r.description, r.key, ...r.choices.filter((c) => !c.archived).map((c) => c.label)].join("\n").toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w));
}

/** Dropdown choices need a state: what the table shows right after switching to Dropdown (the server does the same). */
function withDefaultStates(choices: Choice[]): Choice[] {
  return choices.map((c) => (c.state ? c : { ...c, state: "NOT_STARTED" }));
}

export function MilestonesTab({
  milestones,
  archivedCount,
  selectedId,
  onSelect,
  newOpen,
  onNewOpenChange,
}: {
  milestones: Row[];
  archivedCount: number;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  newOpen: boolean;
  onNewOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [rows, apply] = useOptimistic(milestones, reducer);
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<FieldType | "ALL">("ALL");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [typeChange, setTypeChange] = useState<{ row: Row; to: FieldType } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const rowEls = useRef(new Map<string, HTMLTableRowElement>());
  const lastCreate = useRef<{ key: string; opId: string } | null>(null);

  const q = query.trim();
  const filtering = q !== "" || typeFilter !== "ALL";
  const visible = useMemo(
    () => rows.filter((r) => (typeFilter === "ALL" || r.fieldType === typeFilter) && matches(r, q)),
    [rows, typeFilter, q],
  );
  // Same ids → same array, so the sortable rows don't all re-render when one row changes.
  const idsKey = visible.map((r) => r.id).join("\n");
  const visibleIds = useMemo(() => (idsKey ? idsKey.split("\n") : []), [idsKey]);
  const rowsById = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);
  const selected = selectedId ? (rowsById.get(selectedId) ?? null) : null;
  const typeCounts = useMemo(() => {
    const m = new Map<FieldType, number>();
    for (const r of rows) m.set(r.fieldType, (m.get(r.fieldType) ?? 0) + 1);
    return m;
  }, [rows]);
  const others: OtherDef[] = useMemo(
    () =>
      selected
        ? rows.filter((r) => r.id !== selected.id).map((r) => ({ id: r.id, name: r.name, fieldType: r.fieldType, choices: r.choices }))
        : [],
    [rows, selected],
  );

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  // ---------------------------------------------------------------------------
  // Focus and keyboard
  // ---------------------------------------------------------------------------

  const focusRow = useCallback((id: string) => {
    setFocusId(id);
    requestAnimationFrame(() => {
      const el = rowEls.current.get(id);
      el?.focus({ preventScroll: true });
      el?.scrollIntoView({ block: "nearest" });
    });
  }, []);

  /** Scrolls a row into view as soon as it is on screen (a new milestone arrives with the refreshed data). */
  const revealId = useRef<string | null>(null);
  const revealRow = useCallback((id: string) => {
    revealId.current = id;
    requestAnimationFrame(() => {
      const el = rowEls.current.get(id);
      if (el && revealId.current === id) {
        revealId.current = null;
        el.scrollIntoView({ block: "nearest" });
      }
    });
  }, []);
  useEffect(() => {
    const id = revealId.current;
    const el = id ? rowEls.current.get(id) : undefined;
    if (el) {
      revealId.current = null;
      el.scrollIntoView({ block: "nearest" });
    }
  }, [rows]);

  /** Another active milestone already has this name (case-insensitive). */
  function nameTaken(name: string, exceptId?: string): string | null {
    const n = name.trim().toLowerCase();
    const other = rows.find((r) => r.id !== exceptId && r.name.trim().toLowerCase() === n);
    return other ? `There is already a milestone called “${other.name}”${other.seq ? ` (#${other.seq})` : ""}. Pick another name.` : null;
  }

  /** Closing the panel puts the keyboard focus back on its row. */
  function closePanel() {
    const id = selectedId;
    onSelect(null);
    if (id && rowsById.has(id)) focusRow(id);
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
      case "Home":
        e.preventDefault();
        if (visible[0]) focusRow(visible[0].id);
        break;
      case "End":
        e.preventDefault();
        if (visible.length) focusRow(visible[visible.length - 1].id);
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

  // ---------------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------------

  function save(row: Row, patch: DefPatch, optimisticPatch: Partial<Row> = patch) {
    runWrite({
      queue: QUEUE.library,
      optimistic: () => apply({ type: "patch", id: row.id, patch: optimisticPatch }),
      run: (opId) => updateMilestoneAction(opId, row.id, patch),
    });
  }

  function changeType(row: Row, to: FieldType) {
    const choices = FIELD_TYPE_META[to].choicesHaveState ? withDefaultStates(row.choices) : row.choices;
    save(row, { fieldType: to }, { fieldType: to, choices });
  }

  function applyChoicesTo(row: Row, targetIds: string[]) {
    const copied = row.choices.filter((c) => !c.archived);
    runWrite({
      queue: QUEUE.library,
      optimistic: () => {
        for (const id of targetIds) apply({ type: "patch", id, patch: { choices: copied } });
      },
      run: (opId) => applyChoicesToAction(opId, row.id, targetIds),
      onSuccess: ({ updatedIds }) => {
        if (updatedIds.length === 0) toast.info("Those milestones already have these choices.");
        else toast.success(`Copied the choices of “${row.name}” to ${updatedIds.length} milestone${updatedIds.length === 1 ? "" : "s"}`);
      },
    });
  }

  function reorder(row: Row, toIndex: number) {
    const from = rows.findIndex((r) => r.id === row.id);
    if (from < 0 || toIndex === from || toIndex < 0 || toIndex >= rows.length) return;
    const next = arrayMove(rows, from, toIndex);
    const where = toIndex > 0 ? { afterId: next[toIndex - 1].id } : { beforeId: next[1].id };
    runWrite({
      queue: QUEUE.library,
      optimistic: () => apply({ type: "move", id: row.id, toIndex }),
      run: (opId) => reorderMilestoneAction(opId, row.id, where),
      onSuccess: ({ effective }) => {
        if (!effective) {
          toast.info("Arrows decide the order; change them in Template Flow", {
            id: "arrows-decide",
            action: { label: "Open Template Flow", onClick: () => router.push(`/template?m=${encodeURIComponent(row.id)}`) },
          });
        }
      },
    });
  }

  function moveBy(row: Row, delta: number) {
    if (filtering) {
      toast.info("Clear the search and type filter to reorder.", { id: "reorder-filter" });
      return;
    }
    const i = rows.findIndex((r) => r.id === row.id);
    reorder(row, i + delta);
    focusRow(row.id);
  }

  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const row = rowsById.get(String(active.id));
    const toIndex = rows.findIndex((r) => r.id === over.id);
    if (row && toIndex >= 0) reorder(row, toIndex);
  }

  function undoArchive(batchId: string, name: string, opId: string = newOpId()) {
    const t = toast.loading(`Restoring “${name}”…`);
    void queuedWrite(QUEUE.library, () => restoreBatchAction(opId, batchId)).then((r) => {
      if (r.ok) {
        const skipped = r.data.skippedEdgeIds.length;
        toast.success(`Restored “${name}”`, {
          id: t,
          description: skipped
            ? `${skipped} arrow${skipped === 1 ? " was" : "s were"} not put back because ${skipped === 1 ? "it" : "they"} would create a loop.`
            : undefined,
        });
      } else {
        toast.dismiss(t);
        reportFailure(r, () => undoArchive(batchId, name, opId));
      }
    });
  }

  function archive(row: Row) {
    if (selectedId === row.id) onSelect(null);
    // Keep the keyboard on the table: the next row (or the previous one at the end) takes the focus.
    const i = visible.findIndex((r) => r.id === row.id);
    const neighbour = i >= 0 ? (visible[i + 1] ?? visible[i - 1]) : undefined;
    const active = document.activeElement;
    if (neighbour && (!active || active === document.body || active.closest("tbody, aside[aria-label='Details'], [role=menu]"))) {
      setTimeout(() => focusRow(neighbour.id), 0);
    }
    runWrite({
      queue: QUEUE.library,
      optimistic: () => apply({ type: "remove", id: row.id }),
      run: (opId) => archiveMilestoneAction(opId, row.id),
      onSuccess: ({ batchId, arrowsRemoved, bridges }) => {
        toast(`Archived “${row.name}”`, {
          duration: 8000,
          description:
            bridges > 0
              ? `The steps before and after it are now connected directly (${bridges} new arrow${bridges === 1 ? "" : "s"}).`
              : arrowsRemoved > 0
                ? `${arrowsRemoved} arrow${arrowsRemoved === 1 ? "" : "s"} to it ${arrowsRemoved === 1 ? "was" : "were"} removed.`
                : "Projects keep their copy until you Sync them.",
          action: { label: "Undo", onClick: () => undoArchive(batchId, row.name) },
        });
      },
    });
  }

  async function create(name: string, fieldType: FieldType): Promise<string | null> {
    const key = `${name}|${fieldType}`;
    if (lastCreate.current?.key !== key) lastCreate.current = { key, opId: newOpId() };
    const opId = lastCreate.current.opId;
    const r = await queuedWrite(QUEUE.library, () => createMilestoneAction(opId, { name, fieldType }));
    if (!r.ok) {
      if (r.code === "SESSION" || r.code === "STALE_DEPLOYMENT") reportFailure(r);
      return r.error;
    }
    lastCreate.current = null;
    setQuery("");
    setTypeFilter("ALL");
    onSelect(r.data.id);
    revealRow(r.data.id);
    toast.success(`Added “${r.data.name}”`, {
      description: "It isn't connected yet: draw its arrows in Template Flow.",
      action: { label: "Template Flow", onClick: () => router.push(`/template?m=${encodeURIComponent(r.data.id)}`) },
    });
    return null;
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

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
    commitName: (row, name) => {
      const taken = nameTaken(name, row.id);
      if (taken) toast.error(taken);
      else save(row, { name });
    },
    doneEdit: (id, how) => {
      setEditingId(null);
      if (how !== "blur") focusRow(id);
    },
    pickType: (row, to) => setTypeChange({ row, to }),
    edit: (id) => onSelect(id),
    archive: (row) => archive(row),
  });

  const typeEffect: TypeChangeEffectProps | null = typeChange
    ? {
        from: typeChange.row.fieldType,
        to: typeChange.to,
        kind: "milestone",
        usedIn: typeChange.row.usedIn,
        choiceCount: typeChange.row.choices.filter((c) => !c.archived).length,
      }
    : null;
  const selIndex = selected ? visible.findIndex((r) => r.id === selected.id) : -1;
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
              placeholder="Search names, choices, descriptions"
              aria-label="Search milestones"
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
          <Select value={typeFilter} onValueChange={(v) => setTypeFilter(v as FieldType | "ALL")}>
            <SelectTrigger size="sm" aria-label="Filter by field type" className="h-8 min-w-40 text-[13px]">
              <SelectValue>
                {typeFilter === "ALL" ? (
                  "All field types"
                ) : (
                  <>
                    <FieldTypeIcon type={typeFilter} className="text-muted-foreground" />
                    {FIELD_TYPE_META[typeFilter].label}
                  </>
                )}
              </SelectValue>
            </SelectTrigger>
            <SelectContent position="popper" align="start">
              <SelectItem value="ALL">All field types</SelectItem>
              {FIELD_TYPES.filter((t) => typeCounts.has(t)).map((t) => (
                <SelectItem key={t} value={t}>
                  <FieldTypeIcon type={t} className="text-muted-foreground" />
                  {FIELD_TYPE_META[t].label}
                  <span className="text-muted-foreground tabular-nums">{typeCounts.get(t)}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="text-xs text-muted-foreground tabular-nums" aria-live="polite">
            {filtering ? `${visible.length} of ${rows.length} milestones` : `${rows.length} milestones`}
          </span>
          {filtering ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={() => {
                setQuery("");
                setTypeFilter("ALL");
              }}
            >
              Clear filters
            </Button>
          ) : null}
        </div>

        <div className="flex items-center gap-2 border-b bg-muted/40 px-4 py-1.5 text-xs text-muted-foreground">
          <Info className="size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1">
            Changes apply to new projects. Existing projects update when you Sync them. The # is the order of the arrows in
            Template Flow.
          </span>
          {archivedCount > 0 ? (
            <Link href="/archive?tab=milestones" className="shrink-0 underline-offset-4 hover:text-foreground hover:underline">
              {archivedCount} archived
            </Link>
          ) : null}
        </div>

        <div className="@container relative min-h-0 flex-1 overflow-auto">
          {visible.length === 0 ? (
            rows.length === 0 ? (
              <EmptyState
                title="No milestones yet"
                action={
                  <Button size="sm" onClick={() => onNewOpenChange(true)}>
                    Add the first milestone
                  </Button>
                }
              >
                Milestones are the steps every new project copies.
              </EmptyState>
            ) : (
              <EmptyState
                title="No milestones match"
                action={
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setQuery("");
                      setTypeFilter("ALL");
                    }}
                  >
                    Clear filters
                  </Button>
                }
              >
                {q ? `Nothing matches “${q}”` : "No milestone has this field type"}
                {q && typeFilter !== "ALL" ? ` with the type ${FIELD_TYPE_META[typeFilter].label}` : ""}.
              </EmptyState>
            )
          ) : (
            <DndContext id="library-milestones" sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
              <table className="w-full table-fixed border-separate border-spacing-0 text-[13px]">
                <caption className="sr-only">
                  Milestones in flow order. Select a row and press Enter to rename, O to edit, Alt+Arrow keys to move.
                </caption>
                <thead>
                  <tr className="text-left text-xs text-muted-foreground">
                    <Th className="w-8">
                      <span className="sr-only">Reorder</span>
                    </Th>
                    <Th className="w-11 pr-2 text-right">#</Th>
                    <Th>Name</Th>
                    <Th className="w-36">Field type</Th>
                    <Th className="w-[17rem] @max-[42rem]:hidden">Choices</Th>
                    <Th className="w-[22%] @max-[64rem]:hidden">Description</Th>
                    <Th className="w-24 @max-[56rem]:hidden">Used in</Th>
                    <Th className="w-10">
                      <span className="sr-only">Actions</span>
                    </Th>
                  </tr>
                </thead>
                <SortableContext items={visibleIds} strategy={verticalListSortingStrategy}>
                  <tbody>
                    {visible.map((row) => (
                      <MilestoneRowView
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
        </div>
      </div>

      <MilestonePanel
        row={selected}
        rowsById={rowsById}
        others={others}
        onClose={closePanel}
        validateName={(row, name) => nameTaken(name, row.id)}
        onSave={(row, patch) => save(row, patch)}
        onApplyChoicesTo={applyChoicesTo}
        onArchive={archive}
        onSelect={(id) => {
          onSelect(id);
          focusRow(id);
        }}
        onStep={(d) => step(d)}
        canStep={{ prev: selIndex > 0, next: selIndex >= 0 && selIndex < visible.length - 1 }}
      />

      <NewItemDialog
        open={newOpen}
        onOpenChange={onNewOpenChange}
        title="New milestone"
        description="It is added to the library and to Template Flow, unconnected. New projects copy it; existing projects get it when you Sync them."
        nameLabel="Name"
        namePlaceholder="e.g. Site survey"
        fieldTypes={FIELD_TYPES}
        defaultType="DROPDOWN"
        submitLabel="Add milestone"
        showStateRule
        validateName={(name) => nameTaken(name)}
        onCreate={create}
      />

      <TypeChangeDialog
        open={typeChange !== null}
        onOpenChange={(o) => {
          if (!o) setTypeChange(null);
        }}
        name={typeChange?.row.name ?? ""}
        effect={typeEffect}
        onConfirm={() => {
          if (typeChange) changeType(typeChange.row, typeChange.to);
        }}
      />
    </div>
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
  edit: (id: string) => void;
  archive: (row: Row) => void;
}

const MilestoneRowView = memo(function MilestoneRowView({
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
  const cells = useMemo(
    () => (
      <>
        <Td className="pr-2 text-right text-muted-foreground tabular-nums">{row.seq ?? "–"}</Td>
        <Td>
          <InlineName
            value={row.name}
            label={row.name}
            editing={editing}
            onStartEdit={() => h.startEdit(row.id)}
            onCommit={(name) => h.commitName(row, name)}
            onDone={(how) => h.doneEdit(row.id, how)}
          />
        </Td>
        <Td className="px-1" stop>
          <TypeSelect value={row.fieldType} types={FIELD_TYPES} label={row.name} onPick={(to) => h.pickType(row, to)} />
        </Td>
        <Td className="@max-[42rem]:hidden">
          <ChoicesPreview fieldType={row.fieldType} choices={row.choices} withStates />
        </Td>
        <Td className="@max-[64rem]:hidden">
          <span className="block truncate text-muted-foreground" title={row.description || undefined}>
            {row.description || <span className="text-muted-foreground/50">—</span>}
          </span>
        </Td>
        <Td className="text-muted-foreground tabular-nums @max-[56rem]:hidden">
          {row.usedIn > 0 ? `${row.usedIn} project${row.usedIn === 1 ? "" : "s"}` : <span className="text-muted-foreground/50">—</span>}
        </Td>
        <Td className="px-1" stop>
          <RowMenu row={row} onEdit={() => h.edit(row.id)} onArchive={() => h.archive(row)} />
        </Td>
      </>
    ),
    [row, editing, h],
  );
  return (
    <SortableRow
      id={row.id}
      disabled={reorderDisabled}
      rowRef={rowRef}
      handleLabel={row.name}
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

function RowMenu({ row, onEdit, onArchive }: { row: Row; onEdit: () => void; onArchive: () => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          tabIndex={-1}
          className="size-7 text-muted-foreground opacity-60 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
          aria-label={`Actions for ${row.name}`}
        >
          <MoreHorizontal className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuItem onSelect={onEdit}>
          <Pencil /> Edit
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href={`/template?m=${encodeURIComponent(row.id)}`}>
            <Workflow /> Show in Template Flow
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={onArchive}>
          <Archive /> Archive
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
