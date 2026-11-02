"use server";

/**
 * Portfolio lazy loads (read-only, runQuery): the cell tooltip details and the latest note of each open item.
 */
import { z } from "zod";
import { truncate } from "@/domain/format";
import { fail, type ActionResult } from "@/lib/action-result";
import { runQuery } from "@/server/actions/run";
import { getCellDetails, type CellDetails } from "@/server/queries";
import { getRepo } from "@/server/repo";

const Id = z.string().min(1).max(200);

/** Tooltip details of one cell: value, state, last changed and the latest note. Null when the step is gone. */
export async function cellDetailsAction(stepId: string): Promise<ActionResult<CellDetails | null>> {
  if (!Id.safeParse(stepId).success) return fail("This milestone was not found.", "VALIDATION");
  return runQuery(() => getCellDetails(stepId));
}

export interface NoteSnippet {
  body: string;
  author: string;
  createdAt: string;
}

const NotesInput = z.record(Id, z.array(Id).max(500)).refine((r) => Object.keys(r).length <= 100);
const NOTE_SNIPPET = 160;
/** Projects read in parallel per round (keeps well inside Notion's rate limit). */
const PARALLEL = 3;

/**
 * Latest note per step for "My open items". Input: project id → the step ids shown for it. One notes read per
 * project, a few projects at a time.
 */
export async function openItemNotesAction(byProject: Record<string, string[]>): Promise<ActionResult<Record<string, NoteSnippet>>> {
  const parsed = NotesInput.safeParse(byProject);
  if (!parsed.success) return fail("Some of the details sent weren't valid. Reload the page and try again.", "VALIDATION");
  return runQuery(async () => {
    const repo = getRepo();
    const out: Record<string, NoteSnippet> = {};
    const entries = Object.entries(parsed.data);
    for (let i = 0; i < entries.length; i += PARALLEL) {
      await Promise.all(
        entries.slice(i, i + PARALLEL).map(async ([projectId, stepIds]) => {
          const wanted = new Set(stepIds);
          const notes = await repo.notes.listByProject(projectId);
          for (const n of notes) {
            if (n.archived || !n.stepId || !wanted.has(n.stepId)) continue;
            const prev = out[n.stepId];
            if (prev && prev.createdAt >= n.createdAt) continue;
            out[n.stepId] = { body: truncate(n.body.replace(/\s+/g, " ").trim(), NOTE_SNIPPET), author: n.author, createdAt: n.createdAt };
          }
        }),
      );
    }
    return out;
  });
}
