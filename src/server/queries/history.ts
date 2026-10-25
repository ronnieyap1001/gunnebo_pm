import "server-only";
/**
 * History read models (newest first, paged with opaque cursors).
 */
import type { EventSource } from "@/domain/types";
import type { Page, Repo, StoredHistoryEvent } from "@/server/repo/types";
import { EV } from "@/server/services/context";
import type { TemplateFile } from "@/domain/templateFile";

export interface HistoryItemDTO {
  id: string;
  type: string;
  source: EventSource;
  actor: string;
  summary: string;
  oldDisplay: string | null;
  newDisplay: string | null;
  occurredAt: string;
  recordedAt: string;
  seq: number;
  projectId: string | null;
  stepId: string | null;
  milestoneId: string | null;
  milestoneKey: string | null;
  /** Structured payload (old/new snapshots, …). Null for template snapshots (fetch them with getTemplateSnapshots). */
  data: Record<string, unknown> | null;
  /** Steps this row relates to (a bulk action relates to many). */
  stepIds: string[];
}

export interface HistoryPageDTO {
  items: HistoryItemDTO[];
  nextCursor: string | null;
}

export interface HistoryFilters {
  type?: string;
  source?: EventSource;
}

export const HISTORY_PAGE_SIZE = 25;

export function historyItemDTO(e: StoredHistoryEvent): HistoryItemDTO {
  const raw = e.data as { stepIds?: unknown } | undefined;
  const related = Array.isArray(raw?.stepIds) ? (raw!.stepIds as unknown[]).filter((x): x is string => typeof x === "string") : [];
  return {
    id: e.id,
    type: e.type,
    source: e.source,
    actor: e.actor,
    summary: e.summary,
    oldDisplay: e.oldDisplay ?? null,
    newDisplay: e.newDisplay ?? null,
    occurredAt: e.occurredAt,
    recordedAt: e.recordedAt,
    seq: e.seq,
    projectId: e.projectId ?? null,
    stepId: e.stepId ?? null,
    milestoneId: e.milestoneId ?? null,
    milestoneKey: e.milestoneKey ?? null,
    data: e.type === EV.templateSnapshot ? null : (e.data ?? null),
    stepIds: [...new Set([...(e.stepId ? [e.stepId] : []), ...related])],
  };
}

function toPage(p: Page<StoredHistoryEvent>): HistoryPageDTO {
  return { items: p.items.map(historyItemDTO), nextCursor: p.nextCursor };
}

/** A step's history (side panel: last 5, then "Show all"). */
export async function getStepHistory(repo: Repo, stepId: string, cursor: string | null = null, limit = HISTORY_PAGE_SIZE): Promise<HistoryPageDTO> {
  return toPage(await repo.history.listByStep(stepId, { cursor, limit }));
}

/** A project's History tab, with optional type / source filters. */
export async function getProjectHistory(
  repo: Repo,
  projectId: string,
  filters: HistoryFilters = {},
  cursor: string | null = null,
  limit = HISTORY_PAGE_SIZE,
): Promise<HistoryPageDTO> {
  return toPage(await repo.history.listByProject(projectId, { cursor, limit, type: filters.type, source: filters.source }));
}

/** Everything (library/template events included), e.g. for Settings → History. */
export async function getAllHistory(
  repo: Repo,
  filters: HistoryFilters = {},
  cursor: string | null = null,
  limit = HISTORY_PAGE_SIZE,
): Promise<HistoryPageDTO> {
  return toPage(await repo.history.listAll({ cursor, limit, type: filters.type, source: filters.source }));
}

export interface TemplateSnapshotDTO {
  id: string;
  occurredAt: string;
  summary: string;
  reason: string | null;
  revision: number | null;
  /** The template as it was before the import/reset (download as JSON to roll back via Import). */
  file: TemplateFile | null;
}

/** Template snapshots saved before imports and resets, newest first. */
export async function getTemplateSnapshots(repo: Repo, cursor: string | null = null, limit = 10): Promise<{ items: TemplateSnapshotDTO[]; nextCursor: string | null }> {
  const page = await repo.history.listAll({ type: EV.templateSnapshot, cursor, limit });
  return {
    items: page.items.map((e) => {
      const d = (e.data ?? {}) as { reason?: string; revision?: number; file?: TemplateFile };
      return {
        id: e.id,
        occurredAt: e.occurredAt,
        summary: e.summary,
        reason: d.reason ?? null,
        revision: typeof d.revision === "number" ? d.revision : null,
        file: d.file ?? null,
      };
    }),
    nextCursor: page.nextCursor,
  };
}
