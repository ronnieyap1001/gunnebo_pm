/**
 * Shapes the Archive screen passes from the server to the browser. Pure (no server or client imports), so both the
 * page / actions and the client components can use it.
 */
import type { ArchiveData, TemplateSnapshotDTO } from "@/server/queries";

export type ArchiveProjectItems = NonNullable<ArchiveData["project"]>;

/** One project's archived items plus the names of the steps their notes and files belong to (stepId → name). */
export interface ArchiveProjectView extends ArchiveProjectItems {
  stepNames: Record<string, string>;
}

/** A template snapshot without its (large) template file; the file downloads through /api/template-snapshot/[id]. */
export interface SnapshotRow {
  id: string;
  occurredAt: string;
  summary: string;
  reason: string | null;
  revision: number | null;
  hasFile: boolean;
  milestoneCount: number | null;
  edgeCount: number | null;
}

export function toArchiveProject(p: ArchiveProjectItems, stepNames: Record<string, string> = {}): ArchiveProjectView {
  return { id: p.id, code: p.code, name: p.name, steps: p.steps, notes: p.notes, attachments: p.attachments, stepNames };
}

export function toSnapshotRow(s: TemplateSnapshotDTO): SnapshotRow {
  return {
    id: s.id,
    occurredAt: s.occurredAt,
    summary: s.summary,
    reason: s.reason,
    revision: s.revision,
    hasFile: Boolean(s.file),
    milestoneCount: s.file ? s.file.milestones.length : null,
    edgeCount: s.file ? s.file.edges.length : null,
  };
}

export const ARCHIVE_TABS = ["projects", "milestones", "project-fields", "project-items", "snapshots"] as const;
export type ArchiveTab = (typeof ARCHIVE_TABS)[number];

export function archiveTabOf(raw: unknown): ArchiveTab {
  // Older links used nodes / notes-files for the per-project lists.
  if (raw === "nodes" || raw === "notes-files" || raw === "steps") return "project-items";
  return (ARCHIVE_TABS as readonly string[]).includes(String(raw)) ? (raw as ArchiveTab) : "projects";
}
