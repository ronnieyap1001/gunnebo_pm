import "server-only";
/**
 * Tamper-evidence for History rows: sha256 over the canonical row content at write time.
 * Leaf module (no repo, no Notion) so every Repo implementation and the "Verify history" service share one rule.
 *
 * The hash covers what the app writes; it leaves out the storage id and recordedAt (assigned by storage) and the
 * hash itself.
 */
import { createHash } from "node:crypto";
import { stableStringify } from "@/domain/syncPlan";
import type { HistoryEvent } from "@/domain/types";

export type HashableHistoryRow = Omit<HistoryEvent, "id" | "recordedAt"> & { opId?: string; seq: number };

/** The canonical content string of a row (stable key order, undefined members dropped). */
export function canonicalHistoryContent(row: HashableHistoryRow): string {
  return stableStringify({
    projectId: row.projectId,
    stepId: row.stepId,
    milestoneId: row.milestoneId,
    milestoneKey: row.milestoneKey,
    type: row.type,
    source: row.source,
    actor: row.actor,
    summary: row.summary,
    oldDisplay: row.oldDisplay,
    newDisplay: row.newDisplay,
    data: row.data,
    correlationId: row.correlationId,
    externalRef: row.externalRef,
    occurredAt: row.occurredAt,
    opId: row.opId,
    seq: row.seq,
  });
}

/** Lowercase hex sha256 of the canonical content. */
export function historyHash(row: HashableHistoryRow): string {
  return createHash("sha256").update(canonicalHistoryContent(row), "utf8").digest("hex");
}
