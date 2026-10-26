"use server";

/**
 * Template Flow writes. Every action: sign-in check + context (runAction) → zod-parse the input → service → cache tag
 * refresh ('library', which covers milestones, the template flow and its revision) → plain-English ActionResult.
 * The opId comes from the browser; a retry with the same opId is safe (services are idempotent per opId).
 */
import { updateTag } from "next/cache";
import { z } from "zod";
import type { ImportPlan } from "@/domain/importPlan";
import { FIELD_TYPES, STATES, type Position } from "@/domain/types";
import { fail, type ActionResult } from "@/lib/action-result";
import { runAction, runQuery } from "@/server/actions/run";
import { TAGS } from "@/server/queries/tags";
import { getRepo } from "@/server/repo";
import { AppError } from "@/server/services/context";
import { isDriverId, progressOf, type JobStepResult } from "@/server/services/jobs";
import {
  addTemplateEdge,
  applyChoicesTo,
  archiveMilestone,
  archiveTemplateEdge,
  createMilestone,
  layoutTemplate,
  moveTemplateNodes,
  restoreBatch,
  updateMilestone,
} from "@/server/services/library";
import { continueSync, listSyncTargets, startSyncDefaults, type SyncTarget } from "@/server/services/sync";
import { continueImport, previewImport, startImport } from "@/server/services/templateIo";

export type ImportSummary = ImportPlan["summary"];

// ---------------------------------------------------------------------------
// Input shapes (lengths are checked again by the services, with friendlier messages)
// ---------------------------------------------------------------------------

const Id = z.string().min(1).max(200);
const JobId = z.string().min(8).max(64);
const FieldTypeSchema = z.enum(FIELD_TYPES);
const PositionSchema = z.object({ x: z.number(), y: z.number() });
const ChoiceSchema = z.object({
  id: z.string().max(200).optional(),
  label: z.string().max(2000),
  state: z.enum(STATES).optional(),
  archived: z.boolean().optional(),
});
const MilestonePatchSchema = z.object({
  name: z.string().max(2000).optional(),
  description: z.string().max(10_000).optional(),
  fieldType: FieldTypeSchema.optional(),
  choices: z.array(ChoiceSchema).max(200).optional(),
  config: z.object({ unit: z.string().max(200).optional() }).optional(),
});
const NewMilestone = z.object({
  name: z.string().max(2000),
  fieldType: FieldTypeSchema,
  afterMilestoneId: Id.optional(),
  position: PositionSchema.optional(),
});
const Positions = z.record(Id, PositionSchema).refine((p) => Object.keys(p).length <= 2000, "Too many nodes at once.");
const LayoutSchema = z.object({ wrap: z.boolean(), viewportWidth: z.number().optional() });

/** The browser checks 1 MB first; this is the same limit on the server (bytes of the JSON text). */
const MAX_IMPORT_BYTES = 1024 * 1024;
const ImportText = z.string().min(1).max(MAX_IMPORT_BYTES);

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input);
  if (!r.success) throw new AppError("VALIDATION", "Some of the details sent weren't valid. Reload the page and try again.");
  return r.data;
}

function importText(input: unknown): string {
  const text = parse(ImportText, input);
  if (Buffer.byteLength(text, "utf8") > MAX_IMPORT_BYTES) {
    throw new AppError("VALIDATION", "This file is larger than 1 MB, so it can't be a Gunnebo PM template file.");
  }
  return text;
}

const LIBRARY = { tags: [TAGS.library] };

// ---------------------------------------------------------------------------
// Milestones
// ---------------------------------------------------------------------------

