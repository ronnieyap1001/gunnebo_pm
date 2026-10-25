/**
 * In-memory implementation of the Repo contract (src/server/repo/types.ts) for service tests.
 *
 * Faithful to the contract semantics the services rely on:
 * - every value goes through a JSON round trip (as it would through Notion's JSON properties);
 * - `ListOpts.includeArchived` filters archived rows (default: active only);
 * - `projects.findByCode` is a case-insensitive exact match, archived projects included;
 * - a patch key that is present with the value `undefined` clears that field;
 * - History: `seq` is monotonic (epoch ms * 1000 + counter), lists are newest first by seq, cursors are strings,
 *   `hash` is computed with the shared historyHash; `listByStep` also matches rows whose data.stepIds include the step
 *   (bulk actions log one row relating to many steps);
 * - attachments: `openFile` returns a data: URL; files above 4 MB are refused.
 *
 * - `discard` (a second copy a retried batch created) moves the row to `store.trash`: no list or get returns it again.
 *
 * Test helpers: `writeCount()` counts every create/update/set/append/discard; `beforeWrite` can throw to simulate a
 * crash.
 */
import { randomUUID } from "node:crypto";
import type {
  Attachment,
  Iso,
  Milestone,
  Note,
  Project,
  ProjectField,
} from "@/domain/types";
import type {
  FileDownload,
  FileInput,
  HistoryAppendInput,
  HistoryQuery,
  LinkInput,
  ListOpts,
  MilestoneInput,
  NoteInput,
  Page,
  ProjectFieldInput,
  ProjectInput,
  Repo,
  StepInput,
  StoredHistoryEvent,
  StoredStep,
} from "@/server/repo/types";
import { historyHash } from "@/server/services/historyHash";

export const MAX_FILE_BYTES = 4_000_000;

export interface MemoryRepo extends Repo {
  /** Number of write calls so far (create, update, set, append). */
  writeCount(): number;
  /** Called before every write with its name, e.g. 'steps.create'. Throw to simulate a crash. */
  beforeWrite: ((op: string) => void) | null;
  /** Raw stores, for assertions. */
  readonly store: {
    settings: Map<string, unknown>;
    milestones: Map<string, Milestone>;
    projectFields: Map<string, ProjectField>;
    projects: Map<string, Project>;
    steps: Map<string, StoredStep>;
    history: StoredHistoryEvent[];
    notes: Map<string, Note>;
    attachments: Map<string, Attachment & { bytes?: string }>;
    /** Last write-only mirrors per project / step id. */
    mirrors: Map<string, unknown>;
    /** Rows removed with `discard` (Notion's trash), by id. */
    trash: Map<string, unknown>;
  };
}

export interface MemoryRepoOptions {
  /** Clock for createdAt/updatedAt/recordedAt (default: real time). */
  clock?: () => Iso;
}

const json = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));

/** `mirrors` (readable Notion copies) are write-only: the memory repo records the last ones and never returns them. */
function stripMirrors<T extends object>(input: T, sink: Map<string, unknown>, id?: string): Omit<T, "mirrors"> {
  const { mirrors, ...rest } = input as T & { mirrors?: unknown };
  if (mirrors !== undefined && id) sink.set(id, json(mirrors));
  return rest;
}

