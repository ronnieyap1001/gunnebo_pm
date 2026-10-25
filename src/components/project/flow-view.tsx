"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  Clock3,
  CornerDownRight,
  Crosshair,
  Info,
  Loader2,
  Maximize,
  MinusCircle,
  Paperclip,
  PanelRight,
  Pin,
  Plus,
  Spline,
  StickyNote,
  Trash2,
  Wand2,
  AlertTriangle,
} from "lucide-react";
import type { Position } from "@/domain/types";
import { cn } from "@/lib/utils";
import { FlowCanvas, useFlowControls, useIsClient, type CanvasEdge } from "@/components/flow/flow-canvas";
import { NODE_H, NODE_W, type CardNode, type NodeCardData } from "@/components/flow/node-card";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { StateLegend } from "@/components/state/state-badge";
import { useProject } from "./context";
import { useProjectHotkeys } from "./use-project-hotkeys";
import { activeEdgesOf } from "./derive";
import { Kbd } from "./kbd";
import type { StepView } from "./types";

type MenuTarget = { kind: "node"; id: string } | { kind: "edge"; id: string } | { kind: "pane"; at: Position } | null;

function warningOf(s: StepView): string | undefined {
  if (s.reason === "INVALID_VALUE") return "Invalid value";
  if (s.reason === "UNKNOWN_CHOICE") return "The chosen option no longer exists";
  if (s.typeDiffers) return "The template uses another field type";
  if (s.notInTemplate) return "No longer in the template";
  return undefined;
}

function ToolButton({
  label,
  hotkey,
  onClick,
  children,
  pressed,
  disabled,
}: {
  label: string;
  hotkey?: string;
  onClick: () => void;
  children: React.ReactNode;
  pressed?: boolean;
  disabled?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          size="sm"
          variant={pressed ? "secondary" : "ghost"}
          onClick={onClick}
          aria-pressed={pressed}
          disabled={disabled}
          aria-keyshortcuts={hotkey?.toLowerCase()}
          className={cn(pressed && "ring-1 ring-ring/40")}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {label} {hotkey ? <Kbd>{hotkey}</Kbd> : null}
      </TooltipContent>
    </Tooltip>
  );
}

export function FlowLegend() {
  const row = (icon: React.ReactNode, text: string) => (
    <li className="flex items-center gap-2">
      <span className="flex w-5 justify-center text-muted-foreground">{icon}</span>
      {text}
    </li>
  );
  return (
    <div className="space-y-3 text-xs">
      <div>
        <div className="mb-1.5 font-medium">Colours</div>
        <StateLegend />
      </div>
      <div>
        <div className="mb-1.5 font-medium">Marks on a card</div>
        <ul className="space-y-1">
          {row(<StickyNote className="size-3" />, "Notes")}
          {row(<Paperclip className="size-3" />, "Files or links")}
          {row(<span className="rounded-sm border px-0.5 text-[9px] font-semibold leading-none">P</span>, "Project-only step")}
          {row(<Pin className="size-3" />, "Flagged Waiting or Blocked")}
          {row(<Clock3 className="size-3" />, "Turned green because the date passed")}
          {row(<AlertTriangle className="size-3 text-[var(--state-b-solid)]" />, "Needs attention (invalid value, not in template)")}
          {row(<MinusCircle className="size-3" />, "Faded and dashed: not applicable")}
        </ul>
      </div>
      <div>
        <div className="mb-1.5 font-medium">Arrows</div>
        <ul className="space-y-1">
          {row(<span className="h-0.5 w-4 rounded bg-[var(--state-d-solid)] opacity-70" />, "Green: the step before is done")}
          {row(<span className="w-4 border-t-2 border-dashed border-muted-foreground" />, "Dashed: touches a not-applicable step")}
        </ul>
      </div>
    </div>
  );
}

