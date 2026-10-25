"use client";

import { useEffect, useRef } from "react";
import { useConnection } from "@xyflow/react";
import { toast } from "sonner";
import type { FlowEdge } from "@/domain/types";

/**
 * The canvas refuses an arrow that would make a loop (or already exists) by not connecting it. This says why when
 * such a drag is let go over the refused dot. Renders nothing; only this tiny component re-renders during a drag.
 * It also keeps which dot the current drag started from (`fromType`), so a drop on empty canvas knows whether the
 * new milestone goes after (right dot) or before (left dot) the card.
 */
export function ConnectionFeedback({
  edges,
  fromType,
}: {
  edges: FlowEdge[];
  fromType?: React.RefObject<"source" | "target" | null>;
}) {
  const c = useConnection((s) => ({
    inProgress: s.inProgress,
    isValid: s.isValid,
    from: s.fromNode?.id ?? null,
    to: s.toNode?.id ?? null,
    fromType: s.fromHandle?.type ?? null,
  }));
  const last = useRef(c);
  const edgesRef = useRef(edges);
  edgesRef.current = edges;

  useEffect(() => {
    const prev = last.current;
    last.current = c;
    if (fromType && c.inProgress) fromType.current = c.fromType;
    if (!prev.inProgress || c.inProgress || prev.isValid !== false || !prev.from || !prev.to) return;
    if (prev.from === prev.to) toast.error("An arrow can't start and end at the same milestone.");
    else if (edgesRef.current.some((e) => e.from === prev.from && e.to === prev.to)) toast.info("That arrow is already there.");
    else toast.error("That arrow would create a loop.", { description: "The second milestone already leads to the first one." });
  }, [c]);

  return null;
}
