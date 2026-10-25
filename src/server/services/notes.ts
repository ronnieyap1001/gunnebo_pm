import "server-only";
/**
 * Notes on a project or a step. Editable and deletable (archived); History keeps the original text.
 */
import { truncate } from "@/domain/format";
import type { Note, Project } from "@/domain/types";
import { alreadyLogged, appendHistory, AppError, dataRef, EV, findUnloggedCreate, notFound, summaryFor, type Ctx } from "./context";
import { requireProject } from "./projects";

export const MAX_NOTE_LENGTH = 20_000;
const SNIPPET = 40;

function requireBody(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) throw new AppError("VALIDATION", "Write something first.");
  const body = raw.replace(/\r\n/g, "\n").trim();
  if (body.length > MAX_NOTE_LENGTH) {
    throw new AppError("VALIDATION", `The note is too long (maximum ${MAX_NOTE_LENGTH.toLocaleString("en-GB")} characters).`);
  }
  return body;
}

function snippet(body: string): string {
  return truncate(body.replace(/\s+/g, " "), SNIPPET);
}

async function stepName(ctx: Ctx, project: Project, stepId: string | undefined): Promise<{ name?: string; milestoneKey?: string }> {
  if (!stepId) return {};
  const step = await ctx.repo.steps.get(stepId);
  if (!step || step.projectId !== project.id) throw notFound("This milestone");
  return { name: step.name, milestoneKey: step.milestoneKey };
}

async function requireNote(ctx: Ctx, projectId: string, noteId: string): Promise<Note> {
  const notes = await ctx.repo.notes.listByProject(projectId, { includeArchived: true });
  const note = notes.find((n) => n.id === noteId);
  if (!note) throw notFound("This note");
  return note;
}

function where(name: string | undefined): string {
  return name ? `Note on ${name}` : "Note";
}

/**
 * History `note.added`: `C0822 · Note on BOM: "Waiting for PE…"`. A retry after a crash between the note and its
 * History row adopts the note the first attempt created (no duplicate, one row).
 */
export async function addNote(ctx: Ctx, input: { projectId: string; stepId?: string; body: string }): Promise<Note> {
  const body = requireBody(input.body);
  const project = await requireProject(ctx.repo, input.projectId);
  const step = await stepName(ctx, project, input.stepId);
  const notes = await ctx.repo.notes.listByProject(project.id);
  const same = notes.filter((n) => n.body === body && (n.stepId ?? undefined) === (input.stepId ?? undefined));
  if (await alreadyLogged(ctx)) {
    const done = same.pop();
    if (done) return done;
  }
  const note =
    (await findUnloggedCreate(
      ctx,
      same.filter((n) => n.author === ctx.actor),
      { projectId: project.id, type: EV.noteAdded, refOf: dataRef("noteId") },
    )) ??
    (await ctx.repo.notes.create({
      projectId: project.id,
      ...(input.stepId ? { stepId: input.stepId } : {}),
      body,
      author: ctx.actor,
      archived: false,
    }));
  await appendHistory(ctx, {
    type: EV.noteAdded,
    summary: summaryFor(project.code, `${where(step.name)}: "${snippet(body)}"`),
    projectId: project.id,
    stepId: input.stepId,
    milestoneKey: step.milestoneKey,
    newDisplay: snippet(body),
    data: { noteId: note.id, stepName: step.name, milestoneKey: step.milestoneKey, body },
  });
  return note;
}

/**
 * History `note.edited` with the old and new text. The row is written before the note: the old text exists nowhere
 * else, so an interrupted edit must not lose it (a retry with the same opId then finishes the note update).
 */
export async function editNote(ctx: Ctx, input: { projectId: string; noteId: string; body: string }): Promise<Note> {
  const body = requireBody(input.body);
  const project = await requireProject(ctx.repo, input.projectId);
  const note = await requireNote(ctx, project.id, input.noteId);
  if (note.archived) throw new AppError("VALIDATION", "This note is deleted. Restore it first.");
  if (note.body === body) return note;
  const step = await stepName(ctx, project, note.stepId);
  await appendHistory(ctx, {
    type: EV.noteEdited,
    summary: summaryFor(project.code, `${where(step.name)} edited: "${snippet(body)}"`),
    projectId: project.id,
    stepId: note.stepId,
    milestoneKey: step.milestoneKey,
    oldDisplay: snippet(note.body),
    newDisplay: snippet(body),
    data: { noteId: note.id, stepName: step.name, milestoneKey: step.milestoneKey, oldBody: note.body, newBody: body },
  });
  return ctx.repo.notes.update(note.id, { body, editedAt: ctx.now });
}

/**
 * Deleting a note archives it; the text stays in History. Archive / restore write the row first, then the note, so a
 * retry with the same opId after a crash between the two finishes the change with exactly one row.
 */
export async function archiveNote(ctx: Ctx, input: { projectId: string; noteId: string }): Promise<Note> {
  const project = await requireProject(ctx.repo, input.projectId);
  const note = await requireNote(ctx, project.id, input.noteId);
  if (note.archived) return note;
  const step = await stepName(ctx, project, note.stepId).catch(() => ({}) as { name?: string; milestoneKey?: string });
  await appendHistory(ctx, {
    type: EV.noteArchived,
    summary: summaryFor(project.code, `${where(step.name)} deleted: "${snippet(note.body)}"`),
    projectId: project.id,
    stepId: note.stepId,
    milestoneKey: step.milestoneKey,
    oldDisplay: snippet(note.body),
    data: { noteId: note.id, stepName: step.name, milestoneKey: step.milestoneKey, body: note.body },
  });
  return ctx.repo.notes.update(note.id, { archived: true });
}

export async function restoreNote(ctx: Ctx, input: { projectId: string; noteId: string }): Promise<Note> {
  const project = await requireProject(ctx.repo, input.projectId);
  const note = await requireNote(ctx, project.id, input.noteId);
  if (!note.archived) return note;
  const step = await stepName(ctx, project, note.stepId).catch(() => ({}) as { name?: string; milestoneKey?: string });
  await appendHistory(ctx, {
    type: EV.noteRestored,
    summary: summaryFor(project.code, `${where(step.name)} restored: "${snippet(note.body)}"`),
    projectId: project.id,
    stepId: note.stepId,
    milestoneKey: step.milestoneKey,
    newDisplay: snippet(note.body),
    data: { noteId: note.id, stepName: step.name, milestoneKey: step.milestoneKey, body: note.body },
  });
  return ctx.repo.notes.update(note.id, { archived: false });
}