export function FlowView({
  initialFocusId,
  hotkeysEnabled,
  onAddStep,
}: {
  initialFocusId: string | null;
  hotkeysEnabled: boolean;
  onAddStep: (opts: { afterStepId?: string; position?: Position }) => void;
}) {
  const { raw, view, api, readOnly, selectedId, openStep } = useProject();
  const controls = useFlowControls();
  // React Flow measures the page: draw it in the browser only (also keeps the dark theme from flashing light).
  const isClient = useIsClient();
  const [editArrows, setEditArrows] = useState(false);
  const [laying, setLaying] = useState(false);
  const [menu, setMenu] = useState<MenuTarget>(null);
  const wrapper = useRef<HTMLDivElement>(null);
  const [initialFit] = useState(() => view.currentIds);
  const [initialFocus] = useState(initialFocusId);

  // Node data is rebuilt only when what a card shows changes (cards are memoised on their data).
  const cache = useRef(new Map<string, { key: string; data: NodeCardData }>());
  const nodes: CardNode[] = useMemo(() => {
    const placed = Object.values(raw.positions);
    const maxY = placed.length ? Math.max(...placed.map((p) => p.y)) : 0;
    const minX = placed.length ? Math.min(...placed.map((p) => p.x)) : 0;
    let extra = 0;
    return view.steps.map((s) => {
      const data: NodeCardData = {
        name: s.name,
        value: s.shortDisplay,
        state: s.state,
        mode: "project",
        seq: s.seq,
        current: s.isCurrent,
        noteCount: s.noteCount,
        fileCount: s.attachmentCount,
        projectOnly: s.projectOnly,
        flag: s.flag,
        passedAuto: s.reason === "DATE_PASSED_AUTO",
        warning: warningOf(s),
        percent: s.fieldType === "PERCENT" && s.value && "percent" in s.value ? s.value.percent : undefined,
        connectable: editArrows,
      };
      const key = JSON.stringify(data);
      const hit = cache.current.get(s.id);
      const stable = hit && hit.key === key ? hit.data : data;
      if (!hit || hit.key !== key) cache.current.set(s.id, { key, data });
      const position = raw.positions[s.id] ?? { x: minX + (extra % 6) * (NODE_W + 40), y: maxY + NODE_H + 60 + Math.floor(extra++ / 6) * (NODE_H + 40) };
      return { id: s.id, type: "card" as const, position, data: stable };
    });
  }, [view.steps, raw.positions, editArrows]);

  const edges: CanvasEdge[] = useMemo(
    () =>
      activeEdgesOf(raw).map((e) => {
        const a = view.byId.get(e.from);
        const b = view.byId.get(e.to);
        return {
          id: e.id,
          from: e.from,
          to: e.to,
          done: a?.state === "DONE",
          dashed: a?.state === "NOT_APPLICABLE" || b?.state === "NOT_APPLICABLE",
        };
      }),
    [raw, view.byId],
  );

  // Keep the selected card in view when the side panel opens and narrows the canvas.
  useEffect(() => {
    if (!selectedId) return;
    const t = setTimeout(() => controls.reveal(selectedId), 80);
    return () => clearTimeout(t);
    // controls is a fresh object every render; only the selection matters here.
  }, [selectedId]);

  async function layout() {
    if (laying || readOnly) return;
    setLaying(true);
    const ok = await api.layout(controls.viewportWidth());
    setLaying(false);
    if (ok) requestAnimationFrame(() => controls.fitAll());
  }

  function deleteSelected(e: KeyboardEvent) {
    // While editing arrows, Delete belongs to the selected arrow (the canvas handles it); a focused button or switch
    // keeps its own keys.
    if (!selectedId || readOnly || editArrows) return;
    if ((e.target as HTMLElement | null)?.closest?.("button, a, [role='switch'], [role='checkbox'], [role='menuitem']")) return;
    e.preventDefault();
    void api.archiveStep(selectedId);
  }

  function goToCurrent() {
    controls.fitIds(view.currentIds.length ? view.currentIds : []);
  }

  useProjectHotkeys(
    {
      f: (e) => {
        e.preventDefault();
        controls.fitAll();
      },
      c: (e) => {
        e.preventDefault();
        goToCurrent();
      },
      l: (e) => {
        if (readOnly) return;
        e.preventDefault();
        void layout();
      },
      e: (e) => {
        if (readOnly) return;
        e.preventDefault();
        setEditArrows((v) => !v);
      },
      escape: () => {
        if (editArrows && !selectedId) setEditArrows(false);
      },
      // Delete / Backspace on the selected step: archive a project-only step (with Undo), or suggest N/A.
      delete: (e) => deleteSelected(e),
      backspace: (e) => deleteSelected(e),
    },
    hotkeysEnabled,
  );

  const menuStep = menu?.kind === "node" ? view.byId.get(menu.id) : undefined;
  const menuEdge = menu?.kind === "edge" ? raw.edges.find((e) => e.id === menu.id) : undefined;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <ContextMenu
        onOpenChange={(o) => {
          if (!o) setTimeout(() => setMenu(null), 150);
        }}
      >
        <ContextMenuTrigger asChild>
          <div ref={wrapper} className="relative min-h-0 flex-1" data-testid="project-canvas">
            {isClient ? (
              <FlowCanvas
                mode="project"
                nodes={nodes}
                edges={edges}
                editArrows={editArrows && !readOnly}
                edgeDeleteButton
                connectionFeedback
                draggable={!readOnly}
                selectedId={selectedId}
                onSelect={(id) => openStep(id)}
                onMoveNodes={(positions) => void api.moveNodes(positions)}
                onConnect={(from, to) => void api.connect(from, to)}
                onDeleteEdges={(ids) => {
                  for (const id of ids) void api.disconnect(id);
                }}
                onPaneDoubleClick={readOnly ? undefined : (position) => onAddStep({ position })}
                onNodeContextMenu={(id) => setMenu({ kind: "node", id })}
                onEdgeContextMenu={(id) => setMenu(editArrows ? { kind: "edge", id } : null)}
                onPaneContextMenu={(at) => setMenu({ kind: "pane", at })}
                initialFitIds={initialFit}
                initialFocusId={initialFocus}
              >
                <div className="flex items-center gap-0.5 rounded-lg border bg-background/95 p-1 shadow-sm backdrop-blur" role="toolbar" aria-label="Chart tools">
                  <ToolButton label="Fit the whole chart" hotkey="F" onClick={() => controls.fitAll()}>
                    <Maximize aria-hidden /> Fit
                  </ToolButton>
                  <ToolButton label="Go to the current milestones" hotkey="C" onClick={goToCurrent} disabled={view.currentIds.length === 0}>
                    <Crosshair aria-hidden /> Current
                  </ToolButton>
                  <ToolButton label="Auto-layout (Undo offered)" hotkey="L" onClick={() => void layout()} disabled={readOnly || laying}>
                    {laying ? <Loader2 className="animate-spin" aria-hidden /> : <Wand2 aria-hidden />} Auto-layout
                  </ToolButton>
                  <ToolButton label="Draw and delete arrows" hotkey="E" onClick={() => setEditArrows((v) => !v)} pressed={editArrows} disabled={readOnly}>
                    <Spline aria-hidden /> Edit arrows
                  </ToolButton>
                  <ToolButton label="Add a step only this project has" onClick={() => onAddStep({ afterStepId: selectedId ?? undefined })} disabled={readOnly}>
                    <Plus aria-hidden /> Project step
                  </ToolButton>
                  <Popover>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <PopoverTrigger asChild>
                          <Button size="sm" variant="ghost" aria-label="Legend">
                            <Info aria-hidden /> Legend
                          </Button>
                        </PopoverTrigger>
                      </TooltipTrigger>
                      <TooltipContent>What the colours and marks mean</TooltipContent>
                    </Tooltip>
                    <PopoverContent align="start" className="w-80">
                      <FlowLegend />
                    </PopoverContent>
                  </Popover>
                </div>
              </FlowCanvas>
            ) : (
              <div className="absolute inset-0 bg-[radial-gradient(var(--border)_1px,transparent_1px)] [background-size:16px_16px]" aria-busy="true" aria-label="Drawing the flow chart" />
            )}
            {isClient && view.steps.length === 0 ? (
              <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center p-6">
                <div className="pointer-events-auto max-w-sm rounded-lg border bg-background p-5 text-center shadow-sm">
                  <p className="text-sm font-medium">This project has no milestones yet</p>
                  <p className="mt-1 text-xs text-muted-foreground">Add a step only this project has, or bring in the template&apos;s milestones with Sync from template (⋯ menu).</p>
                  {!readOnly ? (
                    <Button size="sm" className="mt-3" onClick={() => onAddStep({})}>
                      <Plus aria-hidden /> Project step
                    </Button>
                  ) : null}
                </div>
              </div>
            ) : null}
            {editArrows && !readOnly ? (
              <div className="pointer-events-none absolute inset-x-0 top-14 z-10 flex justify-center px-4">
                <div
                  role="status"
                  className="pointer-events-auto flex max-w-2xl items-center gap-3 rounded-lg border border-[var(--current-ring)]/40 bg-background/95 px-3 py-2 text-xs shadow-sm backdrop-blur"
                >
                  <Spline className="size-4 shrink-0 text-[var(--current-ring)]" aria-hidden />
                  <span>
                    <strong className="font-semibold">Editing arrows for this project only; the template is not changed.</strong> Drag from a
                    card&apos;s right dot to another card. To delete an arrow, click its × or select it and press Delete.
                  </span>
                  <Button size="xs" variant="outline" onClick={() => setEditArrows(false)}>
                    Done
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-60" onCloseAutoFocus={(e) => e.preventDefault()}>
          {menuStep ? (
            <>
              <ContextMenuLabel className="truncate text-xs text-muted-foreground">
                #{menuStep.seq} {menuStep.name}
              </ContextMenuLabel>
              <ContextMenuItem onSelect={() => openStep(menuStep.id)}>
                <PanelRight aria-hidden /> Open details
              </ContextMenuItem>
              {!readOnly ? (
                <>
                  <ContextMenuItem onSelect={() => onAddStep({ afterStepId: menuStep.id })}>
                    <CornerDownRight aria-hidden /> Insert project step after
                  </ContextMenuItem>
                  <ContextMenuItem onSelect={() => void api.setNotApplicable(menuStep.id, !menuStep.notApplicable)}>
                    <MinusCircle aria-hidden /> {menuStep.notApplicable ? "Clear not applicable" : "Mark not applicable"}
                    <ContextMenuShortcut>X</ContextMenuShortcut>
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  {menuStep.projectOnly ? (
                    <ContextMenuItem variant="destructive" onSelect={() => void api.archiveStep(menuStep.id)}>
                      <Archive aria-hidden /> Archive step
                      <ContextMenuShortcut>Del</ContextMenuShortcut>
                    </ContextMenuItem>
                  ) : (
                    <ContextMenuItem disabled>
                      <Archive aria-hidden /> From the template: mark N/A instead
                    </ContextMenuItem>
                  )}
                </>
              ) : null}
            </>
          ) : menuEdge ? (
            <>
              <ContextMenuLabel className="text-xs text-muted-foreground">
                <span className="line-clamp-2">
                  {view.byId.get(menuEdge.from)?.name ?? "?"} → {view.byId.get(menuEdge.to)?.name ?? "?"}
                </span>
              </ContextMenuLabel>
              <ContextMenuItem variant="destructive" onSelect={() => void api.disconnect(menuEdge.id)}>
                <Trash2 aria-hidden /> Delete arrow
                <ContextMenuShortcut>Del</ContextMenuShortcut>
              </ContextMenuItem>
            </>
          ) : (
            <>
              {!readOnly ? (
                <ContextMenuItem onSelect={() => onAddStep({ position: menu?.kind === "pane" ? menu.at : undefined })}>
                  <Plus aria-hidden /> Add project step here
                </ContextMenuItem>
              ) : null}
              <ContextMenuItem onSelect={() => controls.fitAll()}>
                <Maximize aria-hidden /> Fit the whole chart
                <ContextMenuShortcut>F</ContextMenuShortcut>
              </ContextMenuItem>
              <ContextMenuItem onSelect={goToCurrent} disabled={!view.currentIds.length}>
                <Crosshair aria-hidden /> Go to current
                <ContextMenuShortcut>C</ContextMenuShortcut>
              </ContextMenuItem>
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>
    </div>
  );
}
