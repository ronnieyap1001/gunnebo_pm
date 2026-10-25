import "server-only";
/**
 * Step writes: value, N/A, flag, date confirmation, bulk N/A, project-only steps and the project flow.
 *
 * Write order for a step change (ONLINE-ARCHITECTURE section 8): GET step → PATCH step (rev + 1, lastOp = opId)
 * → PATCH project cell (read-modify-write of one cell, plus progress) → POST History. A repeated opId finds
 * `lastOp === opId` and only completes what is missing (no second step write, no second History row).
 */
import { convertValue } from "@/domain/convertValue";
import {
  addEdge,
  archiveEdge,
  archiveNodeInFlow,
  insertAfterInFlow,
  isActiveEdge,
  restoreBatchInFlow,
} from "@/domain/graph";
import { autoLayout, NODE_HEIGHT, NODE_WIDTH } from "@/domain/layout";
import { defaultPositions } from "@/domain/snapshot";
import { STATE_META } from "@/domain/state";
import { choicesEqual, stableStringify } from "@/domain/syncPlan";
import type { Cell, DateValue, FieldConfig, FieldType, Flow, FlowEdge, NodeFlag, Position, Project, Step } from "@/domain/types";
import { normalizeValue } from "@/domain/values";
import type { StepInput, StoredStep } from "@/server/repo/types";
import {
  alreadyLogged,
  appendHistory,
  AppError,
  EV,
  newId,
  notFound,
  requireName,
  summaryFor,
  type Ctx,
  type HistoryRow,
} from "./context";
import { hasChoices, prepareChoices, prepareConfig, requireFieldType, typeLabel, withDefaultStates, type ChoiceInput } from "./definitions";
import { edgeError, isPosition, MAX_DESCRIPTION_LENGTH, orderAfter } from "./library";
import {
  cellFlowOrder,
  defOf,
  stepMirrorsOf,
  stepState,
  valueSnapshot,
  writeCell,
  writeMirrors,
  type CellsProgress,
} from "./mirrors";
import { buildCell } from "@/domain/cells";
import { assertNoNewRetiredChoice, requireProject, settleAll } from "./projects";

/** Most steps per bulk call (the UI splits bigger selections into several calls, each with its own opId). */
export const BULK_LIMIT = 16;
/** The seed key of "Project closed" (a date on or before today offers "Set status to Closed?"). */
export const PROJECT_CLOSED_KEY = "project-closed";

export interface StepWriteResult {
  step: StoredStep;
  project: CellsProgress;
  /** False when the write was a no-op (same value) or an already-applied retry. */
  changed: boolean;
  /** The flag was cleared because the value became Done / N/A. */
  flagCleared?: boolean;
  /** "Project closed" has a date on or before today and the status is not Closed: the UI offers to close. */
  suggestClose?: boolean;
}

interface Loaded {
  step: StoredStep;
  project: Project;
}

async function load(ctx: Ctx, stepId: string): Promise<Loaded> {
  const step = await ctx.repo.steps.get(stepId);
  if (!step) throw notFound("This milestone");
  const project = await requireProject(ctx.repo, step.projectId);
  return { step, project };
}

function countOf(project: Project, stepId: string): number {
  return project.cells?.[stepId]?.fc ?? 0;
}

function mirrorsOf(project: Project): CellsProgress {
  return { progress: project.progress, cells: project.cells ?? {} };
}

function assertEditable(step: Step, project: Project): void {
  if (step.archived) throw new AppError("VALIDATION", `"${step.name}" is archived. Restore it first.`);
  if (project.archived) throw new AppError("VALIDATION", `${project.code} is archived. Restore it first.`);
}

function checkRev(step: Step, expectedRev: number | undefined): void {
  if (expectedRev === undefined || expectedRev === null) return;
  if (step.rev !== expectedRev) throw new AppError("CONFLICT", "This milestone changed elsewhere; reloaded.", { rev: step.rev });
}

function summaryOf(project: Project, text: string): string {
  return summaryFor(project.code, text);
}

function suggestClose(step: Step, project: Project, ctx: Ctx): boolean {
  if (step.milestoneKey !== PROJECT_CLOSED_KEY || step.fieldType !== "DATE" || !step.value) return false;
  const date = (step.value as DateValue).date;
  return typeof date === "string" && date <= ctx.day.today && project.status !== "CLOSED";
}

