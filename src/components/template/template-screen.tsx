"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useOptimistic, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useReactFlow } from "@xyflow/react";
import { toast } from "sonner";
import { Archive, CornerDownRight, Maximize, PanelRight, Plus, Trash2 } from "lucide-react";
import { FIELD_TYPE_META } from "@/domain/fieldTypes";
import { wouldCreateCycle } from "@/domain/graph";
import { autoLayout, ranksPerRow } from "@/domain/layout";
import { defaultPositions } from "@/domain/snapshot";
import { FIELD_TYPES, type Choice, type FieldType, type FlowEdge, type Position } from "@/domain/types";
import type { MilestoneRow, TemplateView } from "@/server/queries";
import { useHotkeys } from "@/lib/hotkeys";
import { cn } from "@/lib/utils";
import { newOpId } from "@/lib/write-queue";
import {
  addTemplateEdgeAction,
  applyChoicesToAction,
  archiveMilestoneAction,
  archiveTemplateEdgeAction,
  createMilestoneAction,
  layoutTemplateAction,
  moveTemplateNodesAction,
  restoreBatchAction,
  updateMilestoneAction,
} from "@/app/(app)/template/actions";
import { FlowCanvas, FlowProvider, useFlowControls, type CanvasEdge } from "@/components/flow/flow-canvas";
import { NODE_H, NODE_W, type CardNode } from "@/components/flow/node-card";
import type { DefPatch } from "@/components/library/definition-editor";
import { NewItemDialog } from "@/components/library/new-item-dialog";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { PageHeader } from "@/components/shell/page-header";
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
import { CanvasArchiveConfirm } from "./archive-confirm";
import { ConnectionFeedback } from "./connection-feedback";
import { EDGE_TOOL_CLASS, EdgeTools, type EdgeSpot } from "./edge-tools";
import { ImportDialog } from "./import-dialog";
import { InfoStrip } from "./info-strip";
import { ShortcutsDialog } from "./shortcuts-dialog";
import { editorReducer, stateFromView, typeLineOf, type ArchivedSnapshot, type EditorState } from "./state";
import { PANEL_BODY_ATTR, TemplatePanel } from "./template-panel";
import { TemplateToolbar } from "./toolbar";
import { setSearchParams, type ResumableKind } from "./url";
import { useTemplateJobs } from "./use-template-jobs";
import { queuedWrite, refreshAfterRefusal, reportFailure, runWrite, useRefreshAfterRefusal, useSaveStatus } from "./write";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

interface NewTarget {
  title: string;
  description: string;
  afterId?: string;
  /** Left-dot drag onto empty canvas: the new milestone gets an arrow into this one. */
  beforeId?: string;
  position?: Position;
}

/**
 * Fit keeps the cards clear of the toolbar (top left) and the minimap (bottom right), so none hides behind them,
 * and never zooms past 100 % (a template with a few milestones would otherwise show giant cards).
 */
const FIT_PADDING = { top: "64px", right: "24px", bottom: "172px", left: "24px" } as const;

type MenuTarget = { kind: "node"; id: string } | { kind: "edge"; id: string } | { kind: "pane"; at: Position };

export interface TemplateScreenProps {
  view: TemplateView;
  /** `?m=` deep link (already checked against the view). */
  initialSelectedId: string | null;
  /** `?job=&kind=` of a job that was running when the page reloaded. */
  resume: { opId: string; kind: ResumableKind } | null;
}

export function TemplateScreen(props: TemplateScreenProps) {
  return (
    <FlowProvider>
      <TemplateEditor {...props} />
    </FlowProvider>
  );
}

/** Dropdown choices need a state: what the panel shows right after switching to Dropdown (the server does the same). */
function withDefaultStates(choices: Choice[]): Choice[] {
  return choices.map((c) => (c.state ? c : { ...c, state: "NOT_STARTED" }));
}

/** The first spot near `p` (alternating below / above) that doesn't overlap a card. */
function freeSpot(p: Position, taken: Position[]): Position {
  const hit = (q: Position) => taken.some((t) => Math.abs(t.x - q.x) < NODE_W + 16 && Math.abs(t.y - q.y) < NODE_H + 16);
  for (let i = 0; i < 41; i++) {
    const step = Math.ceil(i / 2) * (i % 2 ? 1 : -1);
    const q = { x: Math.round(p.x), y: Math.round(p.y + step * (NODE_H + 24)) };
    if (!hit(q)) return q;
  }
  return { x: Math.round(p.x), y: Math.round(p.y) };
}

