"use server";

import { z } from "zod";
import { fail, type ActionResult } from "@/lib/action-result";
import { runAction, runQuery } from "@/server/actions/run";
import { getArchiveData, getTemplateSnapshots, TAGS } from "@/server/queries";
import {
  restoreAttachment,
  restoreMilestone,
  restoreNote,
  restoreProject,
  restoreProjectBatch,
  restoreProjectField,
} from "@/server/services";
import { toArchiveProject, toSnapshotRow, type ArchiveProjectView, type SnapshotRow } from "@/components/admin/archive-types";
import { stepNamesFor } from "./step-names";

const id = z.string().min(1).max(100);
const bad = () => fail("This item could not be identified. Reload the page and try again.", "VALIDATION");

export async function restoreProjectAction(opId: string, projectId: string): Promise<ActionResult<{ id: string; code: string }>> {
  if (!id.safeParse(projectId).success) return bad();
  return runAction(opId, async (ctx) => {
    const p = await restoreProject(ctx, projectId);
    return { id: p.id, code: p.code };
  });
}

export async function restoreMilestoneAction(opId: string, milestoneId: string): Promise<ActionResult<{ restoredIds: string[]; skippedEdgeIds: string[] }>> {
  if (!id.safeParse(milestoneId).success) return bad();
  return runAction(opId, (ctx) => restoreMilestone(ctx, milestoneId), { tags: [TAGS.library] });
}

export async function restoreProjectFieldAction(opId: string, fieldId: string): Promise<ActionResult<null>> {
  if (!id.safeParse(fieldId).success) return bad();
  return runAction(
    opId,
    async (ctx) => {
      await restoreProjectField(ctx, fieldId);
      return null;
    },
    { tags: [TAGS.projectFields] },
  );
}

export async function restoreStepBatchAction(
  opId: string,
  projectId: string,
  batchId: string,
): Promise<ActionResult<{ restoredIds: string[]; skippedEdgeIds: string[] }>> {
  if (!id.safeParse(projectId).success || !id.safeParse(batchId).success) return bad();
  return runAction(opId, async (ctx) => {
    const r = await restoreProjectBatch(ctx, projectId, batchId);
    return { restoredIds: r.restoredIds, skippedEdgeIds: r.skippedEdgeIds };
  });
}

export async function restoreNoteAction(opId: string, projectId: string, noteId: string): Promise<ActionResult<null>> {
  if (!id.safeParse(projectId).success || !id.safeParse(noteId).success) return bad();
  return runAction(opId, async (ctx) => {
    await restoreNote(ctx, { projectId, noteId });
    return null;
  });
}

export async function restoreAttachmentAction(opId: string, attachmentId: string): Promise<ActionResult<null>> {
  if (!id.safeParse(attachmentId).success) return bad();
  return runAction(opId, async (ctx) => {
    await restoreAttachment(ctx, attachmentId);
    return null;
  });
}

/** The chosen project's archived steps, notes, and files & links. */
export async function loadProjectItemsAction(projectId: string): Promise<ActionResult<ArchiveProjectView | null>> {
  if (!id.safeParse(projectId).success) return bad();
  return runQuery(async () => {
    const data = await getArchiveData({ projectId });
    return data.project ? toArchiveProject(data.project, await stepNamesFor(data.project)) : null;
  });
}

/** Next page of template snapshots (without the template files; those download through /api/template-snapshot/[id]). */
export async function loadSnapshotsAction(cursor: string | null): Promise<ActionResult<{ items: SnapshotRow[]; nextCursor: string | null }>> {
  const cur = z.string().max(100_000).nullable().safeParse(cursor);
  if (!cur.success) return bad();
  return runQuery(async () => {
    const page = await getTemplateSnapshots(cur.data);
    return { items: page.items.map(toSnapshotRow), nextCursor: page.nextCursor };
  });
}
