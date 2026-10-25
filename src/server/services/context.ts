import "server-only";
/**
 * Request context, errors and the canonical History helper for the business layer.
 *
 * Every service function takes a `Ctx` first: who acts, where the action came from, one opId per user action, one
 * timestamp for the whole action, today's date in the configured time zone, and the storage `repo`.
 * Services never read the clock or `new Date()` themselves.
 */
import { randomUUID } from "node:crypto";
import { todayIn } from "@/domain/dates";
import type { DayContext, EventSource, Iso, Ymd } from "@/domain/types";
import type { HistoryAppendInput, Repo, StoredHistoryEvent } from "@/server/repo/types";

export const DEFAULT_TIME_ZONE = "Asia/Singapore";
export const DEFAULT_ACTOR = "Me";

/** Settings keys used by the business layer. */
export const SETTINGS = {
  templateFlow: "template.flow",
  templateRevision: "template.revision",
  timeZone: "app.timezone",
  displayName: "app.displayName",
  seedAppliedAt: "seed.appliedAt",
  backupLastAt: "backup.lastAt",
} as const;

export interface Ctx {
  /** Display name ("Me" until Microsoft sign-in). */
  actor: string;
  /** 'MANUAL' from the UI, 'SYSTEM' for sync/import/reconcile, 'EMAIL' in Phase 2. */
  source: EventSource;
  /** One UUID per user action; created in the browser and passed through. */
  opId: string;
  /** Single timestamp for the whole action. */
  now: Iso;
  /** { today, timeZone } from Settings 'app.timezone' (default 'Asia/Singapore'). */
  day: DayContext;
  /** Defaults to opId. */
  correlationId?: string;
  /** Phase 2 (email message id). */
  externalRef?: string;
  repo: Repo;
}

export type AppErrorCode =
  | "VALIDATION"
  | "NOT_FOUND"
  | "CONFLICT"
  | "CODE_TAKEN"
  | "CYCLE"
  | "DUPLICATE"
  | "BUSY"
  | "BLOCK_LIMIT"
  | "STALE_PLAN"
  | "FORBIDDEN";

/** An error the user can understand (and usually fix). `message` is plain English and safe to show. */
export class AppError extends Error {
  readonly code: AppErrorCode;
  /** Extra machine-readable detail, e.g. { errors: [...] } for an invalid template file, { missingIds } for STALE_PLAN. */
  readonly details?: Record<string, unknown>;

  constructor(code: AppErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.details = details;
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}

export interface MakeCtxOptions {
  actor?: string;
  opId?: string;
  source?: EventSource;
  /** The action's single timestamp (default: the current time). */
  now?: Iso | Date;
  /** IANA time zone (default Asia/Singapore). */
  timeZone?: string;
  /** Overrides today's date (tests). Default: `now` in `timeZone`. */
  today?: Ymd;
  correlationId?: string;
  externalRef?: string;
}

function toIso(now: Iso | Date | undefined): Iso {
  if (now === undefined) return new Date().toISOString();
  if (now instanceof Date) return now.toISOString();
  const d = new Date(now);
  if (Number.isNaN(d.getTime())) throw new AppError("VALIDATION", `Not a valid timestamp: "${now}".`);
  return d.toISOString();
}

/** True when the runtime knows this IANA time zone. */
export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz.trim()) return false;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Builds a context synchronously. Use `makeCtxFromSettings` when the time zone should come from Settings. */
export function makeCtx(repo: Repo, opts: MakeCtxOptions = {}): Ctx {
  const now = toIso(opts.now);
  const timeZone = isValidTimeZone(opts.timeZone) ? opts.timeZone : DEFAULT_TIME_ZONE;
  const today = opts.today ?? todayIn(timeZone, new Date(now));
  const ctx: Ctx = {
    actor: opts.actor?.trim() || DEFAULT_ACTOR,
    source: opts.source ?? "MANUAL",
    opId: opts.opId?.trim() || randomUUID(),
    now,
    day: { today, timeZone },
    repo,
  };
  if (opts.correlationId) ctx.correlationId = opts.correlationId;
  if (opts.externalRef) ctx.externalRef = opts.externalRef;
  return ctx;
}