/** Adds stateChangedAt = now to the patch when the derived state changes. */
function withStateChange(ctx: Ctx, step: Step, patch: Partial<StepInput>, count: number): Partial<StepInput> {
  const before = stepState(step, count, ctx.day).state;
  const after = stepState({ ...step, ...patch } as Step, count, ctx.day).state;
  return before !== after ? { ...patch, stateChangedAt: ctx.now } : patch;
}

/** PATCH step (rev + 1, lastOp, lastChangedAt) → PATCH the project's cell → POST History. */
async function commit(
  ctx: Ctx,
  loaded: Loaded,
  patch: Partial<StepInput>,
  history: (updated: StoredStep) => HistoryRow,
  opts: { bumpRev?: boolean } = {},
): Promise<{ step: StoredStep; project: CellsProgress }> {
  const { step, project } = loaded;
  const full: Partial<StepInput> = { ...patch, lastOp: ctx.opId, lastChangedAt: ctx.now };
  if (opts.bumpRev !== false) full.rev = step.rev + 1;
  full.mirrors = stepMirrorsOf({ ...step, ...full } as Step, countOf(project, step.id), ctx.day);
  const updated = await ctx.repo.steps.update(step.id, full);
  const mirrors = await writeCell(ctx, project, updated, countOf(project, step.id));
  await appendHistory(ctx, history(updated));
  return { step: updated, project: mirrors };
}

/** The step already carries this op: make sure the cell and the History row exist, without writing the step again. */
async function completeRetry(ctx: Ctx, loaded: Loaded, history: HistoryRow): Promise<StepWriteResult> {
  const mirrors = await writeCell(ctx, loaded.project, loaded.step, countOf(loaded.project, loaded.step.id));
  await appendHistory(ctx, { ...history, data: { ...(history.data ?? {}), resumed: true } });
  return { step: loaded.step, project: mirrors, changed: false };
}

function baseData(step: Step): Record<string, unknown> {
  return { stepName: step.name, milestoneKey: step.milestoneKey };
}

function stepRow(project: Project, step: Step, row: Omit<HistoryRow, "projectId" | "stepId" | "milestoneId" | "milestoneKey">): HistoryRow {
  return { ...row, projectId: project.id, stepId: step.id, milestoneId: step.milestoneId, milestoneKey: step.milestoneKey };
}

// ---------------------------------------------------------------------------
// Value, N/A, flag, confirm
// ---------------------------------------------------------------------------

export interface SetStepValueInput {
  stepId: string;
  /** The stored shape (e.g. { choiceId }) or bare input (a choice id, a number, 'YYYY-MM-DD', true); null clears. */
  value: unknown;
  expectedRev: number;
}

/**
 * Sets a step's value. A retired choice may be kept but not newly chosen; the same value is a no-op. When the new
 * value-derived state is DONE or NOT_APPLICABLE and a flag is set, the flag is cleared (noted in History).
 * valueSetAt = lastChangedAt = now; stateChangedAt = now only when the derived state changed. History
 * `step.value_changed` with old/new {raw, display, state}.
 */
export async function setStepValue(ctx: Ctx, input: SetStepValueInput): Promise<StepWriteResult> {
  const loaded = await load(ctx, input.stepId);
  const { step, project } = loaded;
  const count = countOf(project, step.id);
  if (step.lastOp === ctx.opId) {
    const snap = valueSnapshot(step, step.value, count, ctx.day);
    const r = await completeRetry(
      ctx,
      loaded,
      stepRow(project, step, {
        type: EV.stepValueChanged,
        summary: summaryOf(project, `${step.name}: → ${snap.display}`),
        newDisplay: snap.display,
        data: { ...baseData(step), new: snap },
      }),
    );
    return { ...r, suggestClose: suggestClose(step, project, ctx) };
  }
  assertEditable(step, project);
  checkRev(step, input.expectedRev);
  if (step.fieldType === "FILE") {
    throw new AppError("VALIDATION", "A File milestone has no value: add a file or a link instead.");
  }
  const r = normalizeValue(defOf(step), input.value);
  if (!r.ok) throw new AppError("VALIDATION", r.error);
  assertNoNewRetiredChoice(step.choices ?? [], r.value, step.value);
  if (stableStringify(r.value) === stableStringify(step.value ?? null)) {
    return { step, project: mirrorsOf(project), changed: false, suggestClose: suggestClose(step, project, ctx) };
  }

  const old = valueSnapshot(step, step.value, count, ctx.day);
  const valueState = stepState({ ...step, value: r.value, valueSetAt: ctx.now, flag: null, notApplicable: false }, count, ctx.day).state;
  const clearFlag = !!step.flag && (valueState === "DONE" || valueState === "NOT_APPLICABLE");
  let patch: Partial<StepInput> = { value: r.value, valueSetAt: ctx.now };
  if (clearFlag) patch.flag = null;
  patch = withStateChange(ctx, step, patch, count);
  const next = { ...step, ...patch } as StoredStep;
  const neu = valueSnapshot(next, r.value, count, ctx.day);

  const done = await commit(ctx, loaded, patch, () =>
    stepRow(project, step, {
      type: EV.stepValueChanged,
      summary: summaryOf(project, `${step.name}: ${old.display} → ${neu.display}${clearFlag ? " (flag cleared)" : ""}`),
      oldDisplay: old.display,
      newDisplay: neu.display,
      data: { ...baseData(step), old, new: neu, ...(clearFlag ? { flagCleared: step.flag } : {}) },
    }),
  );
  return { ...done, changed: true, flagCleared: clearFlag || undefined, suggestClose: suggestClose(done.step, project, ctx) };
}

