"use client";

import { memo } from "react";
import { Handle, Position, useStore, type Node, type NodeProps } from "@xyflow/react";
import { AlertTriangle, Clock3, FileText, Paperclip, Pin, StickyNote } from "lucide-react";
import type { NodeFlag, State } from "@/domain/types";
import { STATE_META } from "@/domain/state";
import { cn } from "@/lib/utils";
import { StateIcon, stateClass } from "@/components/state/state-badge";

export const NODE_W = 184;
export const NODE_H = 56;

export interface NodeCardData extends Record<string, unknown> {
  name: string;
  /** Value line, already formatted (e.g. "Awaiting", "Plan 12 Nov 2026", "60 %", "—"). */
  value: string;
  state: State;
  mode: "project" | "template";
  /** Position in flow order (1-based), shown in the overview zoom level. */
  seq?: number;
  current?: boolean;
  noteCount?: number;
  fileCount?: number;
  projectOnly?: boolean;
  flag?: NodeFlag | null;
  /** Date turned green because it passed (not yet confirmed). */
  passedAuto?: boolean;
  /** Invalid value, unknown choice, or type differs from template. */
  warning?: string;
  /** 0-100 for PERCENT fields. */
  percent?: number;
  /** Template mode: e.g. "Dropdown · 5 choices". */
  typeLine?: string;
  connectable?: boolean;
}

export type CardNode = Node<NodeCardData, "card">;

type ZoomLevel = "full" | "compact" | "overview";
const zoomSelector = (s: { transform: [number, number, number] }): ZoomLevel => {
  const z = s.transform[2];
  return z >= 0.45 ? "full" : z >= 0.3 ? "compact" : "overview";
};

function Indicators({ d }: { d: NodeCardData }) {
  const items: React.ReactNode[] = [];
  if (d.warning)
    items.push(
      <span key="w" title={d.warning} className="text-[var(--state-b-solid)]">
        <AlertTriangle className="size-3" />
      </span>,
    );
  if (d.flag)
    items.push(
      <span key="f" title={`Flagged: ${d.flag === "BLOCKED" ? "Blocked" : "Waiting"}`}>
        <Pin className="size-3" />
      </span>,
    );
  if (d.passedAuto)
    items.push(
      <span key="c" title="Turned green because the date passed. Confirm it happened.">
        <Clock3 className="size-3" />
      </span>,
    );
  if (d.noteCount)
    items.push(
      <span key="n" className="inline-flex items-center gap-px" title={`${d.noteCount} note(s)`}>
        <StickyNote className="size-3" />
        {d.noteCount > 1 ? d.noteCount : null}
      </span>,
    );
  if (d.fileCount)
    items.push(
      <span key="a" className="inline-flex items-center gap-px" title={`${d.fileCount} file(s) or link(s)`}>
        <Paperclip className="size-3" />
        {d.fileCount > 1 ? d.fileCount : null}
      </span>,
    );
  if (d.projectOnly)
    items.push(
      <span key="p" title="Project-only step" className="rounded-sm border px-0.5 text-[9px] font-semibold leading-none">
        P
      </span>,
    );
  if (!items.length) return null;
  return <div className="absolute right-1.5 top-1 flex items-center gap-1 text-[10px] text-muted-foreground">{items}</div>;
}

function NodeCardImpl({ data, selected }: NodeProps<CardNode>) {
  const zoom = useStore(zoomSelector);
  const d = data;
  const template = d.mode === "template";
  const na = d.state === "NOT_APPLICABLE";
  const cls = template ? "state-ns" : stateClass(d.state);
  const label = `${d.name}: ${d.value}${template ? "" : ` (${STATE_META[d.state].label})`}`;

  const handles = (
    <>
      <Handle
        type="target"
        position={Position.Left}
        isConnectable={d.connectable}
        className={cn("!size-2 !border-background !bg-muted-foreground", !d.connectable && "!opacity-0")}
      />
      <Handle
        type="source"
        position={Position.Right}
        isConnectable={d.connectable}
        className={cn("!size-2 !border-background !bg-muted-foreground", !d.connectable && "!opacity-0")}
      />
    </>
  );

  if (zoom === "overview") {
    return (
      <div
        aria-label={label}
        style={{ width: NODE_W, height: NODE_H }}
        className={cn(
          cls,
          "flex items-center justify-center rounded-md border-2 border-[var(--s-border)] bg-[var(--s-solid)] text-2xl font-semibold text-white",
          template && "bg-muted text-muted-foreground",
          na && "border-dashed bg-transparent text-[var(--s-fg)] opacity-60",
          d.current && "ring-4 ring-[var(--current-ring)]",
          selected && "outline outline-2 outline-offset-2 outline-foreground",
        )}
      >
        {d.seq ?? ""}
        {handles}
      </div>
    );
  }

  const compact = zoom === "compact";
  return (
    <div
      aria-label={label}
      style={{ width: NODE_W, height: NODE_H }}
      className={cn(
        cls,
        "relative flex overflow-hidden rounded-md border bg-[var(--s-bg)] text-left shadow-xs",
        template ? "border-border bg-card" : "border-[var(--s-border)]",
        na && "border-dashed opacity-50",
        d.current && "ring-2 ring-[var(--current-ring)] ring-offset-1 ring-offset-background",
        selected && "outline outline-2 outline-offset-2 outline-foreground",
      )}
    >
      {!na && !template ? <div className="w-1 shrink-0 bg-[var(--s-solid)]" aria-hidden /> : null}
      <div className={cn("flex min-w-0 flex-1 flex-col justify-center px-2", compact ? "gap-0.5" : "gap-0.5 pr-7")}>
        <div className="flex min-w-0 items-start gap-1">
          {!compact && !template ? <StateIcon state={d.state} className="mt-px size-3" /> : null}
          {!compact && template ? <FileText className="mt-px size-3 shrink-0 text-muted-foreground" aria-hidden /> : null}
          <span
            className={cn(
              "min-w-0 font-medium leading-tight text-foreground",
              compact ? "truncate text-[15px]" : "line-clamp-2 text-xs",
            )}
          >
            {d.name}
          </span>
        </div>
        <div
          className={cn(
            "truncate tabular-nums leading-tight",
            template ? "text-muted-foreground" : "text-[var(--s-fg)]",
            compact ? "text-sm" : "text-[11px]",
          )}
        >
          {template ? d.typeLine ?? d.value : d.value}
        </div>
      </div>
      {!compact ? <Indicators d={d} /> : null}
      {typeof d.percent === "number" && !na ? (
        <div className="absolute inset-x-0 bottom-0 h-0.5 bg-[var(--s-border)]" aria-hidden>
          <div className="h-full bg-[var(--s-solid)]" style={{ width: `${Math.max(0, Math.min(100, d.percent))}%` }} />
        </div>
      ) : null}
      {handles}
    </div>
  );
}

export const NodeCard = memo(NodeCardImpl);

/** Defined at module level so React Flow does not re-create node types on every render. */
export const NODE_TYPES = { card: NodeCard };