function TemplateEditor({ view, initialSelectedId, resume }: TemplateScreenProps) {
  const rf = useReactFlow();
  const router = useRouter();
  const controls = useFlowControls();
  const base = useMemo(() => stateFromView(view), [view]);
  const [state, apply] = useOptimistic(base, editorReducer);
  const stateRef = useRef<EditorState>(state);
  stateRef.current = state;

  const rowsById = useMemo(() => new Map(state.rows.map((r) => [r.id, r])), [state.rows]);
  const [selectedId, setSelectedId] = useState<string | null>(initialSelectedId);
  const selected = selectedId ? (rowsById.get(selectedId) ?? null) : null;
  const [newTarget, setNewTarget] = useState<NewTarget | null>(null);
  const [archiveAskId, setArchiveAskId] = useState<string | null>(null);
  const [layoutMenuOpen, setLayoutMenuOpen] = useState(false);
  const [contextMenuOpen, setContextMenuOpen] = useState(false);
  const [menuTarget, setMenuTarget] = useState<MenuTarget | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [edgeHover, setEdgeHover] = useState<EdgeSpot | null>(null);
  const [edgeSel, setEdgeSel] = useState<EdgeSpot | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const lastCreate = useRef<{ key: string; opId: string } | null>(null);
  const removing = useRef(new Set<string>());
  const hideTimer = useRef<number | null>(null);
  const canvasDeletes = useRef<{ edges: string[]; nodes: string[] } | null>(null);
  /** Which dot the current arrow drag started from (kept by ConnectionFeedback). */
  const dragFrom = useRef<"source" | "target" | null>(null);
  /**
   * A milestone added by "Insert after" without a position, or the first one of an empty template: centre on it
   * once it arrives (the first one at 100 %, not at the canvas's maximum zoom).
   */
  const pendingCentre = useRef<{ id: string; zoom?: number } | null>(null);
  const saveStatus = useSaveStatus();
  const refresh = useCallback(() => router.refresh(), [router]);
  useRefreshAfterRefusal(refresh);
  // The canvas (theme-dependent colour mode) and the panel's choice editor (dnd-kit ids) render differently on the
  // server and in the browser, so both appear once the page is mounted; loading.tsx covers the server render.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const fitAll = useCallback(
    (duration = 300) => rf.fitView({ padding: FIT_PADDING, maxZoom: 1, duration }),
    [rf],
  );
  const fitSoon = useCallback(() => {
    window.setTimeout(() => fitAll(), 250);
  }, [fitAll]);

  const jobs = useTemplateJobs({ resume, onImported: fitSoon });

  // ---------------------------------------------------------------------------
  // Derived canvas data
  // ---------------------------------------------------------------------------

  const cardNodes = useMemo<CardNode[]>(() => {
    const missing = state.rows.filter((r) => !state.positions[r.id]).map((r) => r.id);
    const placed = state.rows.map((r) => state.positions[r.id]).filter((p): p is Position => Boolean(p));
    const fallback = missing.length ? defaultPositions(missing, placed) : {};
    return state.rows.map((r) => {
      const typeLine = typeLineOf(r);
      return {
        id: r.id,
        type: "card",
        position: state.positions[r.id] ?? fallback[r.id],
        width: NODE_W,
        height: NODE_H,
        data: {
          name: r.name,
          value: typeLine,
          typeLine,
          state: "NOT_STARTED",
          mode: "template",
          seq: r.seq ?? undefined,
          connectable: true,
        },
      };
    });
  }, [state.rows, state.positions]);

  const canvasEdges = useMemo<CanvasEdge[]>(() => state.edges.map((e) => ({ id: e.id, from: e.from, to: e.to })), [state.edges]);

  const unconnected = useMemo(() => {
    const linked = new Set(state.edges.flatMap((e) => [e.from, e.to]));
    return state.rows.filter((r) => !linked.has(r.id));
  }, [state.rows, state.edges]);

  const positionOf = useCallback(
    (id: string): Position | undefined => cardNodes.find((n) => n.id === id)?.position,
    [cardNodes],
  );

  // ---------------------------------------------------------------------------
  // Selection
  // ---------------------------------------------------------------------------

  const select = useCallback((id: string | null) => {
    setSelectedId(id);
    setEdgeSel(null);
    setSearchParams({ m: id });
  }, []);

  /**
   * Keyboard: a panel opened from the keyboard (Enter on a card, "Open details") takes the focus, so the next Tab is
   * in the panel rather than on the next of 120 cards and arrows; closing it hands the focus back to the card.
   */
  const focusPanelFor = useRef<string | null>(null);

  /** Pans just enough to show a card the opening panel (or the screen edge) would hide. */
  const revealSoon = useCallback((id: string) => requestAnimationFrame(() => controls.reveal(id)), [controls]);

  /** A card clicked on the canvas: open its panel and keep the card in view. */
  const pick = useCallback(
    (id: string | null) => {
      select(id);
      if (id) revealSoon(id);
    },
    [select, revealSoon],
  );

  const openPanelWithFocus = useCallback(
    (id: string) => {
      focusPanelFor.current = id;
      pick(id);
    },
    [pick],
  );
  useEffect(() => {
    if (!selectedId || focusPanelFor.current !== selectedId) return;
    focusPanelFor.current = null;
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`[${PANEL_BODY_ATTR}]`)?.focus());
  }, [selectedId]);
  const closePanel = useCallback(() => {
    const id = selectedId;
    const hadFocus = Boolean(document.activeElement?.closest("aside[aria-label='Details']"));
    select(null);
    if (!id || !hadFocus) return;
    // The card may be off screen (the canvas only draws visible cards): bring it into view first.
    const card = () => document.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(id)}"]`);
    requestAnimationFrame(() => {
      if (card()) return card()?.focus();
      controls.reveal(id);
      window.setTimeout(() => card()?.focus(), 350);
    });
  }, [controls, select, selectedId]);

  const centreOn = useCallback(
    (id: string, zoom?: number) => {
      const p = positionOf(id);
      if (p) rf.setCenter(p.x + NODE_W / 2, p.y + NODE_H / 2, { zoom: zoom ?? Math.max(rf.getZoom(), 0.9), duration: 300 });
    },
    [positionOf, rf],
  );

  // Close the panel when its milestone disappears (e.g. archived in another tab). A milestone that was just created
  // and hasn't arrived yet is not "gone": only one that was on screen counts.
  const seenSelected = useRef<string | null>(null);
  useEffect(() => {
    if (!selectedId) return;
    if (rowsById.has(selectedId)) seenSelected.current = selectedId;
    else if (seenSelected.current === selectedId) select(null);
  }, [selectedId, rowsById, select]);

  // ---------------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------------

  const move = useCallback(
    (positions: Record<string, Position>) => {
      if (!Object.keys(positions).length) return;
      runWrite({
        optimistic: () => apply({ type: "move", positions }),
        run: (opId) => moveTemplateNodesAction(opId, positions),
      });
    },
    [apply],
  );

  const addEdge = useCallback(
    (from: string, to: string) => {
      const edges = stateRef.current.edges;
      if (from === to || edges.some((e) => e.from === from && e.to === to)) return;
      if (wouldCreateCycle(edges, from, to)) {
        toast.error("That arrow would create a loop.");
        return;
      }
      const opId = newOpId();
      const edge: FlowEdge = { id: `e:${opId}`, from, to, createdAt: "" };
      runWrite(
        {
          optimistic: () => apply({ type: "addEdge", edge }),
          run: (id) => addTemplateEdgeAction(id, from, to),
          onFailure: (f) => f.code === "DUPLICATE",
        },
        opId,
      );
    },
    [apply],
  );

  const removeEdge = useCallback(
    (id: string, opts: { undo?: boolean } = {}) => {
      if (id.startsWith("bridge:")) {
        toast.info("This arrow is still being saved. Try again in a moment.");
        return;
      }
      if (removing.current.has(id)) return;
      const edge = stateRef.current.edges.find((e) => e.id === id);
      if (!edge) return;
      removing.current.add(id);
      const names = `“${rowsById.get(edge.from)?.name ?? "?"}” → “${rowsById.get(edge.to)?.name ?? "?"}”`;
      runWrite({
        optimistic: () => apply({ type: "removeEdges", ids: [id] }),
        run: (opId) => archiveTemplateEdgeAction(opId, id),
        onSuccess: () => {
          removing.current.delete(id);
          if (opts.undo !== false)
            toast.success("Arrow removed", {
              description: names,
              duration: 6000,
              action: { label: "Undo", onClick: () => addEdge(edge.from, edge.to) },
            });
        },
        onFailure: () => {
          removing.current.delete(id);
        },
      });
    },
    [apply, addEdge, rowsById],
  );

  const save = useCallback(
    (row: MilestoneRow, patch: DefPatch) => {
      const optimisticPatch: Partial<MilestoneRow> = { ...patch };
      if (patch.fieldType && FIELD_TYPE_META[patch.fieldType].choicesHaveState && !patch.choices) {
        optimisticPatch.choices = withDefaultStates(row.choices);
      }
      runWrite({
        optimistic: () => apply({ type: "patch", id: row.id, patch: optimisticPatch }),
        run: (opId) => updateMilestoneAction(opId, row.id, patch),
      });
    },
    [apply],
  );

  const applyChoicesTo = useCallback(
    (row: MilestoneRow, targetIds: string[]) => {
      runWrite({
        optimistic: () => apply({ type: "choices", ids: targetIds, choices: row.choices.filter((c) => !c.archived) }),
        run: (opId) => applyChoicesToAction(opId, row.id, targetIds),
        onSuccess: ({ updatedIds }) => {
          if (updatedIds.length === 0) toast.info("Those milestones already have these choices.");
          else toast.success(`Copied the choices of “${row.name}” to ${plural(updatedIds.length, "milestone")}`);
        },
      });
    },
    [apply],
  );

  const restore = useCallback(
    (snapshot: ArchivedSnapshot, archived: { batchId: string; bridgeEdgeIds: string[] }) => {
      runWrite({
        optimistic: () => apply({ type: "restore", snapshot, bridgeEdgeIds: archived.bridgeEdgeIds }),
        run: (opId) => restoreBatchAction(opId, archived.batchId),
        onSuccess: (r) => {
          if (r.restoredIds.length === 0) {
            toast.info(`“${snapshot.row.name}” was already restored.`);
            return;
          }
          const skipped = r.skippedEdgeIds.length;
          toast.success(`Restored “${snapshot.row.name}”`, {
            description: skipped
              ? `${plural(skipped, "arrow")} couldn't come back because ${skipped === 1 ? "it" : "they"} would create a loop.`
              : undefined,
          });
        },
      });
    },
    [apply],
  );

  const archive = useCallback(
    (id: string, reconnect: boolean) => {
      const s = stateRef.current;
      const index = s.rows.findIndex((r) => r.id === id);
      if (index < 0) return;
      const row = s.rows[index];
      const snapshot: ArchivedSnapshot = {
        row,
        index,
        position: s.positions[id],
        edges: s.edges.filter((e) => e.from === id || e.to === id),
      };
      if (selectedId === id) select(null);
      runWrite({
        optimistic: () => apply({ type: "archive", id, reconnect }),
        run: (opId) => archiveMilestoneAction(opId, id, { reconnect }),
        onSuccess: (r) => {
          toast.success(`Archived “${row.name}”`, {
            description: r.bridgeEdgeIds.length
              ? `Its neighbours are joined by ${plural(r.bridgeEdgeIds.length, "new arrow")}.`
              : "You can restore it from the Archive.",
            duration: 10_000,
            action: { label: "Undo", onClick: () => restore(snapshot, r) },
          });
        },
      });
    },
    [apply, restore, select, selectedId],
  );

  /**
   * After an auto-layout: fit everything when it stays readable; a long single row (Left → Right of a 64-step chain)
   * would shrink to a thin line, so show its start instead (F still fits everything).
   */
  const fitLayout = useCallback(
    (positions: Record<string, Position>): boolean => {
      const ps = Object.entries(positions);
      const width = controls.viewportWidth();
      const minX = Math.min(...ps.map(([, p]) => p.x));
      const chartWidth = Math.max(...ps.map(([, p]) => p.x)) - minX + NODE_W;
      if (chartWidth * 0.3 <= width) {
        fitSoon();
        return true;
      }
      const span = Math.max(4, Math.floor(width / (0.55 * (NODE_W + 40)))) * (NODE_W + 40);
      const start = ps.filter(([, p]) => p.x < minX + span).map(([id]) => ({ id }));
      window.setTimeout(() => rf.fitView({ nodes: start, padding: FIT_PADDING, maxZoom: 1, duration: 300 }), 250);
      return false;
    },
    [controls, fitSoon, rf],
  );

  const layout = useCallback(
    (wrap: boolean) => {
      const s = stateRef.current;
      if (!s.rows.length) return;
      const previous: Record<string, Position> = {};
      for (const r of s.rows) {
        const p = positionOf(r.id);
        if (p) previous[r.id] = p;
      }
      const viewportWidth = Math.round(controls.viewportWidth());
      const next = autoLayout(
        s.rows.map((r) => r.id),
        s.edges,
        { wrap, viewportWidth },
      );
      const all = fitLayout(next);
      runWrite({
        optimistic: () => apply({ type: "move", positions: next }),
        run: (opId) => layoutTemplateAction(opId, { wrap, viewportWidth }),
        onSuccess: () =>
          toast.success(wrap ? "Arranged in rows that fit the screen" : "Arranged left to right", {
            description: all ? undefined : "Showing the start of the flow. Press F to see all of it.",
            duration: 8000,
            action: {
              label: "Undo",
              onClick: () => {
                move(previous);
                fitSoon();
              },
            },
          }),
      });
    },
    [apply, controls, fitLayout, fitSoon, move, positionOf],
  );

  /**
   * First visit after the seed (or an import without positions): the importer wrapped the flow for a 1600 px wide
   * screen. When the cards are still exactly there, run the same wrapped layout for this canvas's real width (and
   * save it), so Fit shows a readable chart.
   */
  const firstVisitLayout = useCallback((): { positions: Record<string, Position>; width: number } | null => {
    const s = stateRef.current;
    if (s.rows.length < 2) return null;
    // The width without the side panel when it is docked (a ?m= link opens it), so the layout fits the screen.
    const panel = document.querySelector<HTMLElement>("aside[aria-label='Details']");
    const docked = panel && getComputedStyle(panel).position !== "absolute" ? panel.offsetWidth : 0;
    const width = Math.round(controls.viewportWidth() + docked);
    if (ranksPerRow(width) === ranksPerRow()) return null;
    const ids = s.rows.map((r) => r.id);
    const importer = autoLayout(ids, s.edges, { wrap: true });
    const untouched = ids.every((id) => {
      const p = s.positions[id];
      const q = importer[id];
      return p && q && Math.abs(p.x - q.x) < 0.5 && Math.abs(p.y - q.y) < 0.5;
    });
    return untouched ? { positions: autoLayout(ids, s.edges, { wrap: true, viewportWidth: width }), width } : null;
  }, [controls]);

  /**
   * Opening view: the deep-linked milestone at 100 %, otherwise the whole chart fitted clear of the toolbar and the
   * minimap. It replaces the canvas's own first fit, so the canvas stays hidden until it has settled.
   */
  const [settling, setSettling] = useState(false);
  const opened = useRef(false);
  useLayoutEffect(() => {
    if (!mounted || opened.current) return;
    opened.current = true;
    if (stateRef.current.rows.length === 0) return;
    const next = firstVisitLayout();
    if (next) {
      runWrite({
        optimistic: () => apply({ type: "move", positions: next.positions }),
        run: (opId) => layoutTemplateAction(opId, { wrap: true, viewportWidth: next.width }),
      });
    }
    setSettling(true);
    window.setTimeout(() => {
      const focus = initialSelectedId ? rf.getNode(initialSelectedId) : undefined;
      if (focus) rf.setCenter(focus.position.x + NODE_W / 2, focus.position.y + NODE_H / 2, { zoom: 1, duration: 0 });
      else fitAll(0);
      setSettling(false);
    }, next ? 200 : 120);
  }, [mounted, apply, firstVisitLayout, fitAll, initialSelectedId, rf]);

  // ---------------------------------------------------------------------------
  // New milestones
  // ---------------------------------------------------------------------------

  const centreSpot = useCallback((): Position => {
    const el = wrapperRef.current?.querySelector(".react-flow");
    const rect = el?.getBoundingClientRect();
    const p = rect ? rf.screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }) : { x: 0, y: 0 };
    return freeSpot({ x: p.x - NODE_W / 2, y: p.y - NODE_H / 2 }, cardNodes.map((n) => n.position));
  }, [rf, cardNodes]);

  const openNew = useCallback(
    (position?: Position, where = "in the middle of the screen") => {
      setNewTarget({
        title: "New milestone",
        description: `It goes ${where}, without arrows. Then drag from its dots to connect it.`,
        position: position ?? centreSpot(),
      });
    },
    [centreSpot],
  );

  const openInsertAfter = useCallback(
    (afterId: string, position?: Position) => {
      const after = rowsById.get(afterId);
      if (!after) return;
      const next = stateRef.current.edges
        .filter((e) => e.from === afterId)
        .map((e) => rowsById.get(e.to)?.name)
        .filter(Boolean);
      const description = next.length
        ? `It goes between “${after.name}” and ${next.length === 1 ? `“${next[0]}”` : `the ${next.length} milestones it led to`}.`
        : `It goes right after “${after.name}”, with an arrow from it.`;
      setNewTarget({ title: `Insert after “${after.name}”`, description, afterId, position });
    },
    [rowsById],
  );

  /** Left-dot drag onto empty canvas: a new milestone at that spot with an arrow into this one. */
  const openBefore = useCallback(
    (beforeId: string, position: Position) => {
      const before = rowsById.get(beforeId);
      if (!before) return;
      setNewTarget({
        title: `New milestone before “${before.name}”`,
        description: `It goes where you let go, with an arrow into “${before.name}”.`,
        beforeId,
        position,
      });
    },
    [rowsById],
  );

  const create = useCallback(
    async (name: string, fieldType: FieldType): Promise<string | null> => {
      const t = newTarget;
      if (!t) return null;
      const wasEmpty = stateRef.current.rows.length === 0;
      // A retry of the same input after a failure re-sends the same opId, so it can never add the milestone twice.
      const key = JSON.stringify([name, fieldType, t.afterId ?? null, t.beforeId ?? null, t.position ?? null]);
      const opId = lastCreate.current?.key === key ? lastCreate.current.opId : newOpId();
      lastCreate.current = { key, opId };
      const r = await queuedWrite(() =>
        createMilestoneAction(opId, { name, fieldType, afterMilestoneId: t.afterId, position: t.position }),
      );
      if (!r.ok) {
        if (r.code === "SESSION" || r.code === "STALE_DEPLOYMENT") reportFailure(r);
        refreshAfterRefusal(r);
        return r.error;
      }
      lastCreate.current = null;
      const id = r.data.id;
      const beforeId = t.beforeId;
      if (beforeId) {
        // Queued behind the create, so the new milestone exists by then.
        runWrite({ run: (edgeOp) => addTemplateEdgeAction(edgeOp, id, beforeId), onFailure: (f) => f.code === "DUPLICATE" });
      }
      toast.success(`Added “${r.data.name}”`, {
        description: t.afterId || beforeId ? undefined : "Drag from its dots to connect it.",
      });
      select(id);
      if (wasEmpty) pendingCentre.current = { id, zoom: 1 };
      else if (t.afterId && !t.position) pendingCentre.current = { id };
      return null;
    },
    [newTarget, select],
  );

  // "Insert after" places the new card next to its predecessor (server side): bring it into view once it arrives.
  // The first milestone of an empty template also gets the canvas's first fit (at its maximum zoom): come after it.
  useEffect(() => {
    const p = pendingCentre.current;
    if (p && rowsById.has(p.id)) {
      pendingCentre.current = null;
      window.setTimeout(() => centreOn(p.id, p.zoom), p.zoom ? 250 : 50);
    }
  }, [rowsById, centreOn]);

  // ---------------------------------------------------------------------------
  // Canvas callbacks
  // ---------------------------------------------------------------------------

  /**
   * React Flow reports a node's arrows together with the node when Delete is pressed. Arrows that touch a selected
   * node are left alone (the node's archive handles them, with Reconnect neighbours); only arrows picked on their
   * own are deleted.
   */
  const flushCanvasDeletes = useCallback(() => {
    const pending = canvasDeletes.current;
    canvasDeletes.current = null;
    if (!pending) return;
    const selectedNodes = new Set([...rf.getNodes().filter((n) => n.selected).map((n) => n.id), ...pending.nodes]);
    for (const id of pending.edges) {
      const e = stateRef.current.edges.find((x) => x.id === id);
      if (e && !selectedNodes.has(e.from) && !selectedNodes.has(e.to)) removeEdge(id);
    }
    if (pending.nodes.length === 1) setArchiveAskId(pending.nodes[0]);
    else if (selectedNodes.size > 1) toast.info("Archive milestones one at a time: select one, then press Delete.");
  }, [rf, removeEdge]);

  const queueCanvasDelete = useCallback(
    (kind: "edges" | "nodes", ids: string[]) => {
      if (!canvasDeletes.current) {
        canvasDeletes.current = { edges: [], nodes: [] };
        queueMicrotask(flushCanvasDeletes);
      }
      canvasDeletes.current[kind].push(...ids);
    },
    [flushCanvasDeletes],
  );

  const edgeLabel = useCallback(
    (id: string) => {
      const e = state.edges.find((x) => x.id === id);
      return e ? `Delete the arrow “${rowsById.get(e.from)?.name ?? "?"}” → “${rowsById.get(e.to)?.name ?? "?"}”` : "Delete this arrow";
    },
    [state.edges, rowsById],
  );

  const keepEdgeTool = useCallback(() => {
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    hideTimer.current = null;
  }, []);
  const hideEdgeToolSoon = useCallback(() => {
    keepEdgeTool();
    hideTimer.current = window.setTimeout(() => setEdgeHover(null), 350);
  }, [keepEdgeTool]);

  const edgeMidpoint = useCallback(
    (e: FlowEdge): Position | null => {
      const a = positionOf(e.from);
      const b = positionOf(e.to);
      return a && b ? { x: (a.x + NODE_W + b.x) / 2, y: (a.y + b.y + NODE_H) / 2 } : null;
    },
    [positionOf],
  );

  /**
   * A drag from a dot let go on empty canvas: new milestone right after that one (right dot), or a new one before it
   * whose right dot lands where the drag ended (left dot). A refused arrow (loop) let go on another card's dot can
   * also arrive here; the drop point is then on a card, so it is ignored.
   */
  function onConnectToEmpty(fromId: string, p: Position) {
    const pointer = { x: p.x, y: p.y + NODE_H / 2 };
    const onCard = cardNodes.some(
      (n) => pointer.x >= n.position.x - 16 && pointer.x <= n.position.x + NODE_W + 16 && pointer.y >= n.position.y - 16 && pointer.y <= n.position.y + NODE_H + 16,
    );
    if (onCard) return;
    if (dragFrom.current === "target") openBefore(fromId, { x: Math.round(p.x - NODE_W), y: p.y });
    else openInsertAfter(fromId, p);
  }

  function onCanvasMouseOver(e: React.MouseEvent) {
    if (e.buttons) return;
    const edge = (e.target as Element).closest?.(".react-flow__edge");
    if (!edge) return;
    keepEdgeTool();
    const id = edge.getAttribute("data-id");
    if (id && edgeHover?.id !== id) setEdgeHover({ id, at: rf.screenToFlowPosition({ x: e.clientX, y: e.clientY }) });
  }

  function onCanvasMouseOut(e: React.MouseEvent) {
    if (!(e.target as Element).closest?.(".react-flow__edge")) return;
    const to = (e.relatedTarget as Element | null)?.closest?.(`.react-flow__edge, .${EDGE_TOOL_CLASS}`);
    if (!to) hideEdgeToolSoon();
  }

  function onCanvasClick(e: React.MouseEvent) {
    const t = e.target as Element;
    if (t.closest?.(`.${EDGE_TOOL_CLASS}`)) return;
    const edge = t.closest?.(".react-flow__edge");
    if (edge) {
      const id = edge.getAttribute("data-id");
      if (!id) return;
      select(null);
      setEdgeSel({ id, at: rf.screenToFlowPosition({ x: e.clientX, y: e.clientY }) });
    }
  }

  /**
   * Keyboard: Enter or Space on a focused card opens its panel, Delete / Backspace asks to archive it (the canvas
   * itself only deletes selected cards); Enter or Space on a focused arrow picks the arrow (then Delete).
   */
  function onCanvasKeyDown(e: React.KeyboardEvent) {
    const card = (e.target as Element).closest?.(".react-flow__node");
    const cardId = card?.getAttribute("data-id");
    if (card && cardId && rowsById.has(cardId) && !e.metaKey && !e.ctrlKey && !e.altKey) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openPanelWithFocus(cardId);
      } else if ((e.key === "Delete" || e.key === "Backspace") && !card.classList.contains("selected")) {
        // Not also to the canvas, which would ask about the selected card instead.
        e.preventDefault();
        e.stopPropagation();
        setArchiveAskId(cardId);
      }
      return;
    }
    if (e.key !== "Enter" && e.key !== " ") return;
    const el = (e.target as Element).closest?.(".react-flow__edge");
    const edge = el ? stateRef.current.edges.find((x) => x.id === el.getAttribute("data-id")) : undefined;
    const at = edge ? edgeMidpoint(edge) : null;
    if (!edge || !at) return;
    e.preventDefault();
    select(null);
    setEdgeSel({ id: edge.id, at });
  }

  function onCanvasContextMenu(e: React.MouseEvent) {
    const t = e.target as Element;
    const node = t.closest?.(".react-flow__node");
    const edge = t.closest?.(".react-flow__edge");
    if (node?.getAttribute("data-id")) setMenuTarget({ kind: "node", id: node.getAttribute("data-id")! });
    else if (edge?.getAttribute("data-id")) setMenuTarget({ kind: "edge", id: edge.getAttribute("data-id")! });
    else if (t.classList?.contains("react-flow__pane")) {
      const at = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
      setMenuTarget({ kind: "pane", at: { x: Math.round(at.x - NODE_W / 2), y: Math.round(at.y - NODE_H / 2) } });
    } else {
      // Toolbar, minimap, zoom buttons: no canvas menu.
      e.preventDefault();
      setMenuTarget(null);
    }
  }

  // Forget an arrow selection / hover when that arrow is gone.
  useEffect(() => {
    if (edgeSel && !state.edges.some((e) => e.id === edgeSel.id)) setEdgeSel(null);
    if (edgeHover && !state.edges.some((e) => e.id === edgeHover.id)) setEdgeHover(null);
  }, [state.edges, edgeSel, edgeHover]);

  // ---------------------------------------------------------------------------
  // Keyboard
  // ---------------------------------------------------------------------------

  const anyOverlay =
    newTarget !== null ||
    helpOpen ||
    layoutMenuOpen ||
    contextMenuOpen ||
    archiveAskId !== null ||
    jobs.running ||
    jobs.preview !== null ||
    jobs.syncTargets !== null;

  /**
   * Delete / Backspace / Esc for the selected arrow. React Flow marks these keys as handled before the shared hotkey
   * hook sees them, so this listens in the capture phase.
   */
  useEffect(() => {
    if (!edgeSel || anyOverlay) return;
    const id = edgeSel.id;
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
      const t = e.target;
      if (t instanceof HTMLElement && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName))) return;
      if (e.key === "Escape") {
        setEdgeSel(null);
      } else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        setEdgeSel(null);
        setEdgeHover(null);
        removeEdge(id);
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [edgeSel, anyOverlay, removeEdge]);

  useHotkeys(
    {
      n: (e) => {
        e.preventDefault();
        openNew();
      },
      l: (e) => {
        if (!state.rows.length) return;
        e.preventDefault();
        setLayoutMenuOpen(true);
      },
      f: (e) => {
        e.preventDefault();
        fitAll();
      },
      "?": (e) => {
        e.preventDefault();
        setHelpOpen(true);
      },
    },
    !anyOverlay,
  );

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const menuRow = menuTarget?.kind === "node" ? rowsById.get(menuTarget.id) : undefined;
  const menuEdge = menuTarget?.kind === "edge" ? state.edges.find((e) => e.id === menuTarget.id) : undefined;
  const empty = state.rows.length === 0;
  const syncTargets = jobs.syncTargets;

  return (
    <div className="flex h-svh min-h-0 flex-col">
      <PageHeader
        title="Template Flow"
        description="The flow every new project copies. Drag cards to arrange them; drag from a card's dot to another card to draw an arrow."
      />
      <div className="relative flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <ContextMenu onOpenChange={setContextMenuOpen}>
            <ContextMenuTrigger asChild onContextMenu={onCanvasContextMenu}>
              <div
                ref={wrapperRef}
                className={cn("gpm-template-canvas @container relative min-h-0 flex-1", settling && "opacity-0")}
                onMouseOver={onCanvasMouseOver}
                onMouseOut={onCanvasMouseOut}
                onClick={onCanvasClick}
                onKeyDown={onCanvasKeyDown}
              >
                {mounted ? (
                  <FlowCanvas
                    mode="template"
                    nodes={cardNodes}
                    edges={canvasEdges}
                    editArrows
                    draggable
                    selectedId={selected?.id ?? null}
                    onSelect={pick}
                    onMoveNodes={move}
                    onConnect={addEdge}
                    onDeleteEdges={(ids) => queueCanvasDelete("edges", ids)}
                    onDeleteNode={(id) => queueCanvasDelete("nodes", [id])}
                    onPaneDoubleClick={(p) => openNew(p, "where you double-clicked")}
                    onConnectToEmpty={onConnectToEmpty}
                    initialFocusId={initialSelectedId}
                  >
                    <TemplateToolbar
                      onNew={() => openNew()}
                      layoutMenuOpen={layoutMenuOpen}
                      onLayoutMenuOpenChange={setLayoutMenuOpen}
                      onLayout={layout}
                      onFit={() => fitAll()}
                      onExport={() => void jobs.exportJson()}
                      exporting={jobs.exporting}
                      onImportFile={(f) => void jobs.chooseImportFile(f)}
                      importing={jobs.previewing}
                      onSyncAll={() => void jobs.askSyncAll()}
                      syncing={jobs.checkingSync}
                      busy={jobs.running}
                      onHelp={() => setHelpOpen(true)}
                      saveStatus={saveStatus}
                      disabled={{ layout: empty }}
                    />
                  </FlowCanvas>
                ) : null}
                <ConnectionFeedback edges={state.edges} fromType={dragFrom} />
                <EdgeTools
                  hovered={edgeHover}
                  selected={edgeSel}
                  label={edgeLabel}
                  onDelete={(id) => {
                    setEdgeHover(null);
                    setEdgeSel(null);
                    removeEdge(id);
                  }}
                  onPointerEnter={keepEdgeTool}
                  onPointerLeave={hideEdgeToolSoon}
                />
                {empty ? (
                  <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-6">
                    <div className="pointer-events-auto max-w-sm rounded-lg border bg-background p-5 text-center shadow-sm">
                      <h2 className="text-sm font-semibold">The template has no milestones</h2>
                      <p className="mt-1 text-sm text-muted-foreground">
                        Add the first one, or import a template file. You can also restore archived milestones from the Archive.
                      </p>
                      <div className="mt-3 flex justify-center gap-2">
                        <Button size="sm" onClick={() => openNew()}>
                          <Plus aria-hidden /> Milestone
                        </Button>
                        <Button size="sm" variant="outline" asChild>
                          <a href="/archive?tab=milestones">Open the Archive</a>
                        </Button>
                      </div>
                    </div>
                  </div>
                ) : null}
              </div>
            </ContextMenuTrigger>
            {/* Don't hand focus back to the canvas: a dialog or the archive popover opened from the menu keeps it. */}
            <ContextMenuContent className="w-60" onCloseAutoFocus={(e) => e.preventDefault()}>
              {menuRow ? (
                <>
                  <ContextMenuLabel className="truncate text-xs text-muted-foreground">
                    {menuRow.seq !== null ? `#${menuRow.seq} ` : ""}
                    {menuRow.name}
                  </ContextMenuLabel>
                  <ContextMenuItem onSelect={() => openPanelWithFocus(menuRow.id)}>
                    <PanelRight aria-hidden /> Open details
                  </ContextMenuItem>
                  <ContextMenuItem onSelect={() => openInsertAfter(menuRow.id)}>
                    <CornerDownRight aria-hidden /> Insert milestone after
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem variant="destructive" onSelect={() => setArchiveAskId(menuRow.id)}>
                    <Archive aria-hidden /> Archive…
                    <ContextMenuShortcut>Del</ContextMenuShortcut>
                  </ContextMenuItem>
                </>
              ) : menuEdge ? (
                <>
                  <ContextMenuLabel className="text-xs text-muted-foreground">
                    <span className="line-clamp-2">
                      {rowsById.get(menuEdge.from)?.name ?? "?"} → {rowsById.get(menuEdge.to)?.name ?? "?"}
                    </span>
                  </ContextMenuLabel>
                  <ContextMenuItem variant="destructive" onSelect={() => removeEdge(menuEdge.id)}>
                    <Trash2 aria-hidden /> Delete arrow
                    <ContextMenuShortcut>Del</ContextMenuShortcut>
                  </ContextMenuItem>
                </>
              ) : menuTarget?.kind === "pane" ? (
                <>
                  <ContextMenuItem onSelect={() => openNew(menuTarget.at, "where you right-clicked")}>
                    <Plus aria-hidden /> New milestone here
                    <ContextMenuShortcut>N</ContextMenuShortcut>
                  </ContextMenuItem>
                  <ContextMenuItem onSelect={() => fitAll()} disabled={empty}>
                    <Maximize aria-hidden /> Fit the whole chart
                    <ContextMenuShortcut>F</ContextMenuShortcut>
                  </ContextMenuItem>
                </>
              ) : null}
            </ContextMenuContent>
          </ContextMenu>
          <InfoStrip
            milestoneCount={state.rows.length}
            arrowCount={state.edges.length}
            unconnected={unconnected}
            onPick={(id) => {
              select(id);
              centreOn(id);
            }}
          />
        </div>

        {selected && mounted ? (
          <TemplatePanel
            row={selected}
            rows={state.rows}
            rowsById={rowsById}
            edges={state.edges}
            onClose={closePanel}
            onSave={(patch) => save(selected, patch)}
            onApplyChoicesTo={(ids) => applyChoicesTo(selected, ids)}
            onAddEdge={addEdge}
            onRemoveEdge={(edge) => removeEdge(edge.id)}
            onInsertAfter={() => openInsertAfter(selected.id)}
            onArchive={(reconnect) => archive(selected.id, reconnect)}
            onOpen={(id) => {
              select(id);
              centreOn(id);
            }}
          />
        ) : null}
      </div>

      <NewItemDialog
        open={newTarget !== null}
        onOpenChange={(o) => {
          if (!o) setNewTarget(null);
        }}
        title={newTarget?.title ?? "New milestone"}
        description={newTarget?.description ?? ""}
        nameLabel="Milestone name"
        namePlaceholder="e.g. Site survey"
        fieldTypes={FIELD_TYPES}
        defaultType="DROPDOWN"
        submitLabel="Add milestone"
        showStateRule
        onCreate={create}
      />

      <CanvasArchiveConfirm
        row={archiveAskId ? (rowsById.get(archiveAskId) ?? null) : null}
        rowsById={rowsById}
        edges={state.edges}
        onConfirm={archive}
        onClose={() => setArchiveAskId(null)}
      />

      <ImportDialog
        preview={jobs.preview}
        pending={jobs.startingImport}
        onCancel={jobs.cancelImport}
        onConfirm={() => void jobs.confirmImport()}
      />

      <ConfirmDialog
        open={syncTargets !== null}
        onOpenChange={(o) => {
          if (!o) jobs.cancelSyncAll();
        }}
        title={`Sync ${plural(syncTargets?.length ?? 0, "active project")} with the template?`}
        description={
          syncTargets ? (
            <>
              <p>
                Each project gets the template changes that are ticked by default in its own Sync: new milestones, updated choices and new
                arrows. Values, notes and files are never changed or deleted.
              </p>
              <ul className="max-h-48 overflow-y-auto rounded-md border text-xs" aria-label="Projects to sync">
                {syncTargets.map((t) => (
                  <li key={t.projectId} className="border-b px-2 py-1.5 last:border-b-0">
                    <div className="flex items-baseline gap-2">
                      <span className="shrink-0 font-medium text-foreground tabular-nums">{t.code}</span>
                      <span className="min-w-0 flex-1 truncate">{t.name}</span>
                    </div>
                    <div className="text-[11px] text-muted-foreground">
                      {t.templateChanged ? "The template changed since its last sync" : "Already synced with this version of the template"}
                    </div>
                  </li>
                ))}
              </ul>
              <p className="text-xs">To pick changes one by one, use “Sync from template…” on the project page instead.</p>
            </>
          ) : null
        }
        confirmLabel={`Sync ${plural(syncTargets?.length ?? 0, "project")}`}
        onConfirm={() => {
          if (syncTargets) void jobs.syncAll(syncTargets);
        }}
      />

      <ShortcutsDialog open={helpOpen} onOpenChange={setHelpOpen} />
      {jobs.dialog}
    </div>
  );
}
