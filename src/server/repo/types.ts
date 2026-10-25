/**
 * Storage contract. Services depend only on this interface; the Notion implementation (and its fake) provide it.
 * Keep this file free of Notion types so storage can be swapped (e.g. Postgres) without touching services or screens.
 */
import type {
  Attachment,
  EventSource,
  HistoryEvent,
  Iso,
  Milestone,
  Note,
  Project,
  ProjectField,
  State,
  Step,
} from "@/domain/types";

export interface ListOpts {
  includeArchived?: boolean;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** A step as stored: the domain Step plus idempotency fields. */
export interface StoredStep extends Step {
  /** `<projectId>:<milestoneId or tempId>`. Unique per project; used to make creation batches idempotent. */
  stepKey: string;
  /** opId of the last write applied to this step (repeated writes with the same opId are skipped). */
  lastOp?: string;
}

/**
 * Readable copies written next to a project for people browsing Notion (write-only; the app never reads them).
 * Customer / Project type become select options (commas are replaced by " ·").
 */
export interface ProjectMirrors {
  customer?: string | null;
  projectType?: string | null;
  /** e.g. "SITA · AFL-Compact × 24 · Heathrow T5". */
  summary?: string;
  /** Names of the current milestones. */
  current?: string;
}

/** Readable copies written next to a step (write-only). Without them the repo writes a simple fallback. */
export interface StepMirrors {
  /** Derived state (the app always re-derives it; this only colours the Notion State column). */
  state?: State;
  /** Formatted value, e.g. "Full PO" or "12 Nov 2026". */
  display?: string;
}

export type MilestoneInput = Omit<Milestone, "id" | "createdAt" | "updatedAt">;
export type ProjectFieldInput = Omit<ProjectField, "id">;
export type ProjectInput = Omit<Project, "id" | "createdAt" | "updatedAt"> & { mirrors?: ProjectMirrors };
export type StepInput = Omit<StoredStep, "id" | "createdAt" | "updatedAt"> & { mirrors?: StepMirrors };
export type NoteInput = Omit<Note, "id" | "createdAt">;

export interface HistoryAppendInput extends Omit<HistoryEvent, "id" | "recordedAt"> {
  /** The user action this event belongs to. Used to keep retried batches from logging twice. */
  opId: string;
}

export interface StoredHistoryEvent extends HistoryEvent {
  opId?: string;
  /** Monotonic ordering key: epoch ms * 1000 + counter. */
  seq: number;
  /** sha256 of the canonical row content at write time (tamper-evidence). */
  hash?: string;
}

export interface HistoryQuery {
  limit?: number;
  cursor?: string | null;
  type?: string;
  source?: EventSource;
}

export interface LinkInput {
  projectId: string;
  stepId?: string;
  name: string;
  url: string;
}

export interface FileInput {
  projectId: string;
  stepId?: string;
  name: string;
  contentType: string;
  size: number;
  data: Blob;
}

export interface FileDownload {
  /** Short-lived signed URL (about 1 hour). Never cache it. */
  url: string;
  name: string;
  contentType?: string;
  size?: number;
  /**
   * The file is an external link someone added in Notion, not a file stored in Notion: redirect to it, never fetch
   * it on the server (it could point anywhere, including internal addresses).
   */
  external?: boolean;
}

export interface Repo {
  settings: {
    /**
     * `fresh`: the value as Notion has it now. A row found through a query is read again by its page id (a query can
     * return an older copy, or miss a row written moments ago by another server instance).
     */
    get<T = unknown>(key: string, opts?: { fresh?: boolean }): Promise<T | undefined>;
    set(key: string, value: unknown): Promise<void>;
    /** All settings whose key starts with `prefix` (all when omitted). */
    list(prefix?: string): Promise<Record<string, unknown>>;
  };

  milestones: {
    list(opts?: ListOpts): Promise<Milestone[]>;
    get(id: string): Promise<Milestone | null>;
    create(input: MilestoneInput): Promise<Milestone>;
    update(id: string, patch: Partial<MilestoneInput>): Promise<Milestone>;
    /** Removes a second copy a retried batch created (see `steps.discard`). */
    discard(id: string): Promise<void>;
  };

