import "server-only";
/**
 * Shared DTO pieces and helpers for the read models. Every DTO is plain JSON (serialisable to Client Components).
 */
import type { DerivedState, StateReason } from "@/domain/state";
import { describeReason, STATE_META } from "@/domain/state";
import type { Attachment, Note, ProjectField, State, StateCode, Template } from "@/domain/types";
import type { Repo } from "@/server/repo/types";
import { getTemplate } from "@/server/services/library";
import { listProjectFields } from "@/server/services/projectFields";

/** Optional pre-loaded (cached) inputs; the pure builders read from the repo when they are missing. */
export interface ReadDeps {
  template?: Template;
  /** All project fields, archived included. */
  projectFields?: ProjectField[];
}

export function templateOf(repo: Repo, deps?: ReadDeps): Promise<Template> {
  return deps?.template ? Promise.resolve(deps.template) : getTemplate(repo);
}

export function projectFieldsOf(repo: Repo, deps?: ReadDeps): Promise<ProjectField[]> {
  return deps?.projectFields ? Promise.resolve(deps.projectFields) : listProjectFields(repo, { includeArchived: true });
}

export interface StateDTO {
  state: State;
  stateCode: StateCode;
  stateLabel: string;
  reason: StateReason;
  reasonText: string;
}

export function stateDTO(d: DerivedState): StateDTO {
  return {
    state: d.state,
    stateCode: STATE_META[d.state].code,
    stateLabel: STATE_META[d.state].label,
    reason: d.reason,
    reasonText: describeReason(d.reason),
  };
}

export interface NoteDTO {
  id: string;
  stepId: string | null;
  body: string;
  author: string;
  createdAt: string;
  editedAt: string | null;
  archived: boolean;
}

export function noteDTO(n: Note): NoteDTO {
  return {
    id: n.id,
    stepId: n.stepId ?? null,
    body: n.body,
    author: n.author,
    createdAt: n.createdAt,
    editedAt: n.editedAt ?? null,
    archived: n.archived,
  };
}

export interface AttachmentDTO {
  id: string;
  stepId: string | null;
  kind: "FILE" | "LINK";
  name: string;
  /** LINK: the URL. FILE: null (download through /api/files/[id]). */
  url: string | null;
  size: number | null;
  contentType: string | null;
  createdAt: string;
  archived: boolean;
}

export function attachmentDTO(a: Attachment): AttachmentDTO {
  return {
    id: a.id,
    stepId: a.stepId ?? null,
    kind: a.kind,
    name: a.name,
    url: a.kind === "LINK" ? (a.url ?? null) : null,
    size: a.size ?? null,
    contentType: a.contentType ?? null,
    createdAt: a.createdAt,
    archived: a.archived,
  };
}

/** Newest first. */
export function byCreatedDesc<T extends { createdAt: string }>(a: T, b: T): number {
  return a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0;
}
