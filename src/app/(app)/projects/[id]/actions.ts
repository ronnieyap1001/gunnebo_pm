"use server";

/**
 * Project page writes and lazy reads. Every write: sign-in check + context with the browser's opId (runAction) →
 * zod-parse → service → plain-English ActionResult. Retrying with the same opId is safe (services are idempotent
 * per opId). Structural changes (steps added or archived, sync, details) answer with fresh page data so the
 * browser never has to guess derived values such as flow order or the "current" milestones.
 */
import { z } from "zod";
import { FIELD_TYPES, NODE_FLAGS, PROJECT_STATUSES, STATES, type Flow, type FlowEdge } from "@/domain/types";
import { fail, type ActionResult } from "@/lib/action-result";
import { runAction, runQuery } from "@/server/actions/run";
import {
  getProjectHistory,
  getProjectPageData,
  getStepHistory,
  TAGS,
  type AttachmentDTO,
  type HistoryPageDTO,
  type NoteDTO,
} from "@/server/queries";
import { attachmentDTO, noteDTO } from "@/server/queries/common";
import type { StoredStep } from "@/server/repo/types";
import {
  addLink,
  addNote,
  addProjectEdge,
  addProjectFieldChoice,
  addProjectStep,
  AppError,
  archiveAttachment,
  archiveNote,
  archiveProject,
  archiveProjectEdge,
  archiveProjectStep,
  bulkSetNotApplicable,
  confirmStepDate,
  continueCreateProject,
  continueSync,
  editNote,
  layoutProject,
  moveProjectNodes,
  previewSync,
  restoreAttachment,
  restoreNote,
  restoreProject,
  restoreProjectBatch,
  setStepFlag,
  setStepNotApplicable,
  setStepValue,
  startSync,
  updateProject,
  updateStepDefinition,
  type ProjectChange,
  type StepWriteResult,
  type SyncPreview,
} from "@/server/services";
import { isDriverId, progressOf, type JobStepResult } from "@/server/services/jobs";
import type { PageSnapshot, StepResult, StepWriteData } from "@/components/project/types";

// ---------------------------------------------------------------------------
// Input shapes (the services check lengths again, with friendlier messages)
// ---------------------------------------------------------------------------

const Id = z.string().min(1).max(200);
const OpId = z.string().min(8).max(64);
const Rev = z.number().int().min(0);
const PositionSchema = z.object({ x: z.number().finite(), y: z.number().finite() });
const ChoiceSchema = z.object({
  id: z.string().max(200).optional(),
  label: z.string().max(2000),
  state: z.enum(STATES).optional(),
  archived: z.boolean().optional(),
});
const ConfigSchema = z.object({ unit: z.string().max(200).optional() });

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input);
  if (!r.success) throw new AppError("VALIDATION", "Some of the input was not valid. Reload the page and try again.");
  return r.data;
}

function stepResult(s: StoredStep): StepResult {
  return {
    id: s.id,
    name: s.name,
    description: s.description ?? "",
    fieldType: s.fieldType,
    choices: s.choices ?? [],
    config: s.config ?? {},
    value: s.value ?? null,
    notApplicable: s.notApplicable,
    flag: s.flag ?? null,
    order: s.order,
    rev: s.rev,
    valueSetAt: s.valueSetAt ?? null,
    stateChangedAt: s.stateChangedAt ?? null,
    lastChangedAt: s.lastChangedAt ?? null,
  };
}

function writeData(r: StepWriteResult & { noteId?: string }): StepWriteData {
  const out: StepWriteData = {
    step: stepResult(r.step),
    changed: r.changed,
    flagCleared: r.flagCleared === true,
    suggestClose: r.suggestClose === true,
  };
  if (r.noteId) out.noteId = r.noteId;
  return out;
}

