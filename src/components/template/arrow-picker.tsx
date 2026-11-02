"use client";

import { useMemo, useState } from "react";
import { Plus, X } from "lucide-react";
import { wouldCreateCycle } from "@/domain/graph";
import type { FlowEdge } from "@/domain/types";
import type { MilestoneRow } from "@/server/queries";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/**
 * "Comes after" / "Leads to": the arrows into or out of one milestone as removable chips, plus a searchable
 * multi-select to add or remove arrows by keyboard (the alternative to drawing them on the canvas).
 */
export function ArrowPicker({
  direction,
  milestoneId,
  rows,
  edges,
  onAdd,
  onRemove,
  onOpen,
}: {
  /** "in": arrows X → this milestone (Comes after). "out": this milestone → X (Leads to). */
  direction: "in" | "out";
  milestoneId: string;
  rows: MilestoneRow[];
  edges: FlowEdge[];
  onAdd: (otherId: string) => void;
  onRemove: (edge: FlowEdge) => void;
  onOpen: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const label = direction === "in" ? "Comes after" : "Leads to";
  const rowsById = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);

  const linked = useMemo(
    () =>
      edges
        .filter((e) => (direction === "in" ? e.to === milestoneId : e.from === milestoneId))
        .map((e) => ({ edge: e, row: rowsById.get(direction === "in" ? e.from : e.to) }))
        .filter((x): x is { edge: FlowEdge; row: MilestoneRow } => Boolean(x.row))
        .sort((a, b) => (a.row.seq ?? 0) - (b.row.seq ?? 0)),
    [edges, direction, milestoneId, rowsById],
  );
  const linkedIds = new Set(linked.map((l) => l.row.id));

  function loopReason(otherId: string): string | null {
    const [from, to] = direction === "in" ? [otherId, milestoneId] : [milestoneId, otherId];
    return wouldCreateCycle(edges, from, to) ? "would create a loop" : null;
  }

  function toggle(otherId: string) {
    const hit = linked.find((l) => l.row.id === otherId);
    if (hit) onRemove(hit.edge);
    else if (!loopReason(otherId)) onAdd(otherId);
  }

  const candidates = rows.filter((r) => r.id !== milestoneId);
  const listId = `arrow-picker-${direction}`;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium" id={`${listId}-label`}>
          {label}
        </span>
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              role="combobox"
              aria-expanded={open}
              className="h-6 px-1.5 text-xs"
              aria-label={direction === "in" ? "Choose what this milestone comes after" : "Choose what this milestone leads to"}
            >
              <Plus className="size-3.5" aria-hidden /> Add
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-80 p-0" align="end">
            <Command loop>
              <CommandInput placeholder="Find a milestone…" aria-label="Find a milestone" />
              <CommandList>
                <CommandEmpty>No milestone matches.</CommandEmpty>
                <CommandGroup heading={direction === "in" ? "Arrow from … to this milestone" : "Arrow from this milestone to …"}>
                  {candidates.map((r) => {
                    const on = linkedIds.has(r.id);
                    const blocked = on ? null : loopReason(r.id);
                    return (
                      <CommandItem
                        key={r.id}
                        value={r.id}
                        keywords={[r.name, r.seq !== null ? `#${r.seq}` : ""]}
                        data-checked={on}
                        disabled={Boolean(blocked)}
                        onSelect={() => toggle(r.id)}
                        className="text-[13px]"
                      >
                        <span className="w-7 shrink-0 text-right text-xs text-muted-foreground tabular-nums">{r.seq !== null ? `#${r.seq}` : ""}</span>
                        <span className="min-w-0 flex-1 truncate">{r.name}</span>
                        {blocked ? <span className="shrink-0 text-[11px] text-muted-foreground">{blocked}</span> : null}
                        {on ? <span className="sr-only">(connected)</span> : null}
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      </div>
      {linked.length === 0 ? (
        <p className="text-xs text-muted-foreground italic">{direction === "in" ? "Nothing. This is a starting point." : "Nothing. The flow ends here."}</p>
      ) : (
        <ul className="flex flex-wrap gap-1" aria-labelledby={`${listId}-label`}>
          {linked.map(({ edge, row }) => (
            <li key={edge.id} className="flex max-w-full items-center rounded-md border bg-background text-xs">
              <button
                type="button"
                onClick={() => onOpen(row.id)}
                className="min-w-0 truncate rounded-l-md py-0.5 pr-1 pl-1.5 text-left hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
                title={`Open “${row.name}”`}
              >
                {row.seq !== null ? <span className="mr-1 text-muted-foreground tabular-nums">#{row.seq}</span> : null}
                {row.name}
              </button>
              <button
                type="button"
                onClick={() => onRemove(edge)}
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded-r-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
                aria-label={direction === "in" ? `Remove the arrow from “${row.name}”` : `Remove the arrow to “${row.name}”`}
                title="Remove this arrow"
              >
                <X className="size-3" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