/** Applies a patch: present-but-undefined keys are deleted. */
function applyPatch<T extends object>(row: T, patch: object): T {
  const out: Record<string, unknown> = { ...(row as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete out[k];
    else out[k] = json(v);
  }
  return out as T;
}

function filterArchived<T extends { archived?: boolean }>(rows: T[], opts?: ListOpts): T[] {
  return opts?.includeArchived ? rows : rows.filter((r) => !r.archived);
}

function page<T>(rows: T[], query?: HistoryQuery): Page<T> {
  const limit = Math.max(1, Math.min(100, query?.limit ?? 25));
  const start = query?.cursor ? Number.parseInt(query.cursor, 10) || 0 : 0;
  const items = rows.slice(start, start + limit);
  const next = start + limit < rows.length ? String(start + limit) : null;
  return { items: json(items), nextCursor: next };
}

export function createMemoryRepo(opts: MemoryRepoOptions = {}): MemoryRepo {
  const clock = opts.clock ?? (() => new Date().toISOString());
  let writes = 0;
  let lastSeq = 0;

  const store: MemoryRepo["store"] = {
    settings: new Map(),
    milestones: new Map(),
    projectFields: new Map(),
    projects: new Map(),
    steps: new Map(),
    history: [],
    notes: new Map(),
    attachments: new Map(),
    mirrors: new Map(),
    trash: new Map(),
  };

  function discardFrom<T>(map: Map<string, T>, id: string): void {
    const row = map.get(id);
    if (row === undefined) return;
    map.delete(id);
    store.trash.set(id, row);
  }

  const repo: MemoryRepo = {
    beforeWrite: null,
    writeCount: () => writes,
    store,

    settings: {
      async get<T>(key: string) {
        return json(store.settings.get(key)) as T | undefined;
      },
      async set(key, value) {
        write("settings.set");
        store.settings.set(key, json(value));
      },
      async list(prefix) {
        const out: Record<string, unknown> = {};
        for (const [k, v] of store.settings) if (!prefix || k.startsWith(prefix)) out[k] = json(v);
        return out;
      },
    },

    milestones: {
      async list(o) {
        const rows = [...store.milestones.values()].sort((a, b) => a.order - b.order);
        return json(filterArchived(rows, o));
      },
      async get(id) {
        return json(store.milestones.get(id) ?? null);
      },
      async create(input: MilestoneInput) {
        write("milestones.create");
        const now = clock();
        const row: Milestone = { ...json(input), id: randomUUID(), createdAt: now, updatedAt: now };
        store.milestones.set(row.id, row);
        return json(row);
      },
      async update(id, patch) {
        write("milestones.update");
        const row = must(store.milestones.get(id), "milestone", id);
        const next = { ...applyPatch(row, patch), id, updatedAt: clock() };
        store.milestones.set(id, next);
        return json(next);
      },
      async discard(id) {
        write("milestones.discard");
        discardFrom(store.milestones, id);
      },
    },

    projectFields: {
      async list(o) {
        const rows = [...store.projectFields.values()].sort((a, b) => a.order - b.order);
        return json(filterArchived(rows, o));
      },
      async create(input: ProjectFieldInput) {
        write("projectFields.create");
        const row: ProjectField = { ...json(input), id: randomUUID() };
        store.projectFields.set(row.id, row);
        return json(row);
      },
      async update(id, patch) {
        write("projectFields.update");
        const row = must(store.projectFields.get(id), "project field", id);
        const next = { ...applyPatch(row, patch), id };
        store.projectFields.set(id, next);
        return json(next);
      },
      async discard(id) {
        write("projectFields.discard");
        discardFrom(store.projectFields, id);
      },
    },

    projects: {
      async list(o) {
        const rows = [...store.projects.values()].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
        return json(filterArchived(rows, o));
      },
      async get(id) {
        return json(store.projects.get(id) ?? null);
      },
      async findByCode(code) {
        const c = code.trim().toLowerCase();
        for (const p of store.projects.values()) if (p.code.toLowerCase() === c) return json(p);
        return null;
      },
      async create(input: ProjectInput) {
        write("projects.create");
        const now = clock();
        const id = randomUUID();
        const row: Project = { ...json(stripMirrors(input, store.mirrors, id)), id, createdAt: now, updatedAt: now };
        store.projects.set(row.id, row);
        return json(row);
      },
      async update(id, patch) {
        write("projects.update");
        const row = must(store.projects.get(id), "project", id);
        const next = { ...applyPatch(row, stripMirrors(patch, store.mirrors, id)), id, updatedAt: clock() };
        store.projects.set(id, next);
        return json(next);
      },
    },

    steps: {
      async listByProject(projectId, o) {
        const rows = [...store.steps.values()]
          .filter((s) => s.projectId === projectId)
          .sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1));
        return json(filterArchived(rows, o));
      },
      async get(id) {
        return json(store.steps.get(id) ?? null);
      },
      async create(input: StepInput) {
        write("steps.create");
        const now = clock();
        const id = randomUUID();
        const row: StoredStep = { ...json(stripMirrors(input, store.mirrors, id)), id, createdAt: now, updatedAt: now };
        store.steps.set(row.id, row);
        return json(row);
      },
      async update(id, patch) {
        write("steps.update");
        const row = must(store.steps.get(id), "step", id);
        const next = { ...applyPatch(row, stripMirrors(patch, store.mirrors, id)), id, updatedAt: clock() };
        store.steps.set(id, next);
        return json(next);
      },
      async discard(id) {
        write("steps.discard");
        discardFrom(store.steps, id);
      },
    },

    history: {
      async append(event: HistoryAppendInput) {
        write("history.append");
        const recordedAt = clock();
        const seq = Math.max(lastSeq + 1, Date.parse(recordedAt) * 1000);
        lastSeq = seq;
        const base = json(event);
        const row: StoredHistoryEvent = { ...base, id: randomUUID(), recordedAt, seq };
        row.hash = historyHash({ ...base, seq });
        store.history.push(row);
        return json(row);
      },
      async hasOp(opId) {
        return store.history.some((e) => e.opId === opId);
      },
      async listByStep(stepId, query) {
        return page(
          select(query).filter((e) => e.stepId === stepId || stepIdsOf(e).includes(stepId)),
          query,
        );
      },
      async listByProject(projectId, query) {
        return page(
          select(query).filter((e) => e.projectId === projectId),
          query,
        );
      },
      async listAll(query) {
        return page(select(query), query);
      },
    },

    notes: {
      async listByProject(projectId, o) {
        const rows = [...store.notes.values()]
          .filter((n) => n.projectId === projectId)
          .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
        return json(filterArchived(rows, o));
      },
      async create(input: NoteInput) {
        write("notes.create");
        const row: Note = { ...json(input), id: randomUUID(), createdAt: clock() };
        store.notes.set(row.id, row);
        return json(row);
      },
      async update(id, patch) {
        write("notes.update");
        const row = must(store.notes.get(id), "note", id);
        const next = { ...applyPatch(row, patch), id };
        store.notes.set(id, next);
        return json(next);
      },
    },

    attachments: {
      async listByProject(projectId, o) {
        const rows = [...store.attachments.values()]
          .filter((a) => a.projectId === projectId)
          .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
          .map(publicAttachment);
        return json(filterArchived(rows, o));
      },
      async get(id) {
        const row = store.attachments.get(id);
        return row ? json(publicAttachment(row)) : null;
      },
      async createLink(input: LinkInput) {
        write("attachments.createLink");
        const row: Attachment = {
          id: randomUUID(),
          projectId: input.projectId,
          kind: "LINK",
          name: input.name,
          url: input.url,
          archived: false,
          createdAt: clock(),
        };
        if (input.stepId) row.stepId = input.stepId;
        store.attachments.set(row.id, row);
        return json(row);
      },
      async createFile(input: FileInput) {
        if (input.size > MAX_FILE_BYTES) throw new Error("File too large (max 4 MB).");
        const buf = Buffer.from(await input.data.arrayBuffer());
        if (buf.byteLength > MAX_FILE_BYTES) throw new Error("File too large (max 4 MB).");
        write("attachments.createFile");
        const row: Attachment & { bytes?: string } = {
          id: randomUUID(),
          projectId: input.projectId,
          kind: "FILE",
          name: input.name,
          size: buf.byteLength,
          contentType: input.contentType,
          archived: false,
          createdAt: clock(),
          bytes: buf.toString("base64"),
        };
        if (input.stepId) row.stepId = input.stepId;
        store.attachments.set(row.id, row);
        return json(publicAttachment(row));
      },
      async update(id, patch) {
        write("attachments.update");
        const row = must(store.attachments.get(id), "attachment", id);
        const next = { ...applyPatch(row, patch), id };
        store.attachments.set(id, next);
        return json(publicAttachment(next));
      },
      async openFile(id): Promise<FileDownload> {
        const row = must(store.attachments.get(id), "attachment", id);
        if (row.kind !== "FILE") throw new Error("Not a file.");
        const type = row.contentType || "application/octet-stream";
        const out: FileDownload = { url: `data:${type};base64,${row.bytes ?? ""}`, name: row.name, contentType: type };
        if (row.size !== undefined) out.size = row.size;
        return out;
      },
    },
  };

  function write(op: string) {
    repo.beforeWrite?.(op);
    writes++;
  }

  function select(query?: HistoryQuery): StoredHistoryEvent[] {
    return [...store.history]
      .filter((e) => (!query?.type || e.type === query.type) && (!query?.source || e.source === query.source))
      .sort((a, b) => b.seq - a.seq);
  }

  return repo;
}

function stepIdsOf(e: StoredHistoryEvent): string[] {
  const ids = (e.data as { stepIds?: unknown } | undefined)?.stepIds;
  return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : [];
}

function publicAttachment(row: Attachment & { bytes?: string }): Attachment {
  const { bytes: _bytes, ...rest } = row;
  return rest;
}

function must<T>(row: T | undefined, what: string, id: string): T {
  if (!row) throw new Error(`Unknown ${what} ${id}`);
  return row;
}