/** Fresh page data after a write; `readAt` (taken before the read) lets the browser drop older snapshots. */
async function page(projectId: string): Promise<PageSnapshot> {
  const readAt = new Date().toISOString();
  const data = await getProjectPageData(projectId);
  if (!data) throw new AppError("NOT_FOUND", "This project was not found. It may have been archived; reload the page.");
  return { data, readAt };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function loadProjectAction(projectId: string): Promise<ActionResult<PageSnapshot>> {
  return runQuery(() => page(parse(Id, projectId)));
}

export async function stepHistoryAction(stepId: string, cursor: string | null, limit?: number): Promise<ActionResult<HistoryPageDTO>> {
  return runQuery(() =>
    getStepHistory(parse(Id, stepId), cursor ? parse(z.string().max(500), cursor) : null, limit ? parse(z.number().int().min(1).max(100), limit) : undefined),
  );
}

const HistoryFiltersSchema = z.object({
  type: z.string().max(100).optional(),
  source: z.enum(["MANUAL", "EMAIL", "SYSTEM"]).optional(),
});

export async function projectHistoryAction(
  projectId: string,
  filters: { type?: string; source?: "MANUAL" | "EMAIL" | "SYSTEM" },
  cursor: string | null,
): Promise<ActionResult<HistoryPageDTO>> {
  return runQuery(() =>
    getProjectHistory(parse(Id, projectId), parse(HistoryFiltersSchema, filters ?? {}), cursor ? parse(z.string().max(500), cursor) : null, 50),
  );
}

// ---------------------------------------------------------------------------
// Step values
// ---------------------------------------------------------------------------

export async function setStepValueAction(
  opId: string,
  input: { stepId: string; value: unknown; expectedRev: number },
): Promise<ActionResult<StepWriteData>> {
  return runAction(opId, async (ctx) => {
    const i = parse(z.object({ stepId: Id, value: z.unknown(), expectedRev: Rev }), input);
    return writeData(await setStepValue(ctx, { stepId: i.stepId, value: i.value ?? null, expectedRev: i.expectedRev }));
  });
}

export async function setStepNotApplicableAction(
  opId: string,
  input: { stepId: string; notApplicable: boolean; expectedRev: number },
): Promise<ActionResult<StepWriteData>> {
  return runAction(opId, async (ctx) => {
    const i = parse(z.object({ stepId: Id, notApplicable: z.boolean(), expectedRev: Rev }), input);
    return writeData(await setStepNotApplicable(ctx, i));
  });
}

export async function setStepFlagAction(
  opId: string,
  input: { stepId: string; flag: "WAITING" | "BLOCKED" | null; reason?: string; expectedRev: number },
): Promise<ActionResult<StepWriteData>> {
  return runAction(opId, async (ctx) => {
    const i = parse(
      z.object({ stepId: Id, flag: z.enum(NODE_FLAGS).nullable(), reason: z.string().max(5000).optional(), expectedRev: Rev }),
      input,
    );
    return writeData(await setStepFlag(ctx, i));
  });
}

export async function confirmStepDateAction(opId: string, input: { stepId: string; expectedRev: number }): Promise<ActionResult<StepWriteData>> {
  return runAction(opId, async (ctx) => {
    const i = parse(z.object({ stepId: Id, expectedRev: Rev }), input);
    return writeData(await confirmStepDate(ctx, i.stepId, i.expectedRev));
  });
}

/** One chunk (at most 16 steps; the browser splits bigger selections, one opId per chunk). */
export async function bulkNotApplicableAction(
  opId: string,
  input: { projectId: string; stepIds: string[]; notApplicable: boolean },
): Promise<ActionResult<{ changedIds: string[] }>> {
  return runAction(opId, async (ctx) => {
    const i = parse(z.object({ projectId: Id, stepIds: z.array(Id).min(1).max(16), notApplicable: z.boolean() }), input);
    const r = await bulkSetNotApplicable(ctx, i);
    return { changedIds: r.changedIds };
  });
}

// ---------------------------------------------------------------------------
// Project-only steps and the project flow
// ---------------------------------------------------------------------------

export async function addProjectStepAction(
  opId: string,
  input: {
    projectId: string;
    name: string;
    fieldType: string;
    description?: string;
    choices?: { label: string; state?: string }[];
    afterStepId?: string;
    position?: { x: number; y: number };
  },
): Promise<ActionResult<{ stepId: string; page: PageSnapshot }>> {
  return runAction(opId, async (ctx) => {
    const i = parse(
      z.object({
        projectId: Id,
        name: z.string().max(2000),
        fieldType: z.enum(FIELD_TYPES),
        description: z.string().max(10_000).optional(),
        choices: z.array(ChoiceSchema).max(200).optional(),
        afterStepId: Id.optional(),
        position: PositionSchema.optional(),
      }),
      input,
    );
    const r = await addProjectStep(ctx, i);
    return { stepId: r.step.id, page: await page(i.projectId) };
  });
}

export async function updateStepDefinitionAction(
  opId: string,
  input: {
    stepId: string;
    patch: { name?: string; description?: string; fieldType?: string; choices?: unknown[]; config?: { unit?: string } };
    expectedRev: number;
    clearValue?: boolean;
  },
): Promise<ActionResult<StepWriteData>> {
  return runAction(opId, async (ctx) => {
    const i = parse(
      z.object({
        stepId: Id,
        patch: z.object({
          name: z.string().max(2000).optional(),
          description: z.string().max(10_000).optional(),
          fieldType: z.enum(FIELD_TYPES).optional(),
          choices: z.array(ChoiceSchema).max(200).optional(),
          config: ConfigSchema.optional(),
        }),
        expectedRev: Rev,
        clearValue: z.boolean().optional(),
      }),
      input,
    );
    return writeData(await updateStepDefinition(ctx, i.stepId, i.patch, { expectedRev: i.expectedRev, clearValue: i.clearValue }));
  });
}

export async function archiveProjectStepAction(
  opId: string,
  input: { projectId: string; stepId: string },
): Promise<ActionResult<{ batchId: string; page: PageSnapshot }>> {
  return runAction(opId, async (ctx) => {
    const i = parse(z.object({ projectId: Id, stepId: Id }), input);
    const r = await archiveProjectStep(ctx, i.stepId, { reconnect: true });
    return { batchId: r.batchId, page: await page(i.projectId) };
  });
}

export async function restoreProjectBatchAction(
  opId: string,
  input: { projectId: string; batchId: string },
): Promise<ActionResult<{ restoredIds: string[]; skippedEdgeIds: string[]; page: PageSnapshot }>> {
  return runAction(opId, async (ctx) => {
    const i = parse(z.object({ projectId: Id, batchId: z.string().min(1).max(200) }), input);
    const r = await restoreProjectBatch(ctx, i.projectId, i.batchId);
    return { restoredIds: r.restoredIds, skippedEdgeIds: r.skippedEdgeIds, page: await page(i.projectId) };
  });
}

export async function moveNodesAction(
  opId: string,
  input: { projectId: string; positions: Record<string, { x: number; y: number }> },
): Promise<ActionResult<undefined>> {
  return runAction(opId, async (ctx) => {
    const i = parse(z.object({ projectId: Id, positions: z.record(Id, PositionSchema) }), input);
    await moveProjectNodes(ctx, i.projectId, i.positions);
    return undefined;
  });
}

export async function addEdgeAction(opId: string, input: { projectId: string; from: string; to: string }): Promise<ActionResult<FlowEdge>> {
  return runAction(opId, async (ctx) => {
    const i = parse(z.object({ projectId: Id, from: Id, to: Id }), input);
    return addProjectEdge(ctx, i.projectId, i.from, i.to);
  });
}

export async function archiveEdgeAction(opId: string, input: { projectId: string; edgeId: string }): Promise<ActionResult<undefined>> {
  return runAction(opId, async (ctx) => {
    const i = parse(z.object({ projectId: Id, edgeId: Id }), input);
    await archiveProjectEdge(ctx, i.projectId, i.edgeId);
    return undefined;
  });
}

export async function layoutAction(
  opId: string,
  input: { projectId: string; viewportWidth?: number },
): Promise<ActionResult<Flow["nodes"]>> {
  return runAction(opId, async (ctx) => {
    const i = parse(z.object({ projectId: Id, viewportWidth: z.number().finite().optional() }), input);
    const flow = await layoutProject(ctx, i.projectId, { wrap: true, viewportWidth: i.viewportWidth });
    return flow.nodes;
  });
}

// ---------------------------------------------------------------------------
// Notes, links
// ---------------------------------------------------------------------------

export async function addNoteAction(opId: string, input: { projectId: string; stepId?: string; body: string }): Promise<ActionResult<NoteDTO>> {
  return runAction(opId, async (ctx) => {
    const i = parse(z.object({ projectId: Id, stepId: Id.optional(), body: z.string().max(20_000) }), input);
    return noteDTO(await addNote(ctx, i));
  });
}

export async function editNoteAction(opId: string, input: { projectId: string; noteId: string; body: string }): Promise<ActionResult<NoteDTO>> {
  return runAction(opId, async (ctx) => {
    const i = parse(z.object({ projectId: Id, noteId: Id, body: z.string().max(20_000) }), input);
    return noteDTO(await editNote(ctx, i));
  });
}

export async function archiveNoteAction(opId: string, input: { projectId: string; noteId: string }): Promise<ActionResult<NoteDTO>> {
  return runAction(opId, async (ctx) => noteDTO(await archiveNote(ctx, parse(z.object({ projectId: Id, noteId: Id }), input))));
}

export async function restoreNoteAction(opId: string, input: { projectId: string; noteId: string }): Promise<ActionResult<NoteDTO>> {
  return runAction(opId, async (ctx) => noteDTO(await restoreNote(ctx, parse(z.object({ projectId: Id, noteId: Id }), input))));
}

export async function addLinkAction(
  opId: string,
  input: { projectId: string; stepId?: string; name?: string; url: string },
): Promise<ActionResult<AttachmentDTO>> {
  return runAction(opId, async (ctx) => {
    const i = parse(z.object({ projectId: Id, stepId: Id.optional(), name: z.string().max(2000).optional(), url: z.string().max(4000) }), input);
    return attachmentDTO((await addLink(ctx, i)).attachment);
  });
}

export async function archiveAttachmentAction(opId: string, id: string): Promise<ActionResult<AttachmentDTO>> {
  return runAction(opId, async (ctx) => attachmentDTO((await archiveAttachment(ctx, parse(Id, id))).attachment));
}

export async function restoreAttachmentAction(opId: string, id: string): Promise<ActionResult<AttachmentDTO>> {
  return runAction(opId, async (ctx) => attachmentDTO((await restoreAttachment(ctx, parse(Id, id))).attachment));
}

// ---------------------------------------------------------------------------
// Project details, archive
// ---------------------------------------------------------------------------

export async function updateProjectAction(
  opId: string,
  input: { projectId: string; code?: string; name?: string; status?: string; details?: Record<string, unknown> },
): Promise<ActionResult<{ changes: ProjectChange[]; page: PageSnapshot }>> {
  return runAction(opId, async (ctx) => {
    const i = parse(
      z.object({
        projectId: Id,
        code: z.string().max(100).optional(),
        name: z.string().max(2000).optional(),
        status: z.enum(PROJECT_STATUSES).optional(),
        details: z.record(Id, z.unknown()).optional(),
      }),
      input,
    );
    const { projectId, ...patch } = i;
    const r = await updateProject(ctx, projectId, patch);
    return { changes: r.changes, page: await page(projectId) };
  });
}

/** "Add 'X'" in a Dropdown / Multiple detail field. */
export async function addDetailChoiceAction(opId: string, input: { fieldId: string; label: string }): Promise<ActionResult<{ choiceId: string }>> {
  return runAction(
    opId,
    async (ctx) => {
      const i = parse(z.object({ fieldId: Id, label: z.string().min(1).max(500) }), input);
      const r = await addProjectFieldChoice(ctx, i.fieldId, i.label);
      return { choiceId: r.choiceId };
    },
    { tags: [TAGS.projectFields] },
  );
}

export async function archiveProjectAction(opId: string, projectId: string): Promise<ActionResult<{ code: string }>> {
  return runAction(opId, async (ctx) => ({ code: (await archiveProject(ctx, parse(Id, projectId))).code }));
}

export async function restoreProjectAction(opId: string, projectId: string): Promise<ActionResult<{ code: string }>> {
  return runAction(opId, async (ctx) => ({ code: (await restoreProject(ctx, parse(Id, projectId))).code }));
}

// ---------------------------------------------------------------------------
// Sync from template, project setup
// ---------------------------------------------------------------------------

export async function previewSyncAction(opId: string, projectId: string): Promise<ActionResult<SyncPreview>> {
  return runAction(opId, (ctx) => previewSync(ctx, parse(Id, projectId)));
}

export async function startSyncAction(opId: string, input: { projectId: string; selectedIds: string[] }): Promise<ActionResult<{ total: number }>> {
  return runAction(opId, async (ctx) => {
    const i = parse(z.object({ projectId: Id, selectedIds: z.array(z.string().max(500)).max(2000) }), input);
    return startSync(ctx, { projectId: i.projectId, selectedIds: i.selectedIds });
  });
}

/** Next batch of a sync. `driver`: the browser run (runJob); RUNNING_ELSEWHERE while another tab or window runs it. */
export async function continueSyncAction(opId: string, driver?: string): Promise<ActionResult<JobStepResult & { appliedItemIds?: string[] }>> {
  if (!isDriverId(driver)) return fail("This task's window id is not valid. Reload the page and try again.", "VALIDATION");
  return runAction(opId, async (ctx) => {
    const r = await continueSync(ctx, parse(OpId, opId), { driver: driver ?? undefined });
    return { ...progressOf(r), appliedItemIds: r.appliedItemIds };
  });
}

/** Finishes copying the template into a project whose setup was interrupted (or waits while another tab copies it). */
export async function continueCreateAction(opId: string, driver?: string): Promise<ActionResult<JobStepResult>> {
  if (!isDriverId(driver)) return fail("This task's window id is not valid. Reload the page and try again.", "VALIDATION");
  return runAction(opId, async (ctx) => progressOf(await continueCreateProject(ctx, parse(OpId, opId), { driver: driver ?? undefined })));
}