/** Like makeCtx, but reads the time zone ('app.timezone') and display name ('app.displayName') from Settings. */
export async function makeCtxFromSettings(repo: Repo, opts: MakeCtxOptions = {}): Promise<Ctx> {
  const [tz, name] = await Promise.all([
    opts.timeZone ? Promise.resolve(opts.timeZone) : repo.settings.get<string>(SETTINGS.timeZone),
    opts.actor ? Promise.resolve(opts.actor) : repo.settings.get<string>(SETTINGS.displayName),
  ]);
  return makeCtx(repo, { ...opts, timeZone: tz ?? undefined, actor: name ?? undefined });
}

/** A context for a sub-action (e.g. one project of "Sync all"), sharing actor, clock and day. */
export function childCtx(ctx: Ctx, patch: { opId: string; source?: EventSource; correlationId?: string }): Ctx {
  return { ...ctx, opId: patch.opId, source: patch.source ?? ctx.source, correlationId: patch.correlationId ?? ctx.correlationId };
}

/** A fresh id for edges and batches (never derived from user input). */
export function newId(): string {
  return randomUUID();
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

/** Event types written by the services. */
export const EV = {
  projectCreated: "project.created",
  projectUpdated: "project.updated",
  projectCodeChanged: "project.code_changed",
  projectArchived: "project.archived",
  projectRestored: "project.restored",
  projectSynced: "project.synced",
  stepValueChanged: "step.value_changed",
  stepNaChanged: "step.na_changed",
  stepFlagChanged: "step.flag_changed",
  stepDateConfirmed: "step.date_confirmed",
  stepAdded: "step.added",
  stepUpdated: "step.updated",
  stepArchived: "step.archived",
  stepRestored: "step.restored",
  edgeAdded: "edge.added",
  edgeArchived: "edge.archived",
  noteAdded: "note.added",
  noteEdited: "note.edited",
  noteArchived: "note.archived",
  noteRestored: "note.restored",
  attachmentAdded: "attachment.added",
  attachmentArchived: "attachment.archived",
  attachmentRestored: "attachment.restored",
  milestoneCreated: "milestone.created",
  milestoneUpdated: "milestone.updated",
  milestoneArchived: "milestone.archived",
  milestoneRestored: "milestone.restored",
  milestoneReordered: "milestone.reordered",
  templateEdgeAdded: "template.edge_added",
  templateEdgeArchived: "template.edge_archived",
  templateImported: "template.imported",
  templateSeeded: "template.seeded",
  templateSnapshot: "template.snapshot",
  projectFieldCreated: "project_field.created",
  projectFieldUpdated: "project_field.updated",
  projectFieldArchived: "project_field.archived",
  projectFieldRestored: "project_field.restored",
  settingsUpdated: "settings.updated",
} as const;

export type EventType = (typeof EV)[keyof typeof EV];

export interface HistoryRow {
  type: string;
  summary: string;
  projectId?: string;
  stepId?: string;
  milestoneId?: string;
  milestoneKey?: string;
  oldDisplay?: string;
  newDisplay?: string;
  data?: Record<string, unknown>;
  /** Overrides ctx.source (sync and import always log as SYSTEM). */
  source?: EventSource;
}

export interface AppendOptions {
  /**
   * The op this row belongs to (default ctx.opId). A job's final row uses the job's opId; a second row of the same
   * action (e.g. the template snapshot before an import) uses a suffixed opId such as `<opId>:snapshot`.
   */
  opId?: string;
}

/** Summary prefix for library/template events. */
export const LIBRARY_PREFIX = "Library";

/** "C0822 · <text>" */
export function summaryFor(prefix: string, text: string): string {
  return `${prefix} · ${text}`;
}

/** Max characters of a History summary (Notion title); longer summaries are cut with "…". */
const MAX_SUMMARY = 300;

function cut(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}…`;
}

/**
 * The canonical "one History row per action" helper. Appends one row unless a row with the same opId already
 * exists (a retried action never logs twice). Returns the new row, or null when it was already logged.
 */
export async function appendHistory(ctx: Ctx, row: HistoryRow, opts: AppendOptions = {}): Promise<StoredHistoryEvent | null> {
  const opId = opts.opId ?? ctx.opId;
  if (await ctx.repo.history.hasOp(opId)) return null;
  const input: HistoryAppendInput = {
    opId,
    type: row.type,
    source: row.source ?? ctx.source,
    actor: ctx.actor,
    summary: cut(row.summary, MAX_SUMMARY),
    occurredAt: ctx.now,
    correlationId: ctx.correlationId ?? ctx.opId,
  };
  if (row.projectId) input.projectId = row.projectId;
  if (row.stepId) input.stepId = row.stepId;
  if (row.milestoneId) input.milestoneId = row.milestoneId;
  if (row.milestoneKey) input.milestoneKey = row.milestoneKey;
  if (row.oldDisplay !== undefined) input.oldDisplay = row.oldDisplay;
  if (row.newDisplay !== undefined) input.newDisplay = row.newDisplay;
  if (row.data) input.data = dropUndefined(row.data);
  if (ctx.externalRef) input.externalRef = ctx.externalRef;
  return ctx.repo.history.append(input);
}

/** True when this op was already logged (the action finished before). */
export function alreadyLogged(ctx: Ctx, opId: string = ctx.opId): Promise<boolean> {
  return ctx.repo.history.hasOp(opId);
}

/** How long a created row may be an interrupted attempt of the same action (see findUnloggedCreate). */
export const ADOPT_WINDOW_MS = 15 * 60_000;

/**
 * Creates without an idempotency key (notes, links, files) write the row first and the History row after it. When an
 * attempt crashed in between, its row exists but no History row refers to it. Among `candidates` (rows with the same
 * content), returns the newest one created in the last 15 minutes that no recent History row of `type` refers to
 * (through `data[refKey]`), so the retry adopts it instead of creating a duplicate. A row that was logged is never
 * adopted, so adding the same note twice on purpose still creates two notes.
 */
export async function findUnloggedCreate<T extends { id: string; createdAt?: Iso }>(
  ctx: Ctx,
  candidates: T[],
  where: { projectId?: string; type: string; refOf: (e: StoredHistoryEvent) => unknown },
): Promise<T | undefined> {
  const now = Date.parse(ctx.now);
  // Rows without a creation time (project fields) can't be windowed; same-content duplicates of those are never wanted.
  const recent = candidates.filter((c) => !c.createdAt || Math.abs(now - Date.parse(c.createdAt)) <= ADOPT_WINDOW_MS);
  if (recent.length === 0) return undefined;
  const query = { type: where.type, limit: 100 };
  const page = where.projectId ? await ctx.repo.history.listByProject(where.projectId, query) : await ctx.repo.history.listAll(query);
  const logged = new Set(page.items.map(where.refOf));
  const at = (c: T) => c.createdAt ?? "";
  return recent
    .filter((c) => !logged.has(c.id))
    .sort((a, b) => (at(a) < at(b) ? -1 : at(a) > at(b) ? 1 : 0))
    .pop();
}

/** `data[key]` of a History row (where creates record the id of what they created). */
export function dataRef(key: string): (e: StoredHistoryEvent) => unknown {
  return (e) => (e.data as Record<string, unknown> | undefined)?.[key];
}

/** A deterministic id for the one arrow an action adds, so a retry of the action recognises it. */
export function edgeIdForOp(opId: string): string {
  return `e:${opId}`;
}

/** JSON-safe copy without undefined members (History data and Settings values go through JSON). */
export function dropUndefined<T>(value: T): T {
  return JSON.parse(JSON.stringify(value ?? null)) as T;
}

// ---------------------------------------------------------------------------
// Small shared validators
// ---------------------------------------------------------------------------

/** Max length of names and labels (matches the template file limit, so exports stay valid). */
export const MAX_NAME_LENGTH = 500;

export function requireName(raw: unknown, what = "Name"): string {
  if (typeof raw !== "string" || !raw.trim()) throw new AppError("VALIDATION", `${what} can't be empty.`);
  const name = raw.trim().replace(/\s+/g, " ");
  if (name.length > MAX_NAME_LENGTH) {
    throw new AppError("VALIDATION", `${what} is too long (maximum ${MAX_NAME_LENGTH} characters).`);
  }
  return name;
}

export function optionalText(raw: unknown, what: string, max = 5000): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") throw new AppError("VALIDATION", `${what} must be text.`);
  const text = raw.trim();
  if (text.length > max) throw new AppError("VALIDATION", `${what} is too long (maximum ${max} characters).`);
  return text;
}

export function notFound(what: string): AppError {
  return new AppError("NOT_FOUND", `${what} was not found. It may have been removed; reload the page.`);
}
