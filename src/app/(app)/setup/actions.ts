"use server";

import { updateTag } from "next/cache";
import { z } from "zod";
import { fail, type ActionResult } from "@/lib/action-result";
import { runAction, runQuery } from "@/server/actions/run";
import { TAGS, type SetupStatusDTO } from "@/server/queries";
import { getStorageAdmin } from "@/server/repo";
import { isDriverId, progressOf } from "@/server/services/jobs";
import { readSetupStatus } from "./status";
import { continueCreateProject, continueImport, continueSync, startSeed, type JobStepResult } from "@/server/services";

/** Data the seed and imports change (refreshed after every batch). */
const DATA_TAGS = [TAGS.library, TAGS.projectFields, TAGS.settings];
/** Everything, the shared Notion schema registry included ("Check again", end of the Notion setup). */
const ALL_TAGS = [...DATA_TAGS, TAGS.schema];
const id = z.string().min(8).max(64);

function refreshAllTags() {
  for (const tag of ALL_TAGS) updateTag(tag);
}

/** "Check again": forgets what this server instance remembered about Notion, then reads the status afresh. */
export async function checkSetupAction(): Promise<ActionResult<SetupStatusDTO>> {
  return runQuery(async () => {
    try {
      await getStorageAdmin().resetCaches();
    } catch {
      // No Notion connection yet (NOTION_TOKEN missing): nothing is cached, the status below explains it.
    }
    refreshAllTags();
    return readSetupStatus();
  });
}

/**
 * One piece of Notion setup (one database, or one tidy-up such as locking layouts). The browser calls this until
 * `done`, even after the databases are usable, so the small fixes run too. Idempotent.
 */
export async function runSchemaStepAction(): Promise<ActionResult<{ done: boolean; message: string }>> {
  return runQuery(async () => {
    const r = await getStorageAdmin().runSchemaStep();
    if (r.done) refreshAllTags();
    return { done: r.done, message: r.message };
  });
}

/** Starts loading the 64 seed milestones and the default project fields (a resumable import job). */
export async function startSeedAction(opId: string): Promise<ActionResult<{ total: number }>> {
  return runAction(opId, async (ctx) => {
    const r = await startSeed(ctx);
    return { total: r.total };
  }, { tags: DATA_TAGS });
}

/**
 * Next batch of an import job (seed, reset or file import). Same opId as the job; `driver` is the browser run
 * (runJob): while another tab or window runs the job, the result has code RUNNING_ELSEWHERE.
 */
export async function continueImportAction(opId: string, driver?: string): Promise<ActionResult<JobStepResult>> {
  if (!id.safeParse(opId).success) return fail("This task is missing its id. Reload the page and try again.", "VALIDATION");
  if (!isDriverId(driver)) return fail("This task's window id is not valid. Reload the page and try again.", "VALIDATION");
  return runAction(opId, (ctx) => continueImport(ctx, opId, { driver: driver ?? undefined }), { tags: DATA_TAGS });
}

/** Resumes a project creation that was interrupted (e.g. the tab was closed). */
export async function continueCreateProjectAction(opId: string, driver?: string): Promise<ActionResult<JobStepResult & { projectId: string }>> {
  if (!id.safeParse(opId).success) return fail("This task is missing its id. Reload the page and try again.", "VALIDATION");
  if (!isDriverId(driver)) return fail("This task's window id is not valid. Reload the page and try again.", "VALIDATION");
  return runAction(opId, async (ctx) => {
    const r = await continueCreateProject(ctx, opId, { driver: driver ?? undefined });
    return { ...progressOf(r), projectId: r.projectId };
  });
}

/** Resumes a "Sync from template" that was interrupted. */
export async function continueSyncAction(opId: string, driver?: string): Promise<ActionResult<JobStepResult & { projectId: string }>> {
  if (!id.safeParse(opId).success) return fail("This task is missing its id. Reload the page and try again.", "VALIDATION");
  if (!isDriverId(driver)) return fail("This task's window id is not valid. Reload the page and try again.", "VALIDATION");
  return runAction(opId, async (ctx) => {
    const r = await continueSync(ctx, opId, { driver: driver ?? undefined });
    return { ...progressOf(r), projectId: r.projectId };
  }, { tags: DATA_TAGS });
}
