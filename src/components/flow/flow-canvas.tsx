"use client";

import "@xyflow/react/dist/style.css";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  getSmoothStepPath,
  MarkerType,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeProps,
  type IsValidConnection,
  type NodeChange,
  type OnConnectEnd,
} from "@xyflow/react";
import { useTheme } from "next-themes";
import { toast } from "sonner";
import { X } from "lucide-react";
import type { FlowEdge, Position, State } from "@/domain/types";
import { wouldCreateCycle } from "@/domain/graph";
import { STATE_META } from "@/domain/state";
import { NODE_H, NODE_TYPES, NODE_W, type CardNode } from "./node-card";

export const FlowProvider = ReactFlowProvider;

/** An arrow as the canvas needs it. */
export interface CanvasEdge {
  id: string;
  from: string;
  to: string;
  /** Source step is Done: draw the arrow green. */
  done?: boolean;
  /** Touches an N/A step: draw it dashed. */
  dashed?: boolean;
}

export interface FlowCanvasProps {
  mode: "template" | "project";
  nodes: CardNode[];
  edges: CanvasEdge[];
  /** Arrow editing: handles visible, arrows can be drawn and deleted. */
  editArrows: boolean;
  /** Nodes can be dragged. */
  draggable?: boolean;
  selectedId?: string | null;
  onSelect?: (id: string | null) => void;
  onMoveNodes?: (positions: Record<string, Position>) => void;
  onConnect?: (from: string, to: string) => void;
  onDeleteEdges?: (ids: string[]) => void;
  /** Delete key on a selected node (template / project-only nodes). */
  onDeleteNode?: (id: string) => void;
  onPaneDoubleClick?: (position: Position) => void;
  /** Drag from a node's handle onto empty canvas. */
  onConnectToEmpty?: (fromId: string, position: Position) => void;
  /** Ids to fit on first render (e.g. current milestones); all nodes when empty. */
  initialFitIds?: string[];
  /** Centre on this node at first render (deep link). */
  initialFocusId?: string | null;
  /** Toast why a dropped arrow was refused (loop, duplicate, same step). */
  connectionFeedback?: boolean;
  /** In arrow-editing mode, show a delete × on the hovered or selected arrow (calls onDeleteEdges). */
  edgeDeleteButton?: boolean;
  /** Right-click on a node / an arrow / the empty canvas (fires before a wrapping context menu opens). */
  onNodeContextMenu?: (id: string) => void;
  onEdgeContextMenu?: (id: string) => void;
  onPaneContextMenu?: (position: Position) => void;
  children?: React.ReactNode;
}

type DeletableEdgeData = { onDelete?: (id: string) => void; onHover?: (id: string | null) => void; hovered?: boolean; label?: string };
type DeletableEdgeType = Edge<DeletableEdgeData, "deletable">;

