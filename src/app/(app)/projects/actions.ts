"use server";

/**
 * Projects list and New project. Writes go through runAction (sign-in check, context with the browser's opId,
 * plain-English ActionResult); read-only lazy loads through runQuery. A retry with the same opId is safe.
 */
import { z } from "zod";
import { PROJECT_STATUSES, type Choice, type ProjectStatus, type State } from "@/domain/types";
import { fail, type ActionResult } from "@/lib/action-result";
import { runAction, runQuery } from "@/server/actions/run";
import { getProjectPageData, getProjectsList } from "@/server/queries";
import { TAGS } from "@/server/queries/tags";
import { getRepo } from "@/server/repo";
import { listOpenJobs, loadJob } from "@/server/services/jobs";
import { addProjectFieldChoice } from "@/server/services/projectFields";
import { continueCreateProject, startCreateProject, type CreateProgress, type CreateProjectJob } from "@/server/services/projects";

const Id = z.string().min(1).max(200);

const NewProjectSchema = z.object({
  code: z.string().max(100),
  name: z.string().max(2000),
  status: z.enum(PROJECT_STATUSES).optional(),
  details: z.record(z.string().max(200), z.unknown()).optional(),
});

function invalid(): ActionResult<never> {
  return fail("Some of the details sent weren't valid. Reload the page and try again.", "VALIDATION");
}

// ---------------------------------------------------------------------------
// New project (resumable job)
// ---------------------------------------------------------------------------

export async function startCreateProjectAction(opId: string, input: unknown): Promise<ActionResult<{ projectId: string; total: number }>> {
  const parsed = NewProjectSchema.safeParse(input);
  if (!parsed.success) return invalid();
  return runAction(opId, (ctx) => startCreateProject(ctx, parsed.data));
}

/** One batch of the copy (up to 8 milestones). Call until `done`. */
export async function continueCreateProjectAction(opId: string): Promise<ActionResult<CreateProgress>> {
  return runAction(opId, (ctx) => continueCreateProject(ctx, opId));
}

/** "Add 'X'" in a Dropdown or Multiple field of the New project form. Returns the new choice and the full list. */
export async function addProjectFieldChoiceAction(
  opId: string,
  fieldId: string,
  label: string,
): Promise<ActionResult<{ choiceId: string; choices: Choice[] }>> {
  if (!Id.safeParse(fieldId).success || typeof label !== "string" || label.length > 2000) return invalid();
  return runAction(
    opId,
    async (ctx) => {
      const r = await addProjectFieldChoice(ctx, fieldId, label);
      return { choiceId: r.choiceId, choices: r.field.choices ?? [] };
    },
    { tags: [TAGS.projectFields] },
  );
}

export interface CreateJobDTO {
  opId: string;
  projectId: string | null;
  code: string;
  name: string;
  doneCount: number;
  total: number;
  createdAt: string;
}

/** Project creations that stopped part-way (browser closed, network lost), for the "Resume creating …" banner. */
export async function listCreateJobsAction(): Promise<ActionResult<CreateJobDTO[]>> {
  return runQuery(async () => {
    const repo = getRepo();
    const jobs = (await listOpenJobs(repo)).filter((j) => j.kind === "createProject");
    const out: CreateJobDTO[] = [];
    for (const j of jobs.slice(0, 20)) {
      const job = await loadJob<CreateProjectJob>(repo, j.opId);
      if (!job || job.kind !== "createProject" || job.status !== "running") continue;
      out.push({
        opId: j.opId,
        projectId: j.projectId ?? null,
        code: job.code,
        name: job.name,
        doneCount: j.doneCount,
        total: j.total,
        createdAt: j.createdAt,
      });
    }
    return out;
  });
}

// ---------------------------------------------------------------------------
// Command palette
// ---------------------------------------------------------------------------

export interface PaletteProject {
  id: string;
  code: string;
  name: string;
  customer: string | null;
  status: ProjectStatus;
  statusLabel: string;
}

/** Compact project list for the command palette (non-archived, sorted by code). */
export async function paletteProjectsAction(): Promise<ActionResult<PaletteProject[]>> {
  return runQuery(async () => {
    const rows = await getProjectsList();
    return rows.map((r) => ({
      id: r.id,
      code: r.code,
      name: r.name,
      customer: r.customer,
      status: r.status,
      statusLabel: r.statusLabel,
    }));
  });
}

export interface PaletteStep {
  id: string;
  seq: number;
  name: string;
  state: State;
  value: string;
  isCurrent: boolean;
}

/** Milestones of the project that is open, for the command palette. */
export async function paletteStepsAction(projectId: string): Promise<ActionResult<{ code: string; steps: PaletteStep[] } | null>> {
  if (!Id.safeParse(projectId).success) return invalid();
  return runQuery(async () => {
    const data = await getProjectPageData(projectId);
    if (!data) return null;
    return {
      code: data.project.code,
      steps: data.steps.map((s) => ({
        id: s.id,
        seq: s.seq,
        name: s.name,
        state: s.state,
        value: s.shortDisplay,
        isCurrent: s.isCurrent,
      })),
    };
  });
}
