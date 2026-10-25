import "server-only";
/**
 * Files (up to 4 MB, stored by the repo) and links on a project or a step. Archiving hides an attachment; nothing
 * is deleted. A step's cell carries its active attachment count, so FILE-type steps get their state from it.
 */
import { buildCell } from "@/domain/cells";
import { linkHost } from "@/domain/format";
import type { Attachment, Project } from "@/domain/types";
import { isHttpUrl, MAX_URL_LENGTH } from "@/domain/values";
import type { FileDownload, Repo } from "@/server/repo/types";
import { alreadyLogged, appendHistory, AppError, EV, MAX_NAME_LENGTH, notFound, summaryFor, type Ctx } from "./context";
import { attachmentCounts, stepState, writeMirrors, type CellsProgress } from "./mirrors";
import { requireProject } from "./projects";

/** Vercel's request cap is 4.5 MB and Notion Free's file limit 5 MiB. */
export const MAX_FILE_BYTES = 4_000_000;

export interface AttachmentWriteResult {
  attachment: Attachment;
  project: CellsProgress;
}

async function stepOf(ctx: Ctx, project: Project, stepId: string | undefined) {
  if (!stepId) return undefined;
  const step = await ctx.repo.steps.get(stepId);
  if (!step || step.projectId !== project.id) throw notFound("This milestone");
  return step;
}

function cleanName(raw: unknown, fallback: string): string {
  const name = typeof raw === "string" ? raw.trim().replace(/\s+/g, " ") : "";
  const out = name || fallback;
  return Array.from(out).slice(0, MAX_NAME_LENGTH).join("");
}

/**
 * After an attachment change: re-count the step's active attachments, replace its cell, and (for FILE steps) set
 * stateChangedAt when the state flipped.
 */
async function refreshStep(ctx: Ctx, project: Project, stepId: string | undefined): Promise<CellsProgress> {
  if (!stepId) return { progress: project.progress, cells: project.cells ?? {} };
  const [step, atts] = await Promise.all([ctx.repo.steps.get(stepId), ctx.repo.attachments.listByProject(project.id)]);
  if (!step || step.archived) return { progress: project.progress, cells: project.cells ?? {} };
  const count = attachmentCounts(atts)[stepId] ?? 0;
  const before = project.cells?.[stepId]?.fc ?? 0;
  let current = step;
  if (stepState(step, before, ctx.day).state !== stepState(step, count, ctx.day).state) {
    current = await ctx.repo.steps.update(stepId, { stateChangedAt: ctx.now, lastChangedAt: ctx.now });
  }
  const cells = { ...(project.cells ?? {}), [stepId]: buildCell(current, count) };
  return writeMirrors(ctx, project, cells);
}

function label(stepName: string | undefined): string {
  return stepName ? `on ${stepName}` : "on the project";
}

/** Adds a link (http/https only; the name defaults to the host). History `attachment.added`. */
export async function addLink(
  ctx: Ctx,
  input: { projectId: string; stepId?: string; name?: string; url: string },
): Promise<AttachmentWriteResult> {
  const url = typeof input.url === "string" ? input.url.trim() : "";
  if (!isHttpUrl(url) || url.length > MAX_URL_LENGTH) {
    throw new AppError("VALIDATION", "Enter a web address starting with http:// or https://.");
  }
  const project = await requireProject(ctx.repo, input.projectId);
  const step = await stepOf(ctx, project, input.stepId);
  const name = cleanName(input.name, linkHost(url));
  if (await alreadyLogged(ctx)) {
    const atts = await ctx.repo.attachments.listByProject(project.id);
    const same = atts.filter((a) => a.kind === "LINK" && a.url === url && (a.stepId ?? undefined) === (input.stepId ?? undefined)).pop();
    if (same) return { attachment: same, project: { progress: project.progress, cells: project.cells ?? {} } };
  }
  const attachment = await ctx.repo.attachments.createLink({
    projectId: project.id,
    ...(input.stepId ? { stepId: input.stepId } : {}),
    name,
    url,
  });
  const mirrors = await refreshStep(ctx, project, input.stepId);
  await appendHistory(ctx, {
    type: EV.attachmentAdded,
    summary: summaryFor(project.code, `Link "${name}" added ${label(step?.name)}`),
    projectId: project.id,
    stepId: input.stepId,
    milestoneKey: step?.milestoneKey,
    newDisplay: name,
    data: { attachmentId: attachment.id, kind: "LINK", name, url, stepName: step?.name, milestoneKey: step?.milestoneKey },
  });
  return { attachment, project: mirrors };
}

