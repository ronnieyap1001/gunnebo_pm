import "server-only";
/**
 * Archive page: archived projects, milestones and project fields; for one chosen project also its archived
 * project-only steps, notes and attachments (reading every project's steps would cost one query per project).
 */
import type { ProjectStatus } from "@/domain/types";
import type { Repo } from "@/server/repo/types";
import { attachmentDTO, noteDTO, projectFieldsOf, templateOf, type AttachmentDTO, type NoteDTO, type ReadDeps } from "./common";

export interface ArchiveData {
  projects: { id: string; code: string; name: string; status: ProjectStatus; archivedAt: string | null }[];
  milestones: { id: string; key: string; name: string; archivedAt: string | null; archiveBatch: string | null }[];
  projectFields: { id: string; key: string; label: string; archivedAt: string | null }[];
  /** Present when `projectId` was given. */
  project: {
    id: string;
    code: string;
    name: string;
    steps: { id: string; name: string; archivedAt: string | null; archiveBatch: string | null }[];
    notes: NoteDTO[];
    attachments: AttachmentDTO[];
  } | null;
  /** Projects to pick from for the per-project tabs (non-archived first). */
  projectChoices: { id: string; code: string; name: string; archived: boolean }[];
}

const newestArchived = <T extends { archivedAt: string | null }>(a: T, b: T) =>
  (a.archivedAt ?? "") < (b.archivedAt ?? "") ? 1 : (a.archivedAt ?? "") > (b.archivedAt ?? "") ? -1 : 0;

export async function getArchiveData(repo: Repo, opts: { projectId?: string } = {}, deps?: ReadDeps): Promise<ArchiveData> {
  const [projects, template, fields] = await Promise.all([
    repo.projects.list({ includeArchived: true }),
    templateOf(repo, deps),
    projectFieldsOf(repo, deps),
  ]);
  let project: ArchiveData["project"] = null;
  const chosen = opts.projectId ? projects.find((p) => p.id === opts.projectId) : undefined;
  if (chosen) {
    const [steps, notes, attachments] = await Promise.all([
      repo.steps.listByProject(chosen.id, { includeArchived: true }),
      repo.notes.listByProject(chosen.id, { includeArchived: true }),
      repo.attachments.listByProject(chosen.id, { includeArchived: true }),
    ]);
    project = {
      id: chosen.id,
      code: chosen.code,
      name: chosen.name,
      steps: steps
        .filter((s) => s.archived)
        .map((s) => ({ id: s.id, name: s.name, archivedAt: s.archivedAt ?? null, archiveBatch: s.archiveBatch ?? null }))
        .sort(newestArchived),
      notes: notes.filter((n) => n.archived).map(noteDTO),
      attachments: attachments.filter((a) => a.archived).map(attachmentDTO),
    };
  }
  return {
    projects: projects
      .filter((p) => p.archived)
      .map((p) => ({ id: p.id, code: p.code, name: p.name, status: p.status, archivedAt: p.archivedAt ?? null }))
      .sort(newestArchived),
    milestones: template.milestones
      .filter((m) => m.archived)
      .map((m) => ({ id: m.id, key: m.key, name: m.name, archivedAt: m.archivedAt ?? null, archiveBatch: m.archiveBatch ?? null }))
      .sort(newestArchived),
    projectFields: fields
      .filter((f) => f.archived)
      .map((f) => ({ id: f.id, key: f.key, label: f.label, archivedAt: f.archivedAt ?? null }))
      .sort(newestArchived),
    project,
    projectChoices: projects
      .map((p) => ({ id: p.id, code: p.code, name: p.name, archived: p.archived }))
      .sort((a, b) => Number(a.archived) - Number(b.archived) || a.code.localeCompare(b.code, "en", { numeric: true })),
  };
}