export async function setStepNotApplicable(
  ctx: Ctx,
  input: { stepId: string; notApplicable: boolean; expectedRev: number },
): Promise<StepWriteResult> {
  const loaded = await load(ctx, input.stepId);
  const { step, project } = loaded;
  const count = countOf(project, step.id);
  const na = input.notApplicable === true;
  const text = na ? "marked not applicable" : "no longer not applicable";
  if (step.lastOp === ctx.opId) {
    return completeRetry(
      ctx,
      loaded,
      stepRow(project, step, {
        type: EV.stepNaChanged,
        summary: summaryOf(project, `${step.name}: ${text}`),
        data: { ...baseData(step), notApplicable: step.notApplicable },
      }),
    );
  }
  assertEditable(step, project);
  checkRev(step, input.expectedRev);
  if (step.notApplicable === na) return { step, project: mirrorsOf(project), changed: false };

  const old = valueSnapshot(step, step.value, count, ctx.day);
  const patch = withStateChange(ctx, step, { notApplicable: na }, count);
  const neu = valueSnapshot({ ...step, notApplicable: na }, step.value, count, ctx.day);
  const done = await commit(ctx, loaded, patch, () =>
    stepRow(project, step, {
      type: EV.stepNaChanged,
      summary: summaryOf(project, `${step.name}: ${text}`),
      oldDisplay: STATE_META[old.state].label,
      newDisplay: STATE_META[neu.state].label,
      data: { ...baseData(step), notApplicable: na, old, new: neu },
    }),
  );
  return { ...done, changed: true };
}

const FLAG_LABEL: Record<NodeFlag, string> = { WAITING: "Waiting", BLOCKED: "Blocked" };

/** Sets or clears the Waiting / Blocked flag. A reason is saved as a note on the step (mentioned in the one History row). */
export async function setStepFlag(
  ctx: Ctx,
  input: { stepId: string; flag: NodeFlag | null; reason?: string; expectedRev?: number },
): Promise<StepWriteResult & { noteId?: string }> {
  const flag = input.flag ?? null;
  if (flag !== null && flag !== "WAITING" && flag !== "BLOCKED") throw new AppError("VALIDATION", "Pick Waiting, Blocked or no flag.");
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (reason.length > 5000) throw new AppError("VALIDATION", "The reason is too long (maximum 5,000 characters).");
  const loaded = await load(ctx, input.stepId);
  const { step, project } = loaded;
  const count = countOf(project, step.id);
  const noteBody = flag && reason ? `${FLAG_LABEL[flag]}: ${reason}` : "";
  const text = flag ? `flagged ${FLAG_LABEL[flag]}${reason ? ` — ${reason}` : ""}` : "flag cleared";

  if (step.lastOp === ctx.opId) {
    const noteId = noteBody ? await ensureNote(ctx, project.id, step.id, noteBody) : undefined;
    const r = await completeRetry(
      ctx,
      loaded,
      stepRow(project, step, {
        type: EV.stepFlagChanged,
        summary: summaryOf(project, `${step.name}: ${text}`),
        data: { ...baseData(step), newFlag: step.flag, reason: reason || undefined, noteId },
      }),
    );
    return { ...r, noteId };
  }
  assertEditable(step, project);
  checkRev(step, input.expectedRev);
  if ((step.flag ?? null) === flag) return { step, project: mirrorsOf(project), changed: false };

  const old = valueSnapshot(step, step.value, count, ctx.day);
  const patch = withStateChange(ctx, step, { flag }, count);
  const neu = valueSnapshot({ ...step, flag }, step.value, count, ctx.day);
  const noteId = noteBody ? await ensureNote(ctx, project.id, step.id, noteBody) : undefined;
  const done = await commit(ctx, loaded, patch, () =>
    stepRow(project, step, {
      type: EV.stepFlagChanged,
      summary: summaryOf(project, `${step.name}: ${text}`),
      oldDisplay: step.flag ? FLAG_LABEL[step.flag] : "No flag",
      newDisplay: flag ? FLAG_LABEL[flag] : "No flag",
      data: { ...baseData(step), oldFlag: step.flag, newFlag: flag, reason: reason || undefined, noteId, old, new: neu },
    }),
  );
  return { ...done, changed: true, noteId };
}