/** Stores an uploaded file (≤ 4 MB; called by the upload route). History `attachment.added`. */
export async function addFile(
  ctx: Ctx,
  input: { projectId: string; stepId?: string; name: string; contentType: string; size: number; data: Blob },
): Promise<AttachmentWriteResult> {
  const size = Number(input.size);
  if (!Number.isFinite(size) || size <= 0) throw new AppError("VALIDATION", "The file is empty.");
  if (size > MAX_FILE_BYTES || (input.data && input.data.size > MAX_FILE_BYTES)) {
    throw new AppError("VALIDATION", "Files can be at most 4 MB. For bigger files, add a SharePoint or OneDrive link.");
  }
  const project = await requireProject(ctx.repo, input.projectId);
  const step = await stepOf(ctx, project, input.stepId);
  const name = cleanName(input.name, "file");
  if (await alreadyLogged(ctx)) {
    const atts = await ctx.repo.attachments.listByProject(project.id);
    const same = atts.filter((a) => a.kind === "FILE" && a.name === name && (a.stepId ?? undefined) === (input.stepId ?? undefined)).pop();
    if (same) return { attachment: same, project: { progress: project.progress, cells: project.cells ?? {} } };
  }
  const attachment = await ctx.repo.attachments.createFile({
    projectId: project.id,
    ...(input.stepId ? { stepId: input.stepId } : {}),
    name,
    contentType: input.contentType || "application/octet-stream",
    size,
    data: input.data,
  });
  const mirrors = await refreshStep(ctx, project, input.stepId);
  await appendHistory(ctx, {
    type: EV.attachmentAdded,
    summary: summaryFor(project.code, `File "${name}" added ${label(step?.name)}`),
    projectId: project.id,
    stepId: input.stepId,
    milestoneKey: step?.milestoneKey,
    newDisplay: name,
    data: {
      attachmentId: attachment.id,
      kind: "FILE",
      name,
      size,
      contentType: input.contentType,
      stepName: step?.name,
      milestoneKey: step?.milestoneKey,
    },
  });
  return { attachment, project: mirrors };
}

async function requireAttachment(ctx: Ctx, id: string): Promise<Attachment> {
  const a = await ctx.repo.attachments.get(id);
  if (!a) throw notFound("This attachment");
  return a;
}

async function setArchived(ctx: Ctx, id: string, archived: boolean): Promise<AttachmentWriteResult> {
  const a = await requireAttachment(ctx, id);
  const project = await requireProject(ctx.repo, a.projectId);
  if (a.archived === archived) return { attachment: a, project: { progress: project.progress, cells: project.cells ?? {} } };
  const step = await stepOf(ctx, project, a.stepId).catch(() => undefined);
  const attachment = await ctx.repo.attachments.update(id, archived ? { archived: true, archivedAt: ctx.now } : { archived: false });
  const mirrors = await refreshStep(ctx, project, a.stepId);
  const what = a.kind === "LINK" ? "Link" : "File";
  await appendHistory(ctx, {
    type: archived ? EV.attachmentArchived : EV.attachmentRestored,
    summary: summaryFor(project.code, `${what} "${a.name}" ${archived ? "removed" : "restored"} ${label(step?.name)}`),
    projectId: project.id,
    stepId: a.stepId,
    milestoneKey: step?.milestoneKey,
    oldDisplay: archived ? a.name : undefined,
    newDisplay: archived ? undefined : a.name,
    data: { attachmentId: a.id, kind: a.kind, name: a.name, url: a.url, stepName: step?.name, milestoneKey: step?.milestoneKey },
  });
  return { attachment, project: mirrors };
}

/** Removing an attachment archives it; the file stays in storage. History `attachment.archived`. */
export function archiveAttachment(ctx: Ctx, id: string): Promise<AttachmentWriteResult> {
  return setArchived(ctx, id, true);
}

export function restoreAttachment(ctx: Ctx, id: string): Promise<AttachmentWriteResult> {
  return setArchived(ctx, id, false);
}

/** A short-lived download URL for a FILE attachment (the download route streams it; never cache it). */
export async function openAttachment(repo: Repo, id: string): Promise<FileDownload> {
  const a = await repo.attachments.get(id);
  if (!a || a.kind !== "FILE") throw notFound("This file");
  return repo.attachments.openFile(id);
}