  projectFields: {
    list(opts?: ListOpts): Promise<ProjectField[]>;
    create(input: ProjectFieldInput): Promise<ProjectField>;
    update(id: string, patch: Partial<ProjectFieldInput>): Promise<ProjectField>;
    /** Removes a second copy a retried batch created (see `steps.discard`). */
    discard(id: string): Promise<void>;
  };

  projects: {
    /** Portfolio-friendly list. Must not need one request per project. */
    list(opts?: ListOpts): Promise<Project[]>;
    get(id: string): Promise<Project | null>;
    /** Case-insensitive exact match on code, archived projects included. */
    findByCode(code: string): Promise<Project | null>;
    create(input: ProjectInput): Promise<Project>;
    update(id: string, patch: Partial<ProjectInput>): Promise<Project>;
  };

  steps: {
    listByProject(projectId: string, opts?: ListOpts): Promise<StoredStep[]>;
    get(id: string): Promise<StoredStep | null>;
    create(input: StepInput): Promise<StoredStep>;
    update(id: string, patch: Partial<StepInput>): Promise<StoredStep>;
    /**
     * Removes a second copy of a row that a retried batch created because a lagging query did not show the first
     * one. Never a hard delete: Notion keeps it in its trash for 30 days. The app never lists or reads it again.
     */
    discard(id: string): Promise<void>;
  };

  history: {
    append(event: HistoryAppendInput): Promise<StoredHistoryEvent>;
    /** True when at least one event with this opId exists. */
    hasOp(opId: string): Promise<boolean>;
    listByStep(stepId: string, query?: HistoryQuery): Promise<Page<StoredHistoryEvent>>;
    listByProject(projectId: string, query?: HistoryQuery): Promise<Page<StoredHistoryEvent>>;
    /** Library/template events (no project) and everything else, newest first. */
    listAll(query?: HistoryQuery): Promise<Page<StoredHistoryEvent>>;
  };

  notes: {
    listByProject(projectId: string, opts?: ListOpts): Promise<Note[]>;
    create(input: NoteInput): Promise<Note>;
    update(id: string, patch: Partial<NoteInput> & { editedAt?: Iso }): Promise<Note>;
  };

  attachments: {
    listByProject(projectId: string, opts?: ListOpts): Promise<Attachment[]>;
    get(id: string): Promise<Attachment | null>;
    createLink(input: LinkInput): Promise<Attachment>;
    /** Uploads the bytes to storage and creates the row. Max 4 MB (checked by caller and here). */
    createFile(input: FileInput): Promise<Attachment>;
    update(id: string, patch: { name?: string; archived?: boolean; archivedAt?: Iso }): Promise<Attachment>;
    openFile(id: string): Promise<FileDownload>;
  };
}

// ---------------------------------------------------------------------------
// Setup / administration (Notion-specific details stay behind this interface)
// ---------------------------------------------------------------------------

export type StorageMode = "notion" | "fake" | "unconfigured";

export interface SetupStatus {
  mode: StorageMode;
  /** Plain-English explanation when something blocks the app. */
  problems: string[];
  /** Non-blocking notes (e.g. two databases that look like the same app database). */
  warnings?: string[];
  parentPage?: { id: string; title: string; url?: string };
  databases: { name: string; ok: boolean }[];
  /** All databases exist and the schema registry is complete. */
  schemaReady: boolean;
  /** Settings key 'seed.appliedAt' is present. */
  seeded: boolean;
  /**
   * Why Notion could not be read: 'tokenRejected' (Notion refused NOTION_TOKEN) or 'busy' (Notion was busy or did not
   * answer; try again). Undefined when Notion answered.
   */
  errorKind?: "tokenRejected" | "busy";
}

export interface SetupStepResult {
  done: boolean;
  /** e.g. "Created database Steps (5 of 8)". */
  message: string;
}

export interface StorageAdmin {
  status(): Promise<SetupStatus>;
  /** Creates the next missing database (or finishes schema work). Call repeatedly until done. Idempotent. */
  runSchemaStep(): Promise<SetupStepResult>;
  /** Clears cached ids (after errors or a reset). */
  resetCaches(): Promise<void>;
  /** Moves all app databases to the trash (Start over). */
  trashAll(): Promise<void>;
  /** Pages through every data source; used by the full backup download. */
  exportPage(database: string, cursor: string | null): Promise<{ rows: unknown[]; nextCursor: string | null }>;
  databaseNames(): string[];
}