/** Creates the flag-reason note unless an identical active note on the step already exists. */
async function ensureNote(ctx: Ctx, projectId: string, stepId: string, body: string): Promise<string> {
  const notes = await ctx.repo.notes.listByProject(projectId);
  const same = notes.find((n) => n.stepId === stepId && n.body === body && !n.archived);
  if (same) return same.id;
  const note = await ctx.repo.notes.create({ projectId, stepId, body, author: ctx.actor, archived: false });
  return note.id;
}

/** "Confirm it happened": sets valueSetAt = now, which clears the clock marker of a date that passed by itself. */
export async function confirmStepDate(ctx: Ctx, stepId: string, expectedRev?: number): Promise<StepWriteResult> {
  const loaded = await load(ctx, stepId);
  const { step, project } = loaded;
  const count = countOf(project, step.id);
  const row = stepRow(project, step, {
    type: EV.stepDateConfirmed,
    summary: summaryOf(project, `${step.name}: confirmed it happened`),
    data: { ...baseData(step) },
  });
  if (step.lastOp === ctx.opId) return completeRetry(ctx, loaded, row);
  assertEditable(step, project);
  checkRev(step, expectedRev);
  if (stepState(step, count, ctx.day).reason !== "DATE_PASSED_AUTO") return { step, project: mirrorsOf(project), changed: false };
  const done = await commit(ctx, loaded, { valueSetAt: ctx.now }, () => row);
  return { ...done, changed: true };
}

/**
 * Marks up to 16 steps of one project (not) applicable: one Steps query, N step patches, one project patch and ONE
 * History row relating to all steps (data.stepIds).
 */
