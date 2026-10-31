"use client";

import { EdgeToolbar } from "@xyflow/react";
import { X } from "lucide-react";
import type { Position } from "@/domain/types";

/** An arrow the pointer is over, or the arrow picked by click / keyboard, with the spot (flow coordinates) to put × at. */
export interface EdgeSpot {
  id: string;
  at: Position;
}

export const EDGE_TOOL_CLASS = "gpm-edge-tool";

/**
 * The delete × for the hovered or selected arrow (drawn in the canvas, so it follows pan and zoom), and the outline
 * of the selected arrow. FlowCanvas leaves arrow selection to its parent, so this screen keeps its own.
 */
export function EdgeTools({
  hovered,
  selected,
  label,
  onDelete,
  onPointerEnter,
  onPointerLeave,
}: {
  hovered: EdgeSpot | null;
  selected: EdgeSpot | null;
  /** "Delete the arrow A → B". */
  label: (id: string) => string;
  onDelete: (id: string) => void;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
}) {
  const shown = selected ?? hovered;
  return (
    <>
      <style>{`.gpm-template-canvas .react-flow__edge:hover .react-flow__edge-path{stroke:var(--foreground)!important;opacity:1!important}`}</style>
      {selected ? (
        <style>{`.gpm-template-canvas .react-flow__edge[data-id="${CSS.escape(selected.id)}"] .react-flow__edge-path{stroke:var(--foreground)!important;stroke-width:2.5px!important;opacity:1!important}`}</style>
      ) : null}
      {shown ? (
        // Up and to the right of the pointer, never under it, so a click on the arrow selects it instead of deleting it.
        <EdgeToolbar
          edgeId={shown.id}
          x={shown.at.x}
          y={shown.at.y}
          alignX="left"
          alignY="bottom"
          isVisible
          style={{ pointerEvents: "none" }}
          className="pb-2 pl-2"
        >
          <button
            type="button"
            className={`${EDGE_TOOL_CLASS} nodrag nopan pointer-events-auto flex size-6 items-center justify-center rounded-full border bg-background text-muted-foreground shadow-sm transition-colors hover:border-destructive hover:bg-destructive hover:text-white focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none`}
            aria-label={label(shown.id)}
            title={`${label(shown.id)} (Delete)`}
            onPointerEnter={onPointerEnter}
            onPointerLeave={onPointerLeave}
            onClick={(e) => {
              e.stopPropagation();
              onDelete(shown.id);
            }}
          >
            <X className="size-3.5" aria-hidden />
          </button>
        </EdgeToolbar>
      ) : null}
    </>
  );
}