export async function createMilestoneAction(opId: string, input: unknown): Promise<ActionResult<{ id: string; name: string }>> {
  return runAction(
    opId,
    async (ctx) => {
      const data = parse(NewMilestone, input);
      const m = await createMilestone(ctx, {
        name: data.name,
        fieldType: data.fieldType,
        afterMilestoneId: data.afterMilestoneId,
        position: data.position ? { x: Math.round(data.position.x), y: Math.round(data.position.y) } : undefined,
      });
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

export async function archiveMilestoneAction(
  opId: string,
  id: unknown,
  opts: unknown,
): Promise<ActionResult<{ batchId: string; archivedEdgeIds: string[]; bridgeEdgeIds: string[] }>> {
  return runAction(
    opId,
    (ctx) => archiveMilestone(ctx, parse(Id, id), { reconnect: parse(z.object({ reconnect: z.boolean() }), opts).reconnect }),
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
// Flow: positions, arrows, auto-layout
// ---------------------------------------------------------------------------

export async function moveTemplateNodesAction(opId: string, positions: unknown): Promise<ActionResult<{ moved: number }>> {
  return runAction(
    opId,
    async (ctx) => {
      const p = parse(Positions, positions);
      await moveTemplateNodes(ctx, p);
      return { moved: Object.keys(p).length };
    },
    LIBRARY,
  );
}

export async function addTemplateEdgeAction(
  opId: string,
  from: unknown,
  to: unknown,
): Promise<ActionResult<{ id: string; from: string; to: string }>> {
  return runAction(
    opId,
    async (ctx) => {
      const e = await addTemplateEdge(ctx, parse(Id, from), parse(Id, to));
      return { id: e.id, from: e.from, to: e.to };
    },
    LIBRARY,
  );
}

export async function archiveTemplateEdgeAction(opId: string, edgeId: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(
    opId,
    async (ctx) => {
      const id = parse(Id, edgeId);
      await archiveTemplateEdge(ctx, id);
      return { id };
    },
    LIBRARY,
  );
}

export async function layoutTemplateAction(opId: string, opts: unknown): Promise<ActionResult<{ nodes: Record<string, Position> }>> {
  return runAction(
    opId,
    async (ctx) => {
      const o = parse(LayoutSchema, opts);
      const flow = await layoutTemplate(ctx, { wrap: o.wrap, viewportWidth: o.viewportWidth });
      return { nodes: flow.nodes };
    },
    LIBRARY,
  );
}

// ---------------------------------------------------------------------------
// Import (preview, then a resumable job)
// ---------------------------------------------------------------------------

/** What importing this file would change. Read-only; VALIDATION with details.errors when the file has problems. */
export async function previewImportAction(opId: string, text: unknown): Promise<ActionResult<ImportSummary>> {
  return runAction(opId, (ctx) => previewImport(ctx, importText(text), { reason: "import" }));
}

/** Saves a snapshot of the current template, plans the import and stores it as job `opId`. */
export async function startImportAction(opId: string, text: unknown): Promise<ActionResult<{ total: number; summary: ImportSummary }>> {
  return runAction(opId, (ctx) => startImport(ctx, importText(text), { reason: "import" }));
}

/**
 * Next batch of the import job. The cached library and project fields are refreshed only when the job is done, so
 * the page never re-renders a half-imported template.
 */
export async function continueImportAction(opId: string, driver?: string): Promise<ActionResult<JobStepResult>> {
  if (!JobId.safeParse(opId).success) return fail("This task is missing its id. Reload the page and try again.", "VALIDATION");
  if (!isDriverId(driver)) return fail("This task's window id is not valid. Reload the page and try again.", "VALIDATION");
  return runAction(opId, async (ctx) => {
    const r = await continueImport(ctx, opId, { driver: driver ?? undefined });
    if (r.done) {
      updateTag(TAGS.library);
      updateTag(TAGS.projectFields);
    }
    return r;
  });
}

// ---------------------------------------------------------------------------
// Sync all active projects (the browser drives one project at a time)
// ---------------------------------------------------------------------------

export async function listSyncTargetsAction(): Promise<ActionResult<SyncTarget[]>> {
  return runQuery(() => listSyncTargets(getRepo()));
}

/** Starts a sync of the default-ticked items for one project (job `opId`). */
export async function startSyncDefaultsAction(
  opId: string,
  projectId: unknown,
): Promise<ActionResult<{ total: number; itemCount: number }>> {
  return runAction(opId, (ctx) => startSyncDefaults(ctx, parse(Id, projectId)));
}

export async function continueSyncAction(opId: string, driver?: string): Promise<ActionResult<JobStepResult & { projectId: string }>> {
  if (!JobId.safeParse(opId).success) return fail("This task is missing its id. Reload the page and try again.", "VALIDATION");
  if (!isDriverId(driver)) return fail("This task's window id is not valid. Reload the page and try again.", "VALIDATION");
  return runAction(opId, async (ctx) => {
    const r = await continueSync(ctx, opId, { driver: driver ?? undefined });
    return { ...progressOf(r), projectId: r.projectId };
  });
}