/** Smoothstep arrow with a delete × at its middle while hovered or selected (arrow-editing mode). */
function DeletableEdge(props: EdgeProps<DeletableEdgeType>) {
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, style, selected, data, interactionWidth } = props;
  const [path, labelX, labelY] = getSmoothStepPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  const show = Boolean(data?.onDelete) && (selected || data?.hovered);
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        style={selected ? { ...style, strokeWidth: 2.5, opacity: 1 } : style}
        interactionWidth={interactionWidth}
      />
      {show ? (
        <EdgeLabelRenderer>
          <button
            type="button"
            className="nodrag nopan absolute flex size-5 items-center justify-center rounded-full border bg-background text-muted-foreground shadow-sm hover:border-destructive hover:text-destructive focus-visible:outline-2 focus-visible:outline-ring"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`, pointerEvents: "all" }}
            onPointerEnter={() => data?.onHover?.(id)}
            onPointerLeave={() => data?.onHover?.(null)}
            onClick={(e) => {
              e.stopPropagation();
              data?.onDelete?.(id);
            }}
            aria-label={data?.label ? `Delete arrow ${data.label}` : "Delete arrow"}
            title="Delete arrow"
          >
            <X className="size-3" aria-hidden />
          </button>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}

/** Defined at module level so React Flow does not re-create edge types on every render. */
const EDGE_TYPES = { deletable: DeletableEdge };

const MOVE_DEBOUNCE_MS = 300;

const noopSubscribe = () => () => {};
/** False while hydrating server HTML, true afterwards (and immediately for client-only mounts). */
export function useIsClient(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
}

function toFlowEdges(edges: CanvasEdge[]): FlowEdge[] {
  return edges.map((e) => ({ id: e.id, from: e.from, to: e.to, createdAt: "" }));
}

function FlowCanvasInner({
  mode,
  nodes: inputNodes,
  edges: inputEdges,
  editArrows,
  draggable = true,
  selectedId,
  onSelect,
  onMoveNodes,
  onConnect,
  onDeleteEdges,
  onDeleteNode,
  onPaneDoubleClick,
  onConnectToEmpty,
  initialFitIds,
  initialFocusId,
  edgeDeleteButton,
  connectionFeedback,
  onNodeContextMenu,
  onEdgeContextMenu,
  onPaneContextMenu,
  children,
}: FlowCanvasProps) {
  const { resolvedTheme } = useTheme();
  // The theme is only known in the browser: render "light" while hydrating so server and client HTML match.
  const isClient = useIsClient();
  const rf = useReactFlow();
  const [nodes, setNodes, onNodesChangeBase] = useNodesState<CardNode>(inputNodes);
  const dragging = useRef(new Set<string>());
  const pendingMoves = useRef<Record<string, Position>>({});
  const moveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Merge server/parent updates without fighting an in-progress drag.
  useEffect(() => {
    setNodes((current) => {
      const byId = new Map(current.map((n) => [n.id, n]));
      return inputNodes.map((n) => {
        const existing = byId.get(n.id);
        const keepPosition = existing && (dragging.current.has(n.id) || pendingMoves.current[n.id]);
        return {
          ...n,
          position: keepPosition ? existing.position : n.position,
          selected: n.id === selectedId,
          draggable,
        };
      });
    });
  }, [inputNodes, selectedId, draggable, setNodes]);

  const flushMoves = useCallback(() => {
    const moves = pendingMoves.current;
    pendingMoves.current = {};
    if (Object.keys(moves).length && onMoveNodes) onMoveNodes(moves);
  }, [onMoveNodes]);

  useEffect(() => () => {
    if (moveTimer.current) clearTimeout(moveTimer.current);
  }, []);

  const onNodesChange = useCallback(
    (changes: NodeChange<CardNode>[]) => {
      // Deletions are handled explicitly (archive with Undo), never by React Flow directly.
      const filtered = changes.filter((c) => c.type !== "remove");
      onNodesChangeBase(filtered);
      for (const c of filtered) {
        if (c.type !== "position") continue;
        if (c.dragging) {
          dragging.current.add(c.id);
        } else if (dragging.current.has(c.id)) {
          dragging.current.delete(c.id);
        }
        if (c.position) pendingMoves.current[c.id] = { x: Math.round(c.position.x), y: Math.round(c.position.y) };
      }
      if (Object.keys(pendingMoves.current).length && dragging.current.size === 0) {
        if (moveTimer.current) clearTimeout(moveTimer.current);
        moveTimer.current = setTimeout(flushMoves, MOVE_DEBOUNCE_MS);
      }
    },
    [onNodesChangeBase, flushMoves],
  );

  const stateById = useMemo(() => {
    const m = new Map<string, State>();
    for (const n of inputNodes) m.set(n.id, n.data.state);
    return m;
  }, [inputNodes]);

  const [hoveredEdge, setHoveredEdge] = useState<string | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverEdge = useCallback((id: string | null) => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    if (id) setHoveredEdge(id);
    else hoverTimer.current = setTimeout(() => setHoveredEdge(null), 250);
  }, []);
  useEffect(() => () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
  }, []);
  const withDeleteButton = Boolean(edgeDeleteButton && editArrows && onDeleteEdges);
  const deleteEdge = useCallback((id: string) => onDeleteEdges?.([id]), [onDeleteEdges]);

  const edges: Edge[] = useMemo(
    () =>
      inputEdges.map((e) => {
        const color =
          mode === "project" && e.done ? "var(--state-d-solid)" : "var(--color-muted-foreground, #888)";
        return {
          id: e.id,
          source: e.from,
          target: e.to,
          type: withDeleteButton ? "deletable" : "smoothstep",
          data: withDeleteButton ? { onDelete: deleteEdge, onHover: hoverEdge, hovered: hoveredEdge === e.id } : undefined,
          selectable: editArrows,
          deletable: editArrows,
          interactionWidth: 14,
          markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color },
          style: {
            stroke: color,
            strokeWidth: 1.5,
            opacity: mode === "project" && e.done ? 0.6 : 0.75,
            strokeDasharray: e.dashed ? "4 3" : undefined,
          },
        };
      }),
    [inputEdges, editArrows, mode, withDeleteButton, deleteEdge, hoverEdge, hoveredEdge],
  );

  const isValidConnection: IsValidConnection = useCallback(
    (c) => {
      if (!c.source || !c.target || c.source === c.target) return false;
      return !wouldCreateCycle(toFlowEdges(inputEdges), c.source, c.target);
    },
    [inputEdges],
  );

  const handleConnect = useCallback(
    (c: Connection) => {
      if (!c.source || !c.target) return;
      if (wouldCreateCycle(toFlowEdges(inputEdges), c.source, c.target)) {
        toast.error("That arrow would create a loop.");
        return;
      }
      if (inputEdges.some((e) => e.from === c.source && e.to === c.target)) return;
      onConnect?.(c.source, c.target);
    },
    [inputEdges, onConnect],
  );

  const handleConnectEnd: OnConnectEnd = useCallback(
    (event, state) => {
      // Say why a drag that ended on a refused dot did not draw an arrow (opt-in; Template Flow has its own).
      if (connectionFeedback && state.isValid === false && state.fromNode && state.toNode) {
        const forward = state.fromHandle?.type !== "target";
        const from = forward ? state.fromNode.id : state.toNode.id;
        const to = forward ? state.toNode.id : state.fromNode.id;
        if (from === to) toast.error("An arrow can't start and end at the same step.");
        else if (inputEdges.some((e) => e.from === from && e.to === to)) toast.info("That arrow is already there.");
        else toast.error("That arrow would create a loop.", { description: "The second step already leads to the first one." });
        return;
      }
      if (!onConnectToEmpty || state.isValid || !state.fromNode) return;
      const target = event.target as Element | null;
      if (!target?.classList.contains("react-flow__pane")) return;
      const point = "changedTouches" in event ? event.changedTouches[0] : (event as MouseEvent);
      const pos = rf.screenToFlowPosition({ x: point.clientX, y: point.clientY });
      onConnectToEmpty(state.fromNode.id, { x: Math.round(pos.x), y: Math.round(pos.y - NODE_H / 2) });
    },
    [onConnectToEmpty, rf, connectionFeedback, inputEdges],
  );

  // First render: deep link > fit current > fit all.
  const didInitialView = useRef(false);
  useEffect(() => {
    if (didInitialView.current || !nodes.length) return;
    didInitialView.current = true;
    requestAnimationFrame(() => {
      if (initialFocusId && nodes.some((n) => n.id === initialFocusId)) {
        const n = nodes.find((x) => x.id === initialFocusId)!;
        rf.setCenter(n.position.x + NODE_W / 2, n.position.y + NODE_H / 2, { zoom: 1, duration: 0 });
      } else if (initialFitIds && initialFitIds.length) {
        rf.fitView({ nodes: initialFitIds.map((id) => ({ id })), padding: 0.3, maxZoom: 1, duration: 0 });
      } else {
        rf.fitView({ padding: 0.1, duration: 0 });
      }
    });
  }, [nodes, initialFitIds, initialFocusId, rf]);

  return (
    <ReactFlow<CardNode>
      nodes={nodes}
      edges={edges}
      nodeTypes={NODE_TYPES}
      edgeTypes={EDGE_TYPES}
      onEdgeMouseEnter={withDeleteButton ? (_, e) => hoverEdge(e.id) : undefined}
      onEdgeMouseLeave={withDeleteButton ? () => hoverEdge(null) : undefined}
      onNodeContextMenu={onNodeContextMenu ? (_, n) => onNodeContextMenu(n.id) : undefined}
      onEdgeContextMenu={onEdgeContextMenu ? (_, e) => onEdgeContextMenu(e.id) : undefined}
      onPaneContextMenu={
        onPaneContextMenu
          ? (e) => {
              const pos = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
              onPaneContextMenu({ x: Math.round(pos.x - NODE_W / 2), y: Math.round(pos.y - NODE_H / 2) });
            }
          : undefined
      }
      onNodesChange={onNodesChange}
      onNodeClick={(_, n) => onSelect?.(n.id)}
      onKeyDown={(e) => {
        // Keyboard users Tab to a card and press Enter (or Space) to open it, like a click.
        if ((e.key !== "Enter" && e.key !== " ") || e.metaKey || e.ctrlKey || e.altKey || !onSelect) return;
        const target = e.target as HTMLElement;
        if (!target.classList?.contains("react-flow__node")) return;
        const id = target.getAttribute("data-id");
        if (!id) return;
        e.preventDefault();
        onSelect(id);
      }}
      // A visible keyboard focus ring on cards (React Flow's own stylesheet removes the outline).
      className="[&_[aria-roledescription=node]:focus-visible]:rounded-md [&_[aria-roledescription=node]:focus-visible]:outline-2! [&_[aria-roledescription=node]:focus-visible]:outline-offset-4! [&_[aria-roledescription=node]:focus-visible]:outline-ring!"
      onPaneClick={() => onSelect?.(null)}
      onDoubleClick={(e) => {
        if (!onPaneDoubleClick) return;
        const target = e.target as Element;
        if (!target.classList.contains("react-flow__pane")) return;
        const pos = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
        onPaneDoubleClick({ x: Math.round(pos.x - NODE_W / 2), y: Math.round(pos.y - NODE_H / 2) });
      }}
      zoomOnDoubleClick={false}
      onConnect={editArrows ? handleConnect : undefined}
      onConnectEnd={editArrows && (onConnectToEmpty || connectionFeedback) ? handleConnectEnd : undefined}
      isValidConnection={isValidConnection}
      nodesConnectable={editArrows}
      onBeforeDelete={async ({ nodes: delNodes, edges: delEdges }) => {
        if (delEdges.length && editArrows) onDeleteEdges?.(delEdges.map((e) => e.id));
        if (delNodes.length === 1 && onDeleteNode) onDeleteNode(delNodes[0].id);
        return false; // parent performs the archive (with Undo); React Flow never deletes directly
      }}
      deleteKeyCode={editArrows || onDeleteNode ? ["Backspace", "Delete"] : null}
      onlyRenderVisibleElements
      minZoom={0.1}
      maxZoom={2}
      colorMode={isClient && resolvedTheme === "dark" ? "dark" : "light"}
      proOptions={{ hideAttribution: true }}
      fitView={false}
    >
      <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
      <MiniMap
        pannable
        zoomable
        nodeStrokeWidth={2}
        nodeColor={(n) => {
          if (mode === "template") return "var(--color-muted-foreground, #999)";
          const s = stateById.get(n.id) ?? "NOT_STARTED";
          return `var(--state-${STATE_META[s].code.toLowerCase()}-solid)`;
        }}
        className="!bg-background"
      />
      <Controls showInteractive={false} />
      {children ? <Panel position="top-left">{children}</Panel> : null}
    </ReactFlow>
  );
}

export function FlowCanvas(props: FlowCanvasProps) {
  return <FlowCanvasInner {...props} />;
}

/** Imperative helpers for toolbars rendered inside the same FlowProvider. */
export function useFlowControls() {
  const rf = useReactFlow();
  return {
    fitAll: () => rf.fitView({ padding: 0.1, duration: 300 }),
    fitIds: (ids: string[]) =>
      ids.length ? rf.fitView({ nodes: ids.map((id) => ({ id })), padding: 0.3, maxZoom: 1, duration: 300 }) : rf.fitView({ padding: 0.1, duration: 300 }),
    centerOn: (id: string) => {
      const n = rf.getNode(id);
      if (n) rf.setCenter(n.position.x + NODE_W / 2, n.position.y + NODE_H / 2, { zoom: Math.max(rf.getZoom(), 0.9), duration: 300 });
    },
    /** Pans (keeping the zoom) just enough to show a node that is off-screen or under a panel. */
    reveal: (id: string) => {
      const n = rf.getNode(id);
      const el = document.querySelector(".react-flow");
      if (!n || !el) return;
      const { x, y, zoom } = rf.getViewport();
      const sx = n.position.x * zoom + x;
      const sy = n.position.y * zoom + y;
      const m = 24;
      const visible = sx >= m && sy >= m && sx + NODE_W * zoom <= el.clientWidth - m && sy + NODE_H * zoom <= el.clientHeight - m;
      if (!visible) rf.setCenter(n.position.x + NODE_W / 2, n.position.y + NODE_H / 2, { zoom, duration: 250 });
    },
    /** Viewport width in pixels (for the wrapped auto-layout). */
    viewportWidth: () => {
      const el = document.querySelector(".react-flow");
      return el ? el.clientWidth : 1600;
    },
    /** A free spot below everything (for new nodes). */
    belowAll: (): Position => {
      const ns = rf.getNodes();
      if (!ns.length) return { x: 0, y: 0 };
      const maxY = Math.max(...ns.map((n) => n.position.y));
      const minX = Math.min(...ns.map((n) => n.position.x));
      return { x: Math.round(minX), y: Math.round(maxY + NODE_H + 60) };
    },
  };
}