export async function bulkSetNotApplicable(
  ctx: Ctx,
  input: { projectId: string; stepIds: string[]; notApplicable: boolean },
): Promise<{ changedIds: string[]; project: CellsProgress }> {
  const ids = [...new Set(input.stepIds ?? [])];
  if (ids.length > BULK_LIMIT) throw new AppError("VALIDATION", `Pick at most ${BULK_LIMIT} milestones at a time.`);
  const project = await requireProject(ctx.repo, input.projectId);
  if (ids.length === 0) return { changedIds: [], project: mirrorsOf(project) };
  if (project.archived) throw new AppError("VALIDATION", `${project.code} is archived. Restore it first.`);
  const na = input.notApplicable === true;
  const steps = await ctx.repo.steps.listByProject(project.id);
  const byId = new Map(steps.map((s) => [s.id, s]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length) throw notFound(missing.length === 1 ? "One of the milestones" : `${missing.length} of the milestones`);
  if (await alreadyLogged(ctx)) return { changedIds: [], project: mirrorsOf(project) };

  const targets = ids.map((id) => byId.get(id)!);
  const already = targets.filter((s) => s.lastOp === ctx.opId);
  const todo = targets.filter((s) => s.lastOp !== ctx.opId && s.notApplicable !== na);
  const updated = await settleAll(
    todo.map((s) => () => {
      const count = countOf(project, s.id);
      const patch = withStateChange(ctx, s, { notApplicable: na }, count);
      const mirrors = stepMirrorsOf({ ...s, notApplicable: na }, count, ctx.day);
      return ctx.repo.steps.update(s.id, { ...patch, rev: s.rev + 1, lastOp: ctx.opId, lastChangedAt: ctx.now, mirrors });
    }),
  );
  const changed = [...already, ...updated];
  if (changed.length === 0) return { changedIds: [], project: mirrorsOf(project) };

  const fresh = project;
  const cells: Record<string, Cell> = { ...(fresh.cells ?? {}) };
  for (const s of changed) cells[s.id] = buildCell(s, countOf(fresh, s.id));
  const mirrors = await writeMirrors(ctx, fresh, cells);

  const detail = changed.map((s) => {
    const count = countOf(fresh, s.id);
    return {
      stepId: s.id,
      stepName: s.name,
      milestoneKey: s.milestoneKey,
      old: valueSnapshot({ ...s, notApplicable: !na }, s.value, count, ctx.day),
      new: valueSnapshot(s, s.value, count, ctx.day),
    };
  });
  const n = changed.length;
  await appendHistory(ctx, {
    type: EV.stepNaChanged,
    summary: summaryOf(
      fresh,
      `${n} milestone${n === 1 ? "" : "s"} ${na ? "marked not applicable" : "no longer not applicable"}: ${changed
        .slice(0, 3)
        .map((s) => s.name)
        .join(", ")}${n > 3 ? ` +${n - 3}` : ""}`,
    ),
    projectId: fresh.id,
    stepId: n === 1 ? changed[0].id : undefined,
    data: { bulk: true, notApplicable: na, stepIds: changed.map((s) => s.id), steps: detail },
  });
  return { changedIds: changed.map((s) => s.id), project: mirrors };
}

// ---------------------------------------------------------------------------
// Project-only steps
// ---------------------------------------------------------------------------

export interface AddProjectStepInput {
  projectId: string;
  name: string;
  fieldType: FieldType;
  description?: string;
  choices?: ChoiceInput[];
  config?: FieldConfig;
  /** Insert after this step (takes over its outgoing arrows). */
  afterStepId?: string;
  position?: Position;
}

function describeOptional(raw: unknown): string {
  if (raw === undefined || raw === null) return "";
  if (typeof raw !== "string") throw new AppError("VALIDATION", "The description must be text.");
  const d = raw.trim();
  if (d.length > MAX_DESCRIPTION_LENGTH) {
    throw new AppError("VALIDATION", `The description is too long (maximum ${MAX_DESCRIPTION_LENGTH} characters).`);
  }
  return d;
}

/** Adds a project-only step (stepKey `<projectId>:<opId>`, so a retry never adds it twice). History `step.added`. */
export async function addProjectStep(ctx: Ctx, input: AddProjectStepInput): Promise<StepWriteResult> {
  const name = requireName(input.name, "The milestone name");
  const fieldType = requireFieldType(input.fieldType);
  const description = describeOptional(input.description);
  const config = prepareConfig(input.config);
  const choices = prepareChoices(input.choices ?? [], { fieldType, existing: [], withStates: true });
  const project = await requireProject(ctx.repo, input.projectId);
  if (project.archived) throw new AppError("VALIDATION", `${project.code} is archived. Restore it first.`);
  if (project.setup !== "READY") throw new AppError("BUSY", "This project is still being set up. Try again in a moment.");

  const all = await ctx.repo.steps.listByProject(project.id, { includeArchived: true });
  const stepKey = `${project.id}:${ctx.opId}`;
  let step = all.find((s) => s.stepKey === stepKey);
  const after = input.afterStepId ? all.find((s) => s.id === input.afterStepId && !s.archived) : undefined;
  if (input.afterStepId && !after) throw notFound("The milestone to insert after");

  if (!step) {
    const orders = all.filter((s) => !s.archived).map((s) => s.order);
    const order = after ? orderAfter(after.order, orders) : (orders.length ? Math.max(...orders) : 0) + 1;
    step = await ctx.repo.steps.create({
      projectId: project.id,
      name,
      description,
      fieldType,
      choices,
      config,
      value: null,
      notApplicable: false,
      flag: null,
      order,
      rev: 0,
      archived: false,
      stepKey,
      lastOp: ctx.opId,
    });
  }

  const fresh = project;
  let flow = fresh.flow;
  if (!flow.nodes[step.id]) {
    if (after) {
      const at = flow.nodes[after.id] ?? { x: 0, y: 0 };
      const pos = input.position ?? { x: at.x + NODE_WIDTH + 40, y: at.y + NODE_HEIGHT + 40 };
      flow = insertAfterInFlow(flow, after.id, step.id, pos, ctx.now, newId);
    } else {
      const placed = all.filter((s) => !s.archived && flow.nodes[s.id]).map((s) => flow.nodes[s.id]);
      const pos = isPosition(input.position) ? input.position : defaultPositions([step.id], placed)[step.id];
      flow = { nodes: { ...flow.nodes, [step.id]: { x: pos.x, y: pos.y } }, edges: flow.edges };
    }
  }
  const cells = { ...(fresh.cells ?? {}), [step.id]: buildCell(step, 0) };
  const mirrors = await writeMirrors(ctx, fresh, cells, flow === fresh.flow ? {} : { flow });
  await appendHistory(ctx, {
    type: EV.stepAdded,
    summary: summaryOf(fresh, after ? `Added "${name}" after "${after.name}"` : `Added "${name}"`),
    projectId: fresh.id,
    stepId: step.id,
    newDisplay: name,
    data: { stepName: name, fieldType, afterStepId: after?.id, projectOnly: true },
  });
  return { step, project: mirrors, changed: true };
}

export interface StepDefinitionPatch {
  name?: string;
  description?: string;
  fieldType?: FieldType;
  choices?: ChoiceInput[];
  config?: FieldConfig;
}

/**
 * Edits a project-only step's definition (template-derived steps: FORBIDDEN). A type change keeps the value when
 * convertValue can convert it; otherwise it is refused unless `clearValue` is set (the old value stays in History).
 */
export async function updateStepDefinition(
  ctx: Ctx,
  stepId: string,
  patch: StepDefinitionPatch,
  opts: { expectedRev?: number; clearValue?: boolean } = {},
): Promise<StepWriteResult> {
  const loaded = await load(ctx, stepId);
  const { step, project } = loaded;
  if (step.milestoneId) {
    throw new AppError(
      "FORBIDDEN",
      `"${step.name}" comes from the template: change it in the Library and Sync, or mark it Not applicable.`,
    );
  }
  const count = countOf(project, step.id);
  const row = (changes: string[], oldSnap?: unknown, newSnap?: unknown): HistoryRow =>
    stepRow(project, step, {
      type: EV.stepUpdated,
      summary: summaryOf(project, `Updated "${step.name}": ${changes.join("; ")}`),
      data: { ...baseData(step), changes, old: oldSnap, new: newSnap },
    });
  if (step.lastOp === ctx.opId) return completeRetry(ctx, loaded, row(["definition"]));
  assertEditable(step, project);
  checkRev(step, opts.expectedRev);

  const next: Partial<StepInput> = {};
  const changes: string[] = [];
  if (patch.name !== undefined) {
    const name = requireName(patch.name, "The milestone name");
    if (name !== step.name) {
      next.name = name;
      changes.push(`name "${step.name}" → "${name}"`);
    }
  }
  if (patch.description !== undefined) {
    const d = describeOptional(patch.description);
    if (d !== (step.description ?? "")) {
      next.description = d;
      changes.push("description");
    }
  }
  const fieldType = patch.fieldType !== undefined ? requireFieldType(patch.fieldType) : step.fieldType;
  const becameDropdown = fieldType === "DROPDOWN" && step.fieldType !== "DROPDOWN";
  let choices = step.choices ?? [];
  if (patch.choices !== undefined) {
    choices = prepareChoices(patch.choices, { fieldType, existing: step.choices ?? [], withStates: true, defaultMissingState: becameDropdown });
  } else if (becameDropdown) {
    choices = withDefaultStates(choices);
  }
  if (!choicesEqual(choices, step.choices ?? [])) {
    next.choices = choices;
    changes.push("choices");
  }
  if (patch.config !== undefined) {
    const config = prepareConfig(patch.config);
    if (stableStringify(config) !== stableStringify(step.config ?? {})) {
      next.config = config;
      changes.push("settings");
    }
  }
  if (fieldType !== step.fieldType) {
    next.fieldType = fieldType;
    changes.push(`type ${typeLabel(step.fieldType)} → ${typeLabel(fieldType)}`);
    const conv = convertValue(step.fieldType, fieldType, step.value ?? null, hasChoices(fieldType) ? choices : undefined);
    if (conv.ok) {
      if (stableStringify(conv.value) !== stableStringify(step.value ?? null)) next.value = conv.value;
    } else if (opts.clearValue) {
      next.value = null;
      changes.push("value cleared");
    } else {
      throw new AppError("VALIDATION", `${conv.reason} Clear the value first, or confirm that it will be cleared (it stays in History).`, {
        needsClear: true,
      });
    }
  }
  if (changes.length === 0) return { step, project: mirrorsOf(project), changed: false };

  const old = valueSnapshot(step, step.value, count, ctx.day);
  const withState = withStateChange(ctx, step, next, count);
  const after = { ...step, ...withState } as StoredStep;
  const neu = valueSnapshot(after, after.value, count, ctx.day);
  const done = await commit(ctx, loaded, withState, () => row(changes, old, neu));
  return { ...done, changed: true };
}

/** Archives a project-only step (template-derived: FORBIDDEN, mark N/A instead) with "Reconnect neighbours". */
export async function archiveProjectStep(
  ctx: Ctx,
  stepId: string,
  opts: { reconnect?: boolean } = {},
): Promise<{ batchId: string; project: CellsProgress }> {
  const { step, project } = await load(ctx, stepId);
  if (step.milestoneId) {
    throw new AppError("FORBIDDEN", `"${step.name}" comes from the template and can't be deleted. Mark it Not applicable instead.`, {
      suggestNotApplicable: true,
    });
  }
  if (step.archived) return { batchId: step.archiveBatch ?? "", project: mirrorsOf(project) };
  const batchId = newId();
  const result = archiveNodeInFlow(project.flow, stepId, {
    batchId,
    now: ctx.now,
    reconnect: opts.reconnect !== false,
    idFactory: newId,
  });
  await ctx.repo.steps.update(stepId, { archived: true, archivedAt: ctx.now, archiveBatch: batchId, lastOp: ctx.opId });
  const cells = { ...(project.cells ?? {}) };
  delete cells[stepId];
  const mirrors = await writeMirrors(ctx, project, cells, { flow: result.flow });
  await appendHistory(ctx, {
    type: EV.stepArchived,
    summary: summaryOf(project, `Archived "${step.name}"`),
    projectId: project.id,
    stepId,
    data: { stepName: step.name, batchId, archivedEdgeIds: result.archivedEdgeIds, bridgeEdgeIds: result.bridgeEdgeIds },
  });
  return { batchId, project: mirrors };
}

/** Undo a project-step archive: restores the batch's steps and arrows, removes the batch's bridge arrows. */
export async function restoreProjectBatch(
  ctx: Ctx,
  projectId: string,
  batchId: string,
): Promise<{ restoredIds: string[]; skippedEdgeIds: string[]; project: CellsProgress }> {
  const project = await requireProject(ctx.repo, projectId);
  const all = await ctx.repo.steps.listByProject(projectId, { includeArchived: true });
  const batch = all.filter((s) => s.archived && s.archiveBatch === batchId);
  if (!batchId || batch.length === 0) return { restoredIds: [], skippedEdgeIds: [], project: mirrorsOf(project) };
  const restored = await settleAll(
    batch.map((s) => () =>
      ctx.repo.steps.update(s.id, { archived: false, archivedAt: undefined, archiveBatch: undefined, lastOp: ctx.opId }),
    ),
  );
  const activeIds = new Set(all.filter((s) => !s.archived).map((s) => s.id));
  for (const s of batch) activeIds.add(s.id);
  const result = restoreBatchInFlow(project.flow, batchId, activeIds, ctx.now);
  const fresh = project;
  const cells = { ...(fresh.cells ?? {}) };
  const counts = await stepAttachmentCounts(ctx, projectId);
  for (const s of restored) cells[s.id] = buildCell(s, counts[s.id] ?? 0);
  let flow = result.flow;
  const missing = restored.filter((s) => !flow.nodes[s.id]).map((s) => s.id);
  if (missing.length) flow = { nodes: { ...flow.nodes, ...defaultPositions(missing, Object.values(flow.nodes)) }, edges: flow.edges };
  const mirrors = await writeMirrors(ctx, fresh, cells, { flow });
  await appendHistory(ctx, {
    type: EV.stepRestored,
    summary: summaryOf(project, `Restored ${batch.map((s) => `"${s.name}"`).join(", ")}`),
    projectId,
    stepId: batch.length === 1 ? batch[0].id : undefined,
    data: {
      batchId,
      stepIds: batch.map((s) => s.id),
      restoredEdgeIds: result.restoredEdgeIds,
      skippedEdgeIds: result.skippedEdgeIds,
      removedBridgeIds: result.removedBridgeIds,
    },
  });
  return { restoredIds: batch.map((s) => s.id), skippedEdgeIds: result.skippedEdgeIds, project: mirrors };
}

async function stepAttachmentCounts(ctx: Ctx, projectId: string): Promise<Record<string, number>> {
  const atts = await ctx.repo.attachments.listByProject(projectId);
  const out: Record<string, number> = {};
  for (const a of atts) if (!a.archived && a.stepId) out[a.stepId] = (out[a.stepId] ?? 0) + 1;
  return out;
}

// ---------------------------------------------------------------------------
// Project flow
// ---------------------------------------------------------------------------

/** Saves dragged positions of project nodes. No History. */
export async function moveProjectNodes(ctx: Ctx, projectId: string, positions: Record<string, Position>): Promise<void> {
  const project = await requireProject(ctx.repo, projectId);
  const nodes = { ...project.flow.nodes };
  let changed = false;
  for (const [id, p] of Object.entries(positions ?? {})) {
    if (!(id in nodes) || !isPosition(p)) continue;
    if (nodes[id].x === p.x && nodes[id].y === p.y) continue;
    nodes[id] = { x: p.x, y: p.y };
    changed = true;
  }
  if (changed) await ctx.repo.projects.update(projectId, { flow: { nodes, edges: project.flow.edges } });
}

async function activeStepsById(ctx: Ctx, projectId: string): Promise<Map<string, StoredStep>> {
  const steps = await ctx.repo.steps.listByProject(projectId);
  return new Map(steps.map((s) => [s.id, s]));
}

/** Draws an arrow between two active steps of the project. AppError CYCLE / DUPLICATE. History `edge.added`. */
export async function addProjectEdge(ctx: Ctx, projectId: string, from: string, to: string): Promise<FlowEdge> {
  const project = await requireProject(ctx.repo, projectId);
  const steps = await activeStepsById(ctx, projectId);
  const a = steps.get(from);
  const b = steps.get(to);
  if (!a || !b) throw notFound("One end of the arrow");
  const existing = project.flow.edges.find((e) => isActiveEdge(e) && e.from === from && e.to === to);
  if (existing && (await alreadyLogged(ctx))) return existing;
  let flow = project.flow;
  const missing = [from, to].filter((id) => !flow.nodes[id]);
  if (missing.length) flow = { nodes: { ...flow.nodes, ...defaultPositions(missing, Object.values(flow.nodes)) }, edges: flow.edges };
  const r = addEdge(flow, from, to, ctx.now, newId);
  if (!r.ok) throw edgeError(r.reason);
  await ctx.repo.projects.update(projectId, { flow: r.flow });
  await appendHistory(ctx, {
    type: EV.edgeAdded,
    summary: summaryOf(project, `Arrow "${a.name}" → "${b.name}" added`),
    projectId,
    data: { edgeId: r.edge.id, from, to, fromName: a.name, toName: b.name },
  });
  return r.edge;
}

/** Deletes (archives, reason USER) a project arrow. History `edge.archived`. */
export async function archiveProjectEdge(ctx: Ctx, projectId: string, edgeId: string): Promise<void> {
  const project = await requireProject(ctx.repo, projectId);
  const edge = project.flow.edges.find((e) => e.id === edgeId);
  if (!edge) throw notFound("This arrow");
  if (!isActiveEdge(edge)) return;
  const steps = await ctx.repo.steps.listByProject(projectId, { includeArchived: true });
  const name = (id: string) => steps.find((s) => s.id === id)?.name ?? "?";
  await ctx.repo.projects.update(projectId, { flow: archiveEdge(project.flow, edgeId, ctx.now, "USER") });
  await appendHistory(ctx, {
    type: EV.edgeArchived,
    summary: summaryOf(project, `Arrow "${name(edge.from)}" → "${name(edge.to)}" removed`),
    projectId,
    data: { edgeId, from: edge.from, to: edge.to, fromName: name(edge.from), toName: name(edge.to) },
  });
}

/** Auto-layout of the project's active steps. No History. */
export async function layoutProject(
  ctx: Ctx,
  projectId: string,
  opts: { wrap?: boolean; viewportWidth?: number } = {},
): Promise<Flow> {
  const project = await requireProject(ctx.repo, projectId);
  const ids = cellFlowOrder(project.cells ?? {}, project.flow);
  const positions = autoLayout(ids, project.flow.edges, { wrap: opts.wrap, viewportWidth: opts.viewportWidth });
  const flow: Flow = { nodes: { ...project.flow.nodes, ...positions }, edges: project.flow.edges };
  await ctx.repo.projects.update(projectId, { flow });
  return flow;
}
