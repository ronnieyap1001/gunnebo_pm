"use client";

import { useEffect, useState } from "react";
import { Archive } from "lucide-react";
import type { FlowEdge } from "@/domain/types";
import type { MilestoneRow } from "@/server/queries";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { bridgesFor } from "./state";

/** The body of the "Archive this milestone?" popover: what happens, the "Reconnect neighbours" option, buttons. */
export function ArchiveConfirmBody({
  row,
  rowsById,
  edges,
  onConfirm,
  onCancel,
}: {
  row: MilestoneRow;
  rowsById: Map<string, MilestoneRow>;
  edges: FlowEdge[];
  onConfirm: (reconnect: boolean) => void;
  onCancel: () => void;
}) {
  const [reconnect, setReconnect] = useState(true);
  const bridges = bridgesFor(edges, row.id);
  const name = (id: string) => rowsById.get(id)?.name ?? "?";
  const shown = bridges.slice(0, 3);

  return (
    <div className="space-y-3 text-sm" role="group" aria-label={`Archive ${row.name}`}>
      <div className="space-y-1">
        <div className="font-medium">Archive “{row.name}”?</div>
        <p className="text-xs text-muted-foreground">
          It leaves the template and goes to the Archive, where you can restore it. Projects keep their copy until you Sync them.
        </p>
      </div>
      {bridges.length > 0 ? (
        <label className="flex items-start gap-2 rounded-md border bg-muted/40 p-2 text-xs">
          <Checkbox checked={reconnect} onCheckedChange={(c) => setReconnect(c === true)} className="mt-px" aria-label="Reconnect neighbours" />
          <span className="min-w-0 space-y-0.5">
            <span className="block font-medium">Reconnect neighbours</span>
            {shown.map((b) => (
              <span key={`${b.from}>${b.to}`} className="block truncate text-muted-foreground">
                {name(b.from)} → {name(b.to)}
              </span>
            ))}
            {bridges.length > shown.length ? (
              <span className="block text-muted-foreground">and {bridges.length - shown.length} more arrows</span>
            ) : null}
          </span>
        </label>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="destructive" size="sm" autoFocus onClick={() => onConfirm(bridges.length > 0 && reconnect)}>
          <Archive className="size-3.5" aria-hidden /> Archive
        </Button>
      </div>
    </div>
  );
}

/**
 * The same confirmation, anchored to a node on the canvas (Delete key or the node's context menu). The anchor is
 * a fixed-position box over the node's screen rectangle, read when the popover opens.
 */
export function CanvasArchiveConfirm({
  row,
  rowsById,
  edges,
  onConfirm,
  onClose,
}: {
  row: MilestoneRow | null;
  rowsById: Map<string, MilestoneRow>;
  edges: FlowEdge[];
  onConfirm: (id: string, reconnect: boolean) => void;
  onClose: () => void;
}) {
  const [rect, setRect] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  useEffect(() => {
    if (!row) {
      setRect(null);
      return;
    }
    const el = document.querySelector(`.react-flow__node[data-id="${CSS.escape(row.id)}"]`);
    const r = el?.getBoundingClientRect();
    const canvas = document.querySelector(".react-flow")?.getBoundingClientRect();
    if (r && r.width > 0) setRect({ left: r.left, top: r.top, width: r.width, height: r.height });
    else if (canvas) setRect({ left: canvas.left + canvas.width / 2, top: canvas.top + 80, width: 1, height: 1 });
    else setRect({ left: window.innerWidth / 2, top: 120, width: 1, height: 1 });
  }, [row]);

  if (!row || !rect) return null;
  return (
    <Popover open onOpenChange={(o) => !o && onClose()}>
      <PopoverAnchor asChild>
        <div aria-hidden className="pointer-events-none fixed" style={rect} />
      </PopoverAnchor>
      <PopoverContent side="bottom" align="center" className="w-80">
        <ArchiveConfirmBody
          key={row.id}
          row={row}
          rowsById={rowsById}
          edges={edges}
          onCancel={onClose}
          onConfirm={(reconnect) => {
            onConfirm(row.id, reconnect);
            onClose();
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
