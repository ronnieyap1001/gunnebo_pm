"use server";

/**
 * Milestone Library and Project fields writes. Every action: sign-in check + context (runAction) → zod-parse the
 * input → service → cache tag refresh ('library' or 'project-fields') → plain-English ActionResult.
 * The opId comes from the browser; a retry with the same opId is safe (services are idempotent per opId).
 */
import { z } from "zod";
import { FIELD_TYPES, STATES } from "@/domain/types";
import type { ActionResult } from "@/lib/action-result";
import { runAction } from "@/server/actions/run";
import { TAGS } from "@/server/queries/tags";
import { AppError } from "@/server/services/context";
import {
  applyChoicesTo,
  archiveMilestone,
  createMilestone,
  reorderMilestone,
  restoreBatch,
  updateMilestone,
} from "@/server/services/library";
import {
  archiveProjectField,
  createProjectField,
  restoreProjectField,
  updateProjectField,
} from "@/server/services/projectFields";

// ---------------------------------------------------------------------------
// Input shapes (lengths are checked again by the services, with friendlier messages)
// ---------------------------------------------------------------------------

const Id = z.string().min(1).max(200);
const FieldTypeSchema = z.enum(FIELD_TYPES);
const ChoiceSchema = z.object({
  id: z.string().max(200).optional(),
  label: z.string().max(2000),
  state: z.enum(STATES).optional(),
  archived: z.boolean().optional(),
});
const Choices = z.array(ChoiceSchema).max(200);
const ConfigSchema = z.object({ unit: z.string().max(200).optional() });

const NewMilestone = z.object({ name: z.string().max(2000), fieldType: FieldTypeSchema });
const MilestonePatchSchema = z.object({
  name: z.string().max(2000).optional(),
  description: z.string().max(10_000).optional(),
  fieldType: FieldTypeSchema.optional(),
  choices: Choices.optional(),
  config: ConfigSchema.optional(),
});
const Where = z.object({ beforeId: Id.optional(), afterId: Id.optional() });

const NewField = z.object({ label: z.string().max(2000), fieldType: FieldTypeSchema });
const FieldPatchSchema = z.object({
  label: z.string().max(2000).optional(),
  fieldType: FieldTypeSchema.optional(),
  choices: Choices.optional(),
  config: ConfigSchema.optional(),
  showInSummary: z.boolean().optional(),
  order: z.number().optional(),
});

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input);
  if (!r.success) throw new AppError("VALIDATION", "Some of the details sent weren't valid. Reload the page and try again.");
  return r.data;
}

const LIBRARY = { tags: [TAGS.library] };
const FIELDS = { tags: [TAGS.projectFields] };

// ---------------------------------------------------------------------------
// Milestones
// ---------------------------------------------------------------------------

export async function createMilestoneAction(opId: string, input: unknown): Promise<ActionResult<{ id: string; name: string }>> {
  return runAction(
    opId,
    async (ctx) => {
      const data = parse(NewMilestone, input);
      const m = await createMilestone(ctx, { name: data.name, fieldType: data.fieldType });
      return { id: m.id, name: m.name };
    },
    LIBRARY,
  );
}

export async function updateMilestoneAction(opId: string, id: unknown, patch: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(
    opId,
    async (ctx) => {
      const m = await updateMilestone(ctx, parse(Id, id), parse(MilestonePatchSchema, patch));
      return { id: m.id };
    },
    LIBRARY,
  );
}

export async function applyChoicesToAction(
  opId: string,
  sourceId: unknown,
  targetIds: unknown,
): Promise<ActionResult<{ updatedIds: string[] }>> {
  return runAction(opId, (ctx) => applyChoicesTo(ctx, parse(Id, sourceId), parse(z.array(Id).max(100), targetIds)), LIBRARY);
}

export async function reorderMilestoneAction(
  opId: string,
  id: unknown,
  where: unknown,
): Promise<ActionResult<{ effective: boolean }>> {
  return runAction(
    opId,
    async (ctx) => {
      const r = await reorderMilestone(ctx, parse(Id, id), parse(Where, where));
      return { effective: r.effective };
    },
    LIBRARY,
  );
}

export async function archiveMilestoneAction(
  opId: string,
  id: unknown,
): Promise<ActionResult<{ batchId: string; arrowsRemoved: number; bridges: number }>> {
  return runAction(
    opId,
    async (ctx) => {
      const r = await archiveMilestone(ctx, parse(Id, id), { reconnect: true });
      return { batchId: r.batchId, arrowsRemoved: r.archivedEdgeIds.length, bridges: r.bridgeEdgeIds.length };
    },
    LIBRARY,
  );
}

export async function restoreBatchAction(
  opId: string,
  batchId: unknown,
): Promise<ActionResult<{ restoredIds: string[]; skippedEdgeIds: string[] }>> {
  return runAction(
    opId,
    async (ctx) => {
      const r = await restoreBatch(ctx, parse(Id, batchId));
      return { restoredIds: r.restoredIds, skippedEdgeIds: r.skippedEdgeIds };
    },
    LIBRARY,
  );
}

// ---------------------------------------------------------------------------
// Project fields
// ---------------------------------------------------------------------------

export async function createProjectFieldAction(opId: string, input: unknown): Promise<ActionResult<{ id: string; label: string }>> {
  return runAction(
    opId,
    async (ctx) => {
      const data = parse(NewField, input);
      const f = await createProjectField(ctx, { label: data.label, fieldType: data.fieldType });
      return { id: f.id, label: f.label };
    },
    FIELDS,
  );
}

export async function updateProjectFieldAction(
  opId: string,
  id: unknown,
  patch: unknown,
): Promise<ActionResult<{ id: string; mirrorsNote?: string }>> {
  return runAction(
    opId,
    async (ctx) => {
      const f = await updateProjectField(ctx, parse(Id, id), parse(FieldPatchSchema, patch));
      return f.mirrorsNote ? { id: f.id, mirrorsNote: f.mirrorsNote } : { id: f.id };
    },
    FIELDS,
  );
}

export async function archiveProjectFieldAction(
  opId: string,
  id: unknown,
): Promise<ActionResult<{ id: string; mirrorsNote?: string }>> {
  return runAction(
    opId,
    async (ctx) => {
      const fieldId = parse(Id, id);
      const r = await archiveProjectField(ctx, fieldId);
      return r.mirrorsNote ? { id: fieldId, mirrorsNote: r.mirrorsNote } : { id: fieldId };
    },
    FIELDS,
  );
}

export async function restoreProjectFieldAction(
  opId: string,
  id: unknown,
): Promise<ActionResult<{ id: string; mirrorsNote?: string }>> {
  return runAction(
    opId,
    async (ctx) => {
      const fieldId = parse(Id, id);
      const r = await restoreProjectField(ctx, fieldId);
      return r.mirrorsNote ? { id: fieldId, mirrorsNote: r.mirrorsNote } : { id: fieldId };
    },
    FIELDS,
  );
}
