"use client";

import { useEffect, useState } from "react";
import { onQueueChange, pendingCount } from "@/lib/write-queue";
import { queueKey } from "./write";

/** Writes queued or in flight for the project (for "Saving…"). */
export function usePendingWrites(projectId: string): number {
  const key = queueKey(projectId);
  const [n, setN] = useState(0);
  useEffect(() => {
    setN(pendingCount(key));
    return onQueueChange((k, count) => {
      if (k === key) setN(count);
    });
  }, [key]);
  return n;
}

/** A counter that goes up every time the project's write queue drains (History panels refetch on it). */
export function useQueueIdleTick(projectId: string): number {
  const key = queueKey(projectId);
  const [tick, setTick] = useState(0);
  useEffect(
    () =>
      onQueueChange((k, count) => {
        if (k === key && count === 0) setTick((t) => t + 1);
      }),
    [key],
  );
  return tick;
}
