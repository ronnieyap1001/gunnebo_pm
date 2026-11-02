import "server-only";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { APIErrorCode, APIResponseError } from "@notionhq/client";
import type {
  ChildDatabaseBlockObjectResponse,
  ChildPageBlockObjectResponse,
  DatabaseObjectResponse,
  DataSourceObjectResponse,
  FileUploadObjectResponse,
  ListBlockChildrenResponse,
  PageObjectResponse,
  QueryDataSourceResponse,
  RichTextItemResponse,
  SearchResponse,
} from "@notionhq/client";
import type {
  BlockChildrenListArgs,
  DatabaseCreateArgs,
  DatabaseUpdateArgs,
  DataSourceUpdateArgs,
  FileUploadCreateArgs,
  FileUploadSendArgs,
  NotionLike,
  PageCreateArgs,
  PageUpdateArgs,
  QueryArgs,
  SearchArgs,
} from "./client";

/**
 * In-memory Notion with the same request and response shapes as @notionhq/client 5.28.0
 * (API version 2025-09-03), implementing only what the app uses. It enforces Notion's limits so
 * that bugs show up in tests rather than in production:
 *
 * - 2,000 characters per rich text item, 100 items per array, 100 relation ids per write,
 *   500 KB per request body, page_size ≤ 100 (cursor pagination), 10,000 results per query;
 * - relation values in responses truncated to 25 with `has_more`;
 * - select names without commas, unknown options auto-created without colour;
 * - filters nested at most 2 levels; created_time / last_edited_time truncated to the minute;
 * - date-times returned as `…+00:00`; property ids URL-encoded like Notion's;
 * - the name of a dual relation's back-property is NOT taken from `synced_property_name`
 *   (undocumented in Notion), so the app must rename it.
 *
 * Optional fault injection (429 with Retry-After, 409, 5xx, 503-after-commit) and latency for tests.
 * The fake models the network *after* the SDK's own retries: an injected 429 is thrown once.
 */

// ---------------------------------------------------------------------------
// Stored state (JSON-serialisable; persisted to a file when `file` is set)
// ---------------------------------------------------------------------------

type SelectColor = "default" | "gray" | "brown" | "orange" | "yellow" | "green" | "blue" | "purple" | "pink" | "red";

type Parent =
  | { type: "workspace"; workspace: true }
  | { type: "page_id"; page_id: string }
  | { type: "data_source_id"; data_source_id: string; database_id: string };

interface SelectOption {
  id: string;
  name: string;
  color: SelectColor;
  description: string | null;
}

interface RelationConfig {
  database_id: string;
  data_source_id: string;
  type: "single_property" | "dual_property";
  synced_property_id?: string;
  synced_property_name?: string;
}

interface FakeProp {
  id: string;
  name: string;
  type: string;
  description: string | null;
  select?: { options: SelectOption[] };
  number?: { format: string };
  relation?: RelationConfig;
}

type StoredFile = { name: string; upload_id: string } | { name: string; external: string };

type StoredValue =
  | { type: "title"; title: RichTextItemResponse[] }
  | { type: "rich_text"; rich_text: RichTextItemResponse[] }
  | { type: "number"; number: number | null }
  | { type: "select"; select: { id: string; name: string; color: SelectColor } | null }
  | { type: "checkbox"; checkbox: boolean }
  | { type: "date"; date: { start: string; end: string | null; time_zone: string | null } | null }
  | { type: "relation"; relation: { id: string }[] }
  | { type: "url"; url: string | null }
  | { type: "files"; files: StoredFile[] };

interface FakePage {
  id: string;
  seq: number;
  parent: Parent;
  created: number;
  edited: number;
  in_trash: boolean;
  is_locked: boolean;
  values: Record<string, StoredValue>;
}

interface FakeDataSource {
  id: string;
  database_id: string;
  title: string;
  props: FakeProp[];
  created: number;
  edited: number;
  in_trash: boolean;
}

interface FakeDatabase {
  id: string;
  seq: number;
  parent_page_id: string;
  title: string;
  description: string;
  data_source_ids: string[];
  created: number;
  edited: number;
  in_trash: boolean;
  is_locked: boolean;
  is_inline: boolean;
}

interface FakeUpload {
  id: string;
  filename: string | null;
  content_type: string | null;
  status: "pending" | "uploaded" | "expired" | "failed";
  created: number;
  expires: number;
  size: number | null;
  /** base64 bytes once sent (in-memory fakes; persisted fakes keep bytes in `<file>.files/<id>`). */
  data?: string;
}

interface FakeState {
  v: 1;
  seq: number;
  pages: Record<string, FakePage>;
  databases: Record<string, FakeDatabase>;
  dataSources: Record<string, FakeDataSource>;
  uploads: Record<string, FakeUpload>;
  /** HMAC key for signed file URLs. */
  key: string;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface FaultSpec {
  /** HTTP status to fail with. */
  status: 400 | 401 | 403 | 404 | 409 | 429 | 500 | 502 | 503 | 504 | 529;
  /** Notion error code (derived from status when omitted). */
  code?: `${APIErrorCode}`;
  /** Notion's error message (default: "Injected <status> (<code>)."). */
  message?: string;
  /** Retry-After header in seconds. */
  retryAfterSec?: number;
  /** Apply the request, then fail (models a 503 whose write was already committed). */
  afterCommit?: boolean;
  /** With afterCommit on a create: put the new object's id in additional_data.committed_resource_id (default true). */
  reportCommittedId?: boolean;
  /** Only calls to this method, e.g. 'pages.update'. */
  method?: FakeMethod;
  /** How many matching calls fail (default 1). */
  count?: number;
  additional_data?: Record<string, string | string[]>;
}

export type FakeMethod =
  | "databases.create"
  | "databases.retrieve"
  | "databases.update"
  | "dataSources.retrieve"
  | "dataSources.query"
  | "dataSources.update"
  | "pages.create"
  | "pages.retrieve"
  | "pages.update"
  | "blocks.children.list"
  | "search"
  | "fileUploads.create"
  | "fileUploads.send";

export interface FakeControls {
  /** Every call made, in order. */
  readonly calls: { method: FakeMethod; args: unknown }[];
  callCount(method?: FakeMethod): number;
  resetCalls(): void;
  injectFault(spec: FaultSpec): void;
  clearFaults(): void;
  /** Highest number of calls that were in flight at once (useful with `latencyMs`). */
  readonly maxInFlight: number;
  /** Bytes of an uploaded file behind a signed URL from this fake (null when unknown or expired). */
  fileBytes(url: string): FakeFile | null;
  /** Drops everything (and the file, when persisted). */
  reset(): void;
  /** Number of stored pages (incl. trashed). */
  pageCount(): number;
}

export interface FakeFile {
  data: Uint8Array;
  contentType: string | null;
  filename: string | null;
  size: number;
}

export type FakeNotion = NotionLike & { fake: FakeControls };

export interface FakeNotionOptions {
  /** Persist to this JSON file (loaded on start, reloaded when another process changes it). */
  file?: string;
  /** Clock (ms since epoch). */
  now?: () => number;
  /** Delay every call by this many ms (for concurrency tests). */
  latencyMs?: number;
  /** Max results one query can page through (Notion: 10,000). */
  queryResultCap?: number;
  /** Max bytes per uploaded file (Notion Free: 5 MiB). */
  maxFileBytes?: number;
  /** Drop seconds from date-time values (in case Notion stores minutes only; the app must not rely on more). */
  minuteDateTimes?: boolean;
  /**
   * New pages stay invisible to dataSources.query for this long (ms of the fake clock). Notion does not document
   * that a query sees a page right after it was created, so read-after-write designs must not rely on it.
   */
  queryLagMs?: number;
  /** Return each title / rich_text value as ONE merged item (Notion may merge or re-split items on read). */
  mergeRichTextOnRead?: boolean;
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const FAKE_LIMITS = {
  textItemChars: 2000,
  arrayItems: 100,
  relationIds: 100,
  payloadBytes: 500_000,
  pageSize: 100,
  relationResponseItems: 25,
  selectNameChars: 100,
  urlChars: 2000,
  filterDepth: 2,
} as const;

const BOT = { object: "user" as const, id: "00000000-0000-4000-8000-00000000b07a" };
const FILE_HOST = "https://fake-notion.invalid";
const UNSUPPORTED_EXTENSIONS = new Set([".msg", ".eml", ".exe", ".bat", ".cmd", ".com", ".scr"]);

// Live instances, so fakeFileBytes(url) can find the bytes for the download route.
const instances = new Set<{ fileBytes(url: string): FakeFile | null }>();

/** Bytes behind a signed URL handed out by any live fake (null for real Notion URLs). */
export function fakeFileBytes(url: string): FakeFile | null {
  if (!isFakeFileUrl(url)) return null;
  for (const inst of instances) {
    const f = inst.fileBytes(url);
    if (f) return f;
  }
  return null;
}

export function isFakeFileUrl(url: string): boolean {
  return url.startsWith(`${FILE_HOST}/files/`);
}

// ---------------------------------------------------------------------------
// Errors (real APIResponseError instances, as the SDK throws them)
// ---------------------------------------------------------------------------

function apiError(
  status: number,
  code: `${APIErrorCode}`,
  message: string,
  extra: { headers?: Record<string, string>; additional_data?: Record<string, string | string[]> } = {},
): APIResponseError {
  const request_id = crypto.randomUUID();
  return new APIResponseError({
    code: code as APIErrorCode,
    status,
    message,
    headers: { "content-type": "application/json", "x-notion-request-id": request_id, ...extra.headers },
    rawBodyText: JSON.stringify({ object: "error", status, code, message, request_id, additional_data: extra.additional_data }),
    additional_data: extra.additional_data,
    request_id,
  });
}

function invalid(message: string): never {
  throw apiError(400, APIErrorCode.ValidationError, message);
}

function notFound(kind: string, id: string): never {
  throw apiError(
    404,
    APIErrorCode.ObjectNotFound,
    `Could not find ${kind} with ID: ${id}. Make sure the relevant pages and databases are shared with your integration.`,
  );
}

function codeForStatus(status: number): `${APIErrorCode}` {
  switch (status) {
    case 400:
      return APIErrorCode.ValidationError;
    case 401:
      return APIErrorCode.Unauthorized;
    case 403:
      return APIErrorCode.RestrictedResource;
    case 404:
      return APIErrorCode.ObjectNotFound;
    case 409:
      return APIErrorCode.ConflictError;
    case 429:
      return APIErrorCode.RateLimited;
    case 500:
      return APIErrorCode.InternalServerError;
    case 504:
      return APIErrorCode.GatewayTimeout;
    case 529:
      return APIErrorCode.ServiceOverload;
    default:
      return APIErrorCode.ServiceUnavailable;
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

function normId(raw: unknown, where: string): string {
  if (typeof raw !== "string" || !UUID_RE.test(raw)) {
    invalid(`path failed validation: ${where} should be a valid uuid, instead was \`${JSON.stringify(raw)}\`.`);
  }
  const hex = raw.replace(/-/g, "").toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function tryNormId(raw: unknown): string | null {
  if (typeof raw !== "string" || !UUID_RE.test(raw)) return null;
  return normId(raw, "id");
}

function minuteIso(ms: number): string {
  return new Date(Math.floor(ms / 60_000) * 60_000).toISOString();
}

function slug(title: string): string {
  const s = title
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return s || "Untitled";
}

function pageUrl(title: string, id: string): string {
  return `https://www.notion.so/${slug(title)}-${id.replace(/-/g, "")}`;
}

function richText(content: string): RichTextItemResponse[] {
  if (!content) return [];
  return [
    {
      type: "text",
      text: { content, link: null },
      annotations: { ...DEFAULT_ANNOTATIONS },
      plain_text: content,
      href: null,
    },
  ];
}

const DEFAULT_ANNOTATIONS = {
  bold: false,
  italic: false,
  strikethrough: false,
  underline: false,
  code: false,
  color: "default" as const,
};

function plain(items: readonly RichTextItemResponse[]): string {
  return items.map((i) => i.plain_text).join("");
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const PROP_ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789:;<=>?@[]^_`{|}~";

function randomPropId(taken: Set<string>): string {
  for (;;) {
    let raw = "";
    for (let i = 0; i < 4; i++) raw += PROP_ID_ALPHABET[crypto.randomInt(PROP_ID_ALPHABET.length)];
    const id = encodeURIComponent(raw);
    if (id !== "title" && !taken.has(id)) return id;
  }
}

function sameId(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    return decodeURIComponent(a) === decodeURIComponent(b);
  } catch {
    return false;
  }
}

const DATE_RE = /^(\d{4}-\d{2}-\d{2})(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?)?$/;

/** Date-only stays 'YYYY-MM-DD'; a date-time comes back as 'YYYY-MM-DDTHH:mm:ss.sss+00:00' (UTC). */
function normDate(v: unknown, where: string, minutePrecision = false): string {
  if (typeof v !== "string" || !DATE_RE.test(v)) invalid(`${where} should be an ISO 8601 date or date-time, instead was \`${JSON.stringify(v)}\`.`);
  if (!v.includes("T")) return v;
  let ms = Date.parse(/Z|[+-]\d{2}:\d{2}$/.test(v) ? v : `${v}Z`);
  if (Number.isNaN(ms)) invalid(`${where} is not a valid date-time.`);
  if (minutePrecision) ms = Math.floor(ms / 60_000) * 60_000;
  return new Date(ms).toISOString().replace("Z", "+00:00");
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

function emptyState(): FakeState {
  return { v: 1, seq: 0, pages: {}, databases: {}, dataSources: {}, uploads: {}, key: crypto.randomBytes(16).toString("hex") };
}

export function createFakeNotion(opts: FakeNotionOptions = {}): FakeNotion {
  const now = opts.now ?? (() => Date.now());
  const cap = opts.queryResultCap ?? 10_000;
  const maxFileBytes = opts.maxFileBytes ?? 5 * 1024 * 1024;
  const file = opts.file;
  let state: FakeState = emptyState();
  let fileMtime = 0;

  const calls: { method: FakeMethod; args: unknown }[] = [];
  let faults: (FaultSpec & { left: number })[] = [];
  let inFlight = 0;
  let maxInFlight = 0;

  // -- persistence --------------------------------------------------------
  function load(): void {
    if (!file || !fs.existsSync(/*turbopackIgnore: true*/ file)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(/*turbopackIgnore: true*/ file, "utf8")) as FakeState;
      if (parsed && parsed.v === 1) state = parsed;
      fileMtime = fs.statSync(/*turbopackIgnore: true*/ file).mtimeMs;
    } catch (e) {
      throw new Error(`Fake Notion: could not read ${file} (${(e as Error).message}). Delete it to start over.`);
    }
  }
  function reloadIfChanged(): void {
    if (!file || !fs.existsSync(/*turbopackIgnore: true*/ file)) return;
    const m = fs.statSync(/*turbopackIgnore: true*/ file).mtimeMs;
    if (m !== fileMtime) load();
  }
  function persist(): void {
    if (!file) return;
    fs.mkdirSync(/*turbopackIgnore: true*/ path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(/*turbopackIgnore: true*/ tmp, JSON.stringify(state));
    fs.renameSync(/*turbopackIgnore: true*/ tmp, file);
    fileMtime = fs.statSync(/*turbopackIgnore: true*/ file).mtimeMs;
  }
  load();

  // Uploaded bytes: next to the JSON file when persisted (keeps the JSON small), else base64 in memory.
  const filesDir = file ? `${file}.files` : undefined;
  function writeBytes(up: FakeUpload, buf: Buffer): void {
    if (!filesDir) {
      up.data = buf.toString("base64");
      return;
    }
    fs.mkdirSync(/*turbopackIgnore: true*/ filesDir, { recursive: true });
    fs.writeFileSync(/*turbopackIgnore: true*/ path.join(filesDir, `${up.id}.bin`), buf);
  }
  function readBytes(up: FakeUpload): Buffer | null {
    if (up.data !== undefined) return Buffer.from(up.data, "base64");
    if (!filesDir) return null;
    const p = path.join(filesDir, `${up.id}.bin`);
    return fs.existsSync(/*turbopackIgnore: true*/ p) ? fs.readFileSync(/*turbopackIgnore: true*/ p) : null;
  }

  const nextSeq = () => ++state.seq;

  // -- lookups -------------------------------------------------------------
  function getPage(id: string): FakePage {
    const p = state.pages[id];
    if (!p) notFound("page", id);
    return p;
  }
  function getDb(id: string): FakeDatabase {
    const d = state.databases[id];
    if (!d) notFound("database", id);
    return d;
  }
  function getDs(id: string): FakeDataSource {
    const d = state.dataSources[id];
    if (!d) notFound("data source", id);
    return d;
  }
  function liveDs(id: string): FakeDataSource {
    const ds = getDs(id);
    if (ds.in_trash) notFound("data source", id);
    return ds;
  }
  function findProp(ds: FakeDataSource, nameOrId: string): FakeProp | undefined {
    return ds.props.find((p) => sameId(p.id, nameOrId)) ?? ds.props.find((p) => p.name === nameOrId);
  }

  const PAGE_TITLE_PROP: FakeProp = { id: "title", name: "title", type: "title", description: null };
  function schemaOf(page: FakePage): FakeProp[] {
    if (page.parent.type === "data_source_id") return getDs(page.parent.data_source_id).props;
    return [PAGE_TITLE_PROP];
  }
  function pageTitle(page: FakePage): string {
    const t = schemaOf(page).find((p) => p.type === "title");
    const v = t ? page.values[t.id] : undefined;
    return v && v.type === "title" ? plain(v.title) : "";
  }

  // -- signed file URLs ----------------------------------------------------
  function sign(uploadId: string, expires: number): string {
    return crypto.createHmac("sha256", state.key).update(`${uploadId}:${expires}`).digest("hex").slice(0, 32);
  }
  function signedUrl(upload: FakeUpload, name: string): { url: string; expiry_time: string } {
    const expires = now() + 3_600_000;
    const url = `${FILE_HOST}/files/${upload.id}/${encodeURIComponent(name)}?expires=${expires}&sig=${sign(upload.id, expires)}`;
    return { url, expiry_time: new Date(expires).toISOString() };
  }
  function parseFileUrl(url: string): { uploadId: string; expires: number; sig: string } | null {
    if (!isFakeFileUrl(url)) return null;
    try {
      const u = new URL(url);
      const parts = u.pathname.split("/");
      const uploadId = parts[2];
      const expires = Number(u.searchParams.get("expires"));
      const sig = u.searchParams.get("sig") ?? "";
      if (!uploadId || !Number.isFinite(expires)) return null;
      return { uploadId, expires, sig };
    } catch {
      return null;
    }
  }
  function fileBytes(url: string): FakeFile | null {
    reloadIfChanged();
    const parsed = parseFileUrl(url);
    if (!parsed) return null;
    const up = state.uploads[parsed.uploadId];
    if (!up || up.status !== "uploaded") return null;
    if (parsed.sig !== sign(up.id, parsed.expires) || parsed.expires < now()) return null;
    const bytes = readBytes(up);
    if (!bytes) return null;
    const data = new Uint8Array(bytes);
    return { data, contentType: up.content_type, filename: up.filename, size: data.byteLength };
  }

  // -- request validation ---------------------------------------------------
  function toRichText(items: unknown, where: string): RichTextItemResponse[] {
    if (!Array.isArray(items)) invalid(`${where} should be an array, instead was \`${JSON.stringify(items)}\`.`);
    if (items.length > FAKE_LIMITS.arrayItems) {
      invalid(`${where}.length should be ≤ \`${FAKE_LIMITS.arrayItems}\`, instead was \`${items.length}\`.`);
    }
    return items.map((it: unknown, i): RichTextItemResponse => {
      if (!isObject(it)) invalid(`${where}[${i}] should be an object.`);
      if (it.type !== undefined && it.type !== "text") invalid(`${where}[${i}].type: the fake supports only text items.`);
      const text = it.text;
      if (!isObject(text) || typeof text.content !== "string") invalid(`${where}[${i}].text.content should be a string.`);
      const content = text.content;
      if (content.length > FAKE_LIMITS.textItemChars) {
        invalid(`${where}[${i}].text.content.length should be ≤ \`${FAKE_LIMITS.textItemChars}\`, instead was \`${content.length}\`.`);
      }
      if (content.length === 0) invalid(`${where}[${i}].text.content should not be empty.`);
      const link = isObject(text.link) && typeof text.link.url === "string" ? text.link.url : null;
      const ann = isObject(it.annotations) ? it.annotations : {};
      return {
        type: "text",
        text: { content, link: link ? { url: link } : null },
        annotations: { ...DEFAULT_ANNOTATIONS, ...(ann as object) } as RichTextItemResponse["annotations"],
        plain_text: content,
        href: link,
      };
    });
  }

  function valueKey(raw: Record<string, unknown>): string | undefined {
    return Object.keys(raw).find((k) => k !== "type" && k !== "id" && k !== "name");
  }

  /** Validates one property write and returns the stored value (no state changes except new select options). */
  function parseValue(
    prop: FakeProp,
    raw: unknown,
    where: string,
    pendingOptions: { prop: FakeProp; option: SelectOption }[],
  ): StoredValue {
    if (!isObject(raw)) invalid(`${where} should be an object.`);
    const key = valueKey(raw);
    if (key !== prop.type) {
      invalid(`${prop.name} is expected to be ${prop.type}.${key ? ` (got ${key})` : ""}`);
    }
    const v = raw[key];
    switch (prop.type) {
      case "title":
        return { type: "title", title: toRichText(v, `${where}.title`) };
      case "rich_text":
        return { type: "rich_text", rich_text: toRichText(v, `${where}.rich_text`) };
      case "number":
        if (v !== null && (typeof v !== "number" || !Number.isFinite(v))) invalid(`${where}.number should be a number or null.`);
        return { type: "number", number: v as number | null };
      case "checkbox":
        if (typeof v !== "boolean") invalid(`${where}.checkbox should be a boolean.`);
        return { type: "checkbox", checkbox: v };
      case "url":
        if (v === null) return { type: "url", url: null };
        if (typeof v !== "string" || v.length === 0) invalid(`${where}.url should be a non-empty string or null.`);
        if (v.length > FAKE_LIMITS.urlChars) invalid(`${where}.url.length should be ≤ \`${FAKE_LIMITS.urlChars}\`.`);
        return { type: "url", url: v };
      case "date": {
        if (v === null) return { type: "date", date: null };
        if (!isObject(v)) invalid(`${where}.date should be an object or null.`);
        const start = normDate(v.start, `${where}.date.start`, opts.minuteDateTimes);
        const end = v.end === undefined || v.end === null ? null : normDate(v.end, `${where}.date.end`, opts.minuteDateTimes);
        const tz = typeof v.time_zone === "string" ? v.time_zone : null;
        return { type: "date", date: { start, end, time_zone: tz } };
      }
      case "select": {
        if (v === null) return { type: "select", select: null };
        if (!isObject(v)) invalid(`${where}.select should be an object or null.`);
        const options = prop.select?.options ?? [];
        if (typeof v.id === "string") {
          const o = options.find((x) => x.id === v.id) ?? pendingOptions.find((x) => x.prop === prop && x.option.id === v.id)?.option;
          if (!o) invalid(`${where}.select.id: no option with id ${v.id}.`);
          return { type: "select", select: { id: o.id, name: o.name, color: o.color } };
        }
        if (typeof v.name !== "string" || v.name.trim() === "") invalid(`${where}.select.name should be a non-empty string.`);
        const name = v.name;
        if (name.includes(",")) invalid(`Invalid select option, commas not allowed: ${name}`);
        if (name.length > FAKE_LIMITS.selectNameChars) invalid(`${where}.select.name.length should be ≤ \`${FAKE_LIMITS.selectNameChars}\`.`);
        let o = options.find((x) => x.name === name) ?? pendingOptions.find((x) => x.prop === prop && x.option.name === name)?.option;
        if (!o) {
          o = { id: crypto.randomBytes(4).toString("hex"), name, color: "default", description: null };
          pendingOptions.push({ prop, option: o });
        }
        return { type: "select", select: { id: o.id, name: o.name, color: o.color } };
      }
      case "relation": {
        if (!Array.isArray(v)) invalid(`${where}.relation should be an array.`);
        if (v.length > FAKE_LIMITS.relationIds) {
          invalid(`${where}.relation.length should be ≤ \`${FAKE_LIMITS.relationIds}\`, instead was \`${v.length}\`.`);
        }
        const target = prop.relation?.data_source_id;
        const seen = new Set<string>();
        const out: { id: string }[] = [];
        v.forEach((item: unknown, i) => {
          if (!isObject(item)) invalid(`${where}.relation[${i}] should be an object.`);
          const id = normId(item.id, `${where}.relation[${i}].id`);
          const p = state.pages[id];
          if (!p || p.parent.type !== "data_source_id" || p.parent.data_source_id !== target) {
            invalid(`${where}.relation[${i}]: page ${id} is not in the related data source.`);
          }
          if (!seen.has(id)) {
            seen.add(id);
            out.push({ id });
          }
        });
        return { type: "relation", relation: out };
      }
      case "files": {
        if (!Array.isArray(v)) invalid(`${where}.files should be an array.`);
        if (v.length > FAKE_LIMITS.arrayItems) invalid(`${where}.files.length should be ≤ \`${FAKE_LIMITS.arrayItems}\`.`);
        const out: StoredFile[] = v.map((item: unknown, i): StoredFile => {
          if (!isObject(item)) invalid(`${where}.files[${i}] should be an object.`);
          const name = typeof item.name === "string" ? item.name : undefined;
          if (isObject(item.file_upload)) {
            const up = state.uploads[normId(item.file_upload.id, `${where}.files[${i}].file_upload.id`)];
            if (!up) invalid(`${where}.files[${i}]: file upload not found.`);
            if (up.status !== "uploaded") invalid(`${where}.files[${i}]: file upload is ${up.status}, expected uploaded.`);
            return { name: name ?? up.filename ?? "file", upload_id: up.id };
          }
          if (isObject(item.external) && typeof item.external.url === "string") {
            if (!name) invalid(`${where}.files[${i}].name is required for external files.`);
            return { name, external: item.external.url };
          }
          if (isObject(item.file) && typeof item.file.url === "string") {
            const parsed = parseFileUrl(item.file.url);
            const up = parsed ? state.uploads[parsed.uploadId] : undefined;
            if (!up) invalid(`${where}.files[${i}].file.url is not a Notion-hosted file.`);
            return { name: name ?? up.filename ?? "file", upload_id: up.id };
          }
          invalid(`${where}.files[${i}] should be a file_upload, external or file object.`);
        });
        return { type: "files", files: out };
      }
      default:
        invalid(`${prop.name} is a ${prop.type} property and cannot be written.`);
    }
  }

  /** Validates every property of a write; returns [propId, value] pairs and select options to add. */
  function parseProps(
    schema: FakeProp[],
    ds: FakeDataSource | null,
    properties: unknown,
  ): { values: [FakeProp, StoredValue][]; pending: { prop: FakeProp; option: SelectOption }[] } {
    const values: [FakeProp, StoredValue][] = [];
    const pending: { prop: FakeProp; option: SelectOption }[] = [];
    if (properties === undefined) return { values, pending };
    if (!isObject(properties)) invalid("body.properties should be an object.");
    for (const [k, raw] of Object.entries(properties)) {
      const prop = ds ? findProp(ds, k) : schema.find((p) => p.id === k || p.name === k);
      if (!prop) invalid(`${k} is not a property that exists.`);
      if (values.some(([p]) => p.id === prop.id)) invalid(`Property ${prop.name} was given twice.`);
      values.push([prop, parseValue(prop, raw, `body.properties.${k}`, pending)]);
    }
    return { values, pending };
  }

  /** Keeps a dual relation's other side in step with a change on `page`. */
  function syncDual(page: FakePage, prop: FakeProp, before: string[], after: string[]): void {
    const rel = prop.relation;
    if (!rel || rel.type !== "dual_property" || !rel.synced_property_id) return;
    const removed = before.filter((id) => !after.includes(id));
    const added = after.filter((id) => !before.includes(id));
    for (const otherId of [...removed, ...added]) {
      const other = state.pages[otherId];
      if (!other) continue;
      const cur = other.values[rel.synced_property_id];
      let ids = cur && cur.type === "relation" ? cur.relation.map((r) => r.id) : [];
      if (removed.includes(otherId)) ids = ids.filter((x) => x !== page.id);
      else if (!ids.includes(page.id)) ids = [...ids, page.id];
      other.values[rel.synced_property_id] = { type: "relation", relation: ids.map((id) => ({ id })) };
    }
  }

  function applyProps(page: FakePage, parsed: ReturnType<typeof parseProps>): void {
    for (const { prop, option } of parsed.pending) {
      if (!prop.select) prop.select = { options: [] };
      if (!prop.select.options.some((o) => o.name === option.name)) prop.select.options.push(option);
    }
    for (const [prop, value] of parsed.values) {
      const prev = page.values[prop.id];
      const before = prev && prev.type === "relation" ? prev.relation.map((r) => r.id) : [];
      page.values[prop.id] = value;
      if (value.type === "relation") syncDual(page, prop, before, value.relation.map((r) => r.id));
    }
  }

  // -- responses --------------------------------------------------------------
  /** Optionally merges plain items into one (which can then be longer than 2,000 characters). */
  function readItems(items: RichTextItemResponse[]): RichTextItemResponse[] {
    if (!opts.mergeRichTextOnRead || items.length < 2) return items;
    return richText(plain(items));
  }

  function valueResponse(prop: FakeProp, page: FakePage): unknown {
    const v = page.values[prop.id];
    const base = { id: prop.id, type: prop.type };
    switch (prop.type) {
      case "title":
        return { ...base, title: v && v.type === "title" ? readItems(v.title) : [] };
      case "rich_text":
        return { ...base, rich_text: v && v.type === "rich_text" ? readItems(v.rich_text) : [] };
      case "number":
        return { ...base, number: v && v.type === "number" ? v.number : null };
      case "checkbox":
        return { ...base, checkbox: v && v.type === "checkbox" ? v.checkbox : false };
      case "url":
        return { ...base, url: v && v.type === "url" ? v.url : null };
      case "date":
        return { ...base, date: v && v.type === "date" ? v.date : null };
      case "select": {
        if (!v || v.type !== "select" || !v.select) return { ...base, select: null };
        // An option removed from the schema reads as empty.
        const opt = prop.select?.options.find((o) => o.id === v.select?.id);
        return { ...base, select: opt ? { id: opt.id, name: opt.name, color: opt.color } : null };
      }
      case "relation": {
        const ids = v && v.type === "relation" ? v.relation : [];
        return {
          ...base,
          relation: ids.slice(0, FAKE_LIMITS.relationResponseItems),
          has_more: ids.length > FAKE_LIMITS.relationResponseItems,
        };
      }
      case "files": {
        const files = v && v.type === "files" ? v.files : [];
        return {
          ...base,
          files: files.map((f) => {
            if ("external" in f) return { name: f.name, type: "external", external: { url: f.external } };
            const up = state.uploads[f.upload_id];
            return up
              ? { name: f.name, type: "file", file: signedUrl(up, f.name) }
              : { name: f.name, type: "external", external: { url: `${FILE_HOST}/missing` } };
          }),
        };
      }
      case "created_time":
        return { ...base, created_time: minuteIso(page.created) };
      case "last_edited_time":
        return { ...base, last_edited_time: minuteIso(page.edited) };
      default:
        return { ...base, [prop.type]: null };
    }
  }

  function filterSet(filter: unknown, schema: FakeProp[]): Set<string> | null {
    if (!Array.isArray(filter)) return null;
    const ids = new Set<string>();
    for (const f of filter) {
      if (typeof f !== "string") continue;
      const p = schema.find((x) => sameId(x.id, f)) ?? schema.find((x) => x.name === f);
      if (p) ids.add(p.id);
    }
    return ids;
  }

  function pageResponse(page: FakePage, filterProps?: unknown): PageObjectResponse {
    const schema = schemaOf(page);
    const only = filterSet(filterProps, schema);
    const properties: Record<string, unknown> = {};
    for (const prop of schema) {
      if (only && !only.has(prop.id)) continue;
      properties[prop.name] = valueResponse(prop, page);
    }
    const parent =
      page.parent.type === "data_source_id"
        ? { type: "data_source_id" as const, data_source_id: page.parent.data_source_id, database_id: page.parent.database_id }
        : page.parent;
    return {
      object: "page",
      id: page.id,
      created_time: minuteIso(page.created),
      last_edited_time: minuteIso(page.edited),
      created_by: BOT,
      last_edited_by: BOT,
      cover: null,
      icon: null,
      parent,
      in_trash: page.in_trash,
      archived: page.in_trash,
      is_archived: page.in_trash,
      is_locked: page.is_locked,
      properties: properties as PageObjectResponse["properties"],
      url: pageUrl(pageTitle(page), page.id),
      public_url: null,
    };
  }

  function propConfigResponse(p: FakeProp): unknown {
    const base = { id: p.id, name: p.name, description: p.description, type: p.type };
    switch (p.type) {
      case "select":
        return { ...base, select: { options: p.select?.options ?? [] } };
      case "number":
        return { ...base, number: { format: p.number?.format ?? "number" } };
      case "relation": {
        const r = p.relation as RelationConfig;
        return r.type === "dual_property"
          ? {
              ...base,
              relation: {
                database_id: r.database_id,
                data_source_id: r.data_source_id,
                type: "dual_property",
                dual_property: { synced_property_id: r.synced_property_id, synced_property_name: r.synced_property_name },
              },
            }
          : {
              ...base,
              relation: { database_id: r.database_id, data_source_id: r.data_source_id, type: "single_property", single_property: {} },
            };
      }
      default:
        return { ...base, [p.type]: {} };
    }
  }

  function dsResponse(ds: FakeDataSource): DataSourceObjectResponse {
    const db = getDb(ds.database_id);
    return {
      object: "data_source",
      id: ds.id,
      title: richText(ds.title),
      description: [],
      parent: { type: "database_id", database_id: ds.database_id },
      database_parent: { type: "page_id", page_id: db.parent_page_id },
      is_inline: db.is_inline,
      database_type: null,
      in_trash: ds.in_trash,
      archived: ds.in_trash,
      created_time: minuteIso(ds.created),
      last_edited_time: minuteIso(ds.edited),
      created_by: BOT,
      last_edited_by: BOT,
      properties: Object.fromEntries(ds.props.map((p) => [p.name, propConfigResponse(p)])) as DataSourceObjectResponse["properties"],
      icon: null,
      cover: null,
      url: pageUrl(ds.title, ds.id),
      public_url: null,
    };
  }

  function dbResponse(db: FakeDatabase): DatabaseObjectResponse {
    return {
      object: "database",
      id: db.id,
      title: richText(db.title),
      description: richText(db.description),
      parent: { type: "page_id", page_id: db.parent_page_id },
      is_inline: db.is_inline,
      database_type: null,
      in_trash: db.in_trash,
      archived: db.in_trash,
      is_locked: db.is_locked,
      created_time: minuteIso(db.created),
      last_edited_time: minuteIso(db.edited),
      data_sources: db.data_source_ids.map((id) => ({ id, name: state.dataSources[id]?.title ?? "" })),
      icon: null,
      cover: null,
      url: pageUrl(db.title, db.id),
      public_url: null,
    };
  }

  function uploadResponse(u: FakeUpload): FileUploadObjectResponse {
    return {
      object: "file_upload",
      id: u.id,
      created_time: new Date(u.created).toISOString(),
      created_by: { id: BOT.id, type: "bot" },
      last_edited_time: new Date(u.created).toISOString(),
      in_trash: false,
      archived: false,
      expiry_time: u.status === "pending" ? new Date(u.expires).toISOString() : null,
      status: u.status,
      filename: u.filename,
      content_type: u.content_type,
      content_length: u.size,
      upload_url: u.status === "pending" ? `https://api.notion.com/v1/file_uploads/${u.id}/send` : undefined,
    };
  }

  // -- schema building -----------------------------------------------------
  type PendingProp = { prop: FakeProp; back?: { ds: FakeDataSource; prop: FakeProp } };

  function buildProp(ds: FakeDataSource, name: string, cfg: unknown, taken: Set<string>, where: string): PendingProp {
    if (!isObject(cfg)) invalid(`${where} should be an object.`);
    const type = (typeof cfg.type === "string" ? cfg.type : valueKey(cfg)) as string | undefined;
    if (!type) invalid(`${where}: property type is missing.`);
    if (cfg.type !== undefined && valueKey(cfg) !== undefined && valueKey(cfg) !== type && valueKey(cfg) !== "description") {
      invalid(`${where}: type ${type} does not match configuration ${valueKey(cfg)}.`);
    }
    const description = typeof cfg.description === "string" ? cfg.description : null;
    const id = type === "title" ? "title" : randomPropId(taken);
    taken.add(id);
    const prop: FakeProp = { id, name, type, description };
    switch (type) {
      case "title":
      case "rich_text":
      case "checkbox":
      case "date":
      case "url":
      case "files":
      case "created_time":
      case "last_edited_time":
        return { prop };
      case "number": {
        const c = cfg.number;
        prop.number = { format: isObject(c) && typeof c.format === "string" ? c.format : "number" };
        return { prop };
      }
      case "select": {
        const c = cfg.select;
        const opts = isObject(c) && Array.isArray(c.options) ? c.options : [];
        prop.select = { options: opts.map((o: unknown, i) => parseOption(o, `${where}.select.options[${i}]`, [])) };
        return { prop };
      }
      case "relation": {
        const c = cfg.relation;
        if (!isObject(c)) invalid(`${where}.relation should be an object.`);
        const targetId = normId(c.data_source_id, `${where}.relation.data_source_id`);
        const target = targetId === ds.id ? ds : liveDs(targetId);
        const dual = c.type === "dual_property" || (c.type === undefined && isObject(c.dual_property));
        prop.relation = { database_id: target.database_id, data_source_id: target.id, type: dual ? "dual_property" : "single_property" };
        if (!dual) return { prop };
        if (target === ds) invalid(`${where}: the fake does not support dual self-relations.`);
        // Notion does not document how the back-property is named; mimic a default name.
        let backName = `Related to ${ds.title} (${name})`;
        for (let n = 1; target.props.some((p) => p.name === backName); n++) backName = `Related to ${ds.title} (${name}) ${n}`;
        const back: FakeProp = {
          id: randomPropId(new Set(target.props.map((p) => p.id))),
          name: backName,
          type: "relation",
          description: null,
          relation: {
            database_id: ds.database_id,
            data_source_id: ds.id,
            type: "dual_property",
            synced_property_id: id,
            synced_property_name: name,
          },
        };
        prop.relation.synced_property_id = back.id;
        prop.relation.synced_property_name = back.name;
        return { prop, back: { ds: target, prop: back } };
      }
      default:
        invalid(`${where}: the fake does not support property type ${type}.`);
    }
  }

  function parseOption(o: unknown, where: string, existing: SelectOption[]): SelectOption {
    if (!isObject(o)) invalid(`${where} should be an object.`);
    const byId = typeof o.id === "string" ? existing.find((x) => x.id === o.id) : undefined;
    const name = typeof o.name === "string" ? o.name : byId?.name;
    if (!name) invalid(`${where}.name is required.`);
    if (name.includes(",")) invalid(`Invalid select option, commas not allowed: ${name}`);
    if (name.length > FAKE_LIMITS.selectNameChars) invalid(`${where}.name.length should be ≤ \`${FAKE_LIMITS.selectNameChars}\`.`);
    const prev = byId ?? existing.find((x) => x.name === name);
    const color = (typeof o.color === "string" ? o.color : prev?.color ?? "default") as SelectColor;
    return {
      id: prev?.id ?? crypto.randomBytes(4).toString("hex"),
      name,
      color,
      description: typeof o.description === "string" ? o.description : prev?.description ?? null,
    };
  }

  function addPending(ds: FakeDataSource, pending: PendingProp): void {
    ds.props.push(pending.prop);
    if (pending.back) {
      pending.back.ds.props.push(pending.back.prop);
      pending.back.ds.edited = now();
    }
  }

  // -- pagination ------------------------------------------------------------
  function pageSizeOf(v: unknown): number {
    if (v === undefined) return 100;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1) invalid("body.page_size should be a positive integer.");
    if (v > FAKE_LIMITS.pageSize) invalid(`body.page_size should be ≤ \`${FAKE_LIMITS.pageSize}\`, instead was \`${v}\`.`);
    return v;
  }
  function paginate<T extends { id: string }>(items: T[], start: unknown, size: number): { slice: T[]; next: string | null } {
    let from = 0;
    if (start !== undefined && start !== null) {
      if (typeof start !== "string") invalid("start_cursor should be a string.");
      from = items.findIndex((x) => x.id === start);
      if (from < 0) invalid("The start_cursor provided is invalid.");
    }
    const slice = items.slice(from, from + size);
    const nextItem = items[from + size];
    return { slice, next: nextItem ? nextItem.id : null };
  }

  // -- filters and sorts -------------------------------------------------------
  function textOf(v: StoredValue | undefined, prop: FakeProp): string {
    if (!v) return "";
    if (v.type === "title") return plain(v.title);
    if (v.type === "rich_text") return plain(v.rich_text);
    if (v.type === "url") return v.url ?? "";
    void prop;
    return "";
  }

  function evalText(cond: Record<string, unknown>, text: string, where: string): boolean {
    const lower = text.toLowerCase();
    if ("equals" in cond) return text === cond.equals;
    if ("does_not_equal" in cond) return text !== cond.does_not_equal;
    if ("contains" in cond) return lower.includes(String(cond.contains).toLowerCase());
    if ("does_not_contain" in cond) return !lower.includes(String(cond.does_not_contain).toLowerCase());
    if ("starts_with" in cond) return lower.startsWith(String(cond.starts_with).toLowerCase());
    if ("ends_with" in cond) return lower.endsWith(String(cond.ends_with).toLowerCase());
    if ("is_empty" in cond) return text === "";
    if ("is_not_empty" in cond) return text !== "";
    invalid(`${where}: unsupported text condition ${Object.keys(cond).join(",")}.`);
  }

  function evalNumber(cond: Record<string, unknown>, n: number | null, where: string): boolean {
    if ("is_empty" in cond) return n === null;
    if ("is_not_empty" in cond) return n !== null;
    if (n === null) return false;
    if ("equals" in cond) return n === cond.equals;
    if ("does_not_equal" in cond) return n !== cond.does_not_equal;
    if ("greater_than" in cond) return n > Number(cond.greater_than);
    if ("less_than" in cond) return n < Number(cond.less_than);
    if ("greater_than_or_equal_to" in cond) return n >= Number(cond.greater_than_or_equal_to);
    if ("less_than_or_equal_to" in cond) return n <= Number(cond.less_than_or_equal_to);
    invalid(`${where}: unsupported number condition.`);
  }

  function evalDate(cond: Record<string, unknown>, value: string | null, where: string): boolean {
    if ("is_empty" in cond) return value === null;
    if ("is_not_empty" in cond) return value !== null;
    if (value === null) return false;
    const cmp = (x: unknown) => {
      const s = String(x);
      const len = s.includes("T") ? Math.min(s.length, value.length) : 10;
      return value.slice(0, len).localeCompare(s.slice(0, len));
    };
    if ("equals" in cond) return cmp(cond.equals) === 0;
    if ("before" in cond) return cmp(cond.before) < 0;
    if ("after" in cond) return cmp(cond.after) > 0;
    if ("on_or_before" in cond) return cmp(cond.on_or_before) <= 0;
    if ("on_or_after" in cond) return cmp(cond.on_or_after) >= 0;
    invalid(`${where}: unsupported date condition.`);
  }

  /** Validates a filter's structure up front (Notion rejects bad filters even when nothing would match). */
  function checkFilter(ds: FakeDataSource, f: unknown, depth: number): void {
    if (!isObject(f)) invalid("body.filter should be an object.");
    if ("and" in f || "or" in f) {
      if (depth >= FAKE_LIMITS.filterDepth) invalid("body.filter: compound filters can be nested at most 2 levels deep.");
      const list = (f.and ?? f.or) as unknown;
      if (!Array.isArray(list)) invalid("body.filter.and/or should be an array.");
      if (list.length > FAKE_LIMITS.arrayItems) invalid("body.filter: too many filters.");
      for (const x of list) checkFilter(ds, x, depth + 1);
      return;
    }
    if (typeof f.timestamp === "string") return;
    if (typeof f.property !== "string") invalid("body.filter.property should be a string.");
    const prop = findProp(ds, f.property);
    if (!prop) invalid(`Could not find property with name or id: ${f.property}`);
    const key = Object.keys(f).find((k) => k !== "property" && k !== "type");
    if (key !== prop.type) invalid(`body.filter: property ${prop.name} is ${prop.type}, but the filter is ${key}.`);
    // Values are validated up front too (even when no row would be compared).
    const cond = f[key];
    if (!isObject(cond)) invalid(`body.filter.${key} should be an object.`);
    if (prop.type === "relation") {
      if ("contains" in cond) normId(cond.contains, `body.filter.relation.contains`);
      if ("does_not_contain" in cond) normId(cond.does_not_contain, `body.filter.relation.does_not_contain`);
    }
  }

  function evalFilter(ds: FakeDataSource, page: FakePage, f: unknown, depth: number): boolean {
    if (!isObject(f)) invalid("body.filter should be an object.");
    if ("and" in f || "or" in f) {
      if (depth >= FAKE_LIMITS.filterDepth) invalid("body.filter: compound filters can be nested at most 2 levels deep.");
      const list = (f.and ?? f.or) as unknown;
      if (!Array.isArray(list)) invalid("body.filter.and/or should be an array.");
      if (list.length > FAKE_LIMITS.arrayItems) invalid("body.filter: too many filters.");
      return "and" in f
        ? list.every((x) => evalFilter(ds, page, x, depth + 1))
        : list.some((x) => evalFilter(ds, page, x, depth + 1));
    }
    if (typeof f.timestamp === "string") {
      const ts = f.timestamp === "created_time" ? page.created : page.edited;
      const cond = f[f.timestamp];
      if (!isObject(cond)) invalid(`body.filter.${f.timestamp} should be an object.`);
      return evalDate(cond, minuteIso(ts), "body.filter");
    }
    if (typeof f.property !== "string") invalid("body.filter.property should be a string.");
    const prop = findProp(ds, f.property);
    if (!prop) invalid(`Could not find property with name or id: ${f.property}`);
    const key = Object.keys(f).find((k) => k !== "property" && k !== "type");
    if (key !== prop.type) invalid(`body.filter: property ${prop.name} is ${prop.type}, but the filter is ${key}.`);
    const cond = f[key];
    if (!isObject(cond)) invalid(`body.filter.${key} should be an object.`);
    const v = page.values[prop.id];
    const where = `body.filter.${key}`;
    switch (prop.type) {
      case "title":
      case "rich_text":
      case "url":
        return evalText(cond, textOf(v, prop), where);
      case "number":
        return evalNumber(cond, v && v.type === "number" ? v.number : null, where);
      case "checkbox": {
        const b = v && v.type === "checkbox" ? v.checkbox : false;
        if ("equals" in cond) return b === cond.equals;
        if ("does_not_equal" in cond) return b !== cond.does_not_equal;
        invalid(`${where}: unsupported checkbox condition.`);
        break;
      }
      case "select": {
        const name = v && v.type === "select" && v.select ? prop.select?.options.find((o) => o.id === v.select?.id)?.name ?? null : null;
        const matches = (x: unknown) => (Array.isArray(x) ? x.includes(name) : name === x);
        if ("equals" in cond) return name !== null && matches(cond.equals);
        if ("does_not_equal" in cond) return !matches(cond.does_not_equal);
        if ("is_empty" in cond) return name === null;
        if ("is_not_empty" in cond) return name !== null;
        invalid(`${where}: unsupported select condition.`);
        break;
      }
      case "relation": {
        const ids = v && v.type === "relation" ? v.relation.map((r) => r.id) : [];
        if ("contains" in cond) return ids.includes(normId(cond.contains, `${where}.contains`));
        if ("does_not_contain" in cond) return !ids.includes(normId(cond.does_not_contain, `${where}.does_not_contain`));
        if ("is_empty" in cond) return ids.length === 0;
        if ("is_not_empty" in cond) return ids.length > 0;
        invalid(`${where}: unsupported relation condition.`);
        break;
      }
      case "date":
        return evalDate(cond, v && v.type === "date" && v.date ? v.date.start : null, where);
      case "files": {
        const n = v && v.type === "files" ? v.files.length : 0;
        if ("is_empty" in cond) return n === 0;
        if ("is_not_empty" in cond) return n > 0;
        invalid(`${where}: unsupported files condition.`);
        break;
      }
      case "created_time":
        return evalDate(cond, minuteIso(page.created), where);
      default:
        invalid(`${where}: the fake cannot filter ${prop.type} properties.`);
    }
    return false;
  }

  type SortKey = string | number | boolean | null;
  function sortValue(ds: FakeDataSource, page: FakePage, s: Record<string, unknown>): SortKey {
    if (typeof s.timestamp === "string") {
      return s.timestamp === "created_time" ? Math.floor(page.created / 60_000) : Math.floor(page.edited / 60_000);
    }
    if (typeof s.property !== "string") invalid("body.sorts[].property should be a string.");
    const prop = findProp(ds, s.property);
    if (!prop) invalid(`Could not find sort property with name or id: ${s.property}`);
    const v = page.values[prop.id];
    switch (prop.type) {
      case "title":
      case "rich_text":
      case "url": {
        const t = textOf(v, prop);
        return t === "" ? null : t;
      }
      case "number":
        return v && v.type === "number" ? v.number : null;
      case "checkbox":
        return v && v.type === "checkbox" ? v.checkbox : false;
      case "select": {
        if (!v || v.type !== "select" || !v.select) return null;
        const idx = prop.select?.options.findIndex((o) => o.id === v.select?.id) ?? -1;
        return idx < 0 ? null : idx;
      }
      case "date":
        return v && v.type === "date" && v.date ? v.date.start : null;
      case "created_time":
        return Math.floor(page.created / 60_000);
      default:
        invalid(`The fake cannot sort by ${prop.type} properties.`);
    }
  }

  function compareKeys(a: SortKey, b: SortKey): number {
    if (a === b) return 0;
    if (a === null) return 1;
    if (b === null) return -1;
    if (typeof a === "number" && typeof b === "number") return a - b;
    if (typeof a === "boolean" && typeof b === "boolean") return a ? 1 : -1;
    return String(a).localeCompare(String(b));
  }

  // -- call wrapper --------------------------------------------------------------
  function takeFault(method: FakeMethod): FaultSpec | undefined {
    const i = faults.findIndex((f) => !f.method || f.method === method);
    if (i < 0) return undefined;
    const f = faults[i];
    f.left -= 1;
    if (f.left <= 0) faults.splice(i, 1);
    return f;
  }
  function faultError(f: FaultSpec): APIResponseError {
    const code = f.code ?? codeForStatus(f.status);
    const headers: Record<string, string> = {};
    if (f.retryAfterSec !== undefined) headers["retry-after"] = String(f.retryAfterSec);
    return apiError(f.status, code, f.message ?? `Injected ${f.status} (${code}).`, { headers, additional_data: f.additional_data });
  }
  function checkPayload(args: unknown): void {
    const bytes = Buffer.byteLength(JSON.stringify(args ?? {}), "utf8");
    if (bytes > FAKE_LIMITS.payloadBytes) {
      invalid(`Request body too large: ${bytes} bytes (limit ${FAKE_LIMITS.payloadBytes}).`);
    }
  }

  async function run<T>(method: FakeMethod, args: unknown, write: boolean, fn: () => T | Promise<T>): Promise<T> {
    calls.push({ method, args });
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      if (opts.latencyMs) await new Promise((r) => setTimeout(r, opts.latencyMs));
      reloadIfChanged();
      const fault = takeFault(method);
      if (fault && !fault.afterCommit) throw faultError(fault);
      if (method !== "fileUploads.send") checkPayload(args);
      const result = await fn();
      if (write) persist();
      if (fault?.afterCommit) {
        const id = isObject(result) && typeof result.id === "string" ? result.id : undefined;
        const report = fault.reportCommittedId !== false && method.endsWith(".create") && id && !fault.additional_data;
        throw faultError(report ? { ...fault, additional_data: { committed_resource_id: id } } : fault);
      }
      return structuredClone(result);
    } finally {
      inFlight--;
    }
  }

  // -- endpoints -------------------------------------------------------------------
  const api: NotionLike = {
    databases: {
      create: (args: DatabaseCreateArgs) =>
        run("databases.create", args, true, () => {
          const parent = args.parent as { type: string; page_id?: string };
          if (parent.type !== "page_id") invalid("body.parent: the fake supports only page parents for databases.");
          const parentId = normId(parent.page_id, "body.parent.page_id");
          const parentPage = getPage(parentId);
          if (parentPage.in_trash) invalid("Can't create a database inside a page that is in the trash.");
          const title = plain(toRichText(args.title ?? [], "body.title"));
          const description = plain(toRichText(args.description ?? [], "body.description"));
          const t = now();
          const db: FakeDatabase = {
            id: crypto.randomUUID(),
            seq: nextSeq(),
            parent_page_id: parentId,
            title,
            description,
            data_source_ids: [],
            created: t,
            edited: t,
            in_trash: false,
            is_locked: false,
            is_inline: args.is_inline ?? false,
          };
          const ds: FakeDataSource = { id: crypto.randomUUID(), database_id: db.id, title, props: [], created: t, edited: t, in_trash: false };
          const defs = args.initial_data_source?.properties ?? {};
          const taken = new Set<string>();
          const pending: PendingProp[] = [];
          const names = new Set<string>();
          for (const [name, cfg] of Object.entries(defs)) {
            if (names.has(name.toLowerCase())) invalid(`Duplicate property name: ${name}`);
            names.add(name.toLowerCase());
            pending.push(buildProp(ds, name, cfg, taken, `body.initial_data_source.properties.${name}`));
          }
          const titles = pending.filter((p) => p.prop.type === "title").length;
          if (titles > 1) invalid("A database can have only one title property.");
          if (titles === 0) pending.unshift({ prop: { id: "title", name: "Name", type: "title", description: null } });
          state.databases[db.id] = db;
          state.dataSources[ds.id] = ds;
          db.data_source_ids.push(ds.id);
          for (const p of pending) addPending(ds, p);
          return dbResponse(db);
        }),
      retrieve: (args) =>
        run("databases.retrieve", args, false, () => dbResponse(getDb(normId(args.database_id, "path.database_id")))),
      update: (args: DatabaseUpdateArgs) =>
        run("databases.update", args, true, () => {
          const db = getDb(normId(args.database_id, "path.database_id"));
          const title = args.title !== undefined ? plain(toRichText(args.title, "body.title")) : undefined;
          const description = args.description !== undefined ? plain(toRichText(args.description, "body.description")) : undefined;
          if (title !== undefined) db.title = title;
          if (description !== undefined) db.description = description;
          if (args.is_locked !== undefined) db.is_locked = args.is_locked;
          if (args.is_inline !== undefined) db.is_inline = args.is_inline;
          const trash = args.in_trash ?? args.archived;
          if (trash !== undefined) {
            db.in_trash = trash;
            for (const id of db.data_source_ids) {
              const ds = state.dataSources[id];
              if (ds) ds.in_trash = trash;
            }
          }
          db.edited = now();
          return dbResponse(db);
        }),
    },

    dataSources: {
      retrieve: (args) =>
        run("dataSources.retrieve", args, false, () => dsResponse(getDs(normId(args.data_source_id, "path.data_source_id")))),
      update: (args: DataSourceUpdateArgs) =>
        run("dataSources.update", args, true, () => {
          const ds = getDs(normId(args.data_source_id, "path.data_source_id"));
          const props = (args.properties ?? {}) as Record<string, unknown>;
          // Pass 1: validate everything; pass 2: apply.
          const ops: (() => void)[] = [];
          const taken = new Set(ds.props.map((p) => p.id));
          const finalNames = new Map(ds.props.map((p) => [p.id, p.name]));
          for (const [k, raw] of Object.entries(props)) {
            const where = `body.properties.${k}`;
            const prop = findProp(ds, k);
            if (raw === null) {
              if (!prop) invalid(`${where}: no such property.`);
              if (prop.type === "title") invalid("The title property cannot be deleted.");
              finalNames.delete(prop.id);
              ops.push(() => {
                ds.props = ds.props.filter((p) => p !== prop);
              });
              continue;
            }
            if (!isObject(raw)) invalid(`${where} should be an object.`);
            if (prop) {
              const cfgKey = Object.keys(raw).find((x) => x !== "type" && x !== "id" && x !== "name" && x !== "description");
              const newName = typeof raw.name === "string" ? raw.name : undefined;
              if (newName !== undefined) finalNames.set(prop.id, newName);
              // A type change keeps the property id (as in Notion); existing values are dropped.
              let newType: string | undefined;
              if (cfgKey && cfgKey !== prop.type) {
                const changeable = ["rich_text", "number", "select", "checkbox", "date", "url", "files"];
                if (!changeable.includes(cfgKey) || !changeable.includes(prop.type)) {
                  invalid(`${where}: the fake cannot change a property's type (${prop.type} → ${cfgKey}).`);
                }
                newType = cfgKey;
              }
              let options: SelectOption[] | undefined;
              if (cfgKey === "select") {
                const c = raw.select;
                const list = isObject(c) && Array.isArray(c.options) ? c.options : [];
                const existing = prop.select?.options ?? [];
                options = list.map((o: unknown, i) => parseOption(o, `${where}.select.options[${i}]`, existing));
              }
              const format = cfgKey === "number" && isObject(raw.number) && typeof raw.number.format === "string" ? raw.number.format : undefined;
              const description = "description" in raw ? (typeof raw.description === "string" ? raw.description : null) : undefined;
              ops.push(() => {
                if (newType) {
                  prop.type = newType;
                  delete prop.select;
                  delete prop.number;
                  if (newType === "select") prop.select = { options: [] };
                  if (newType === "number") prop.number = { format: "number" };
                  for (const page of Object.values(state.pages)) {
                    if (page.parent.type === "data_source_id" && page.parent.data_source_id === ds.id) delete page.values[prop.id];
                  }
                }
                if (newName !== undefined) prop.name = newName;
                if (description !== undefined) prop.description = description;
                // Notion replaces the option list with the one sent (send the full list to keep options).
                if (options) prop.select = { options };
                if (format) prop.number = { format };
              });
            } else {
              const name = typeof raw.name === "string" ? raw.name : k;
              if (valueKey(raw) === undefined || valueKey(raw) === "description") invalid(`Could not find property with name or id: ${k}`);
              const pending = buildProp(ds, name, raw, taken, where);
              finalNames.set(pending.prop.id, name);
              ops.push(() => addPending(ds, pending));
            }
          }
          const lowered = [...finalNames.values()].map((n) => n.toLowerCase());
          if (new Set(lowered).size !== lowered.length) invalid("Property names must be unique.");
          if (args.title !== undefined) {
            const title = plain(toRichText(args.title, "body.title"));
            ops.push(() => {
              ds.title = title;
            });
          }
          if (args.in_trash !== undefined) {
            const trash = args.in_trash;
            ops.push(() => {
              ds.in_trash = trash;
            });
          }
          for (const op of ops) op();
          ds.edited = now();
          // Keep dual relation names in step on both sides.
          for (const p of ds.props) {
            const r = p.relation;
            if (r?.type !== "dual_property" || !r.synced_property_id) continue;
            const other = state.dataSources[r.data_source_id]?.props.find((x) => x.id === r.synced_property_id);
            if (other?.relation) {
              r.synced_property_name = other.name;
              other.relation.synced_property_name = p.name;
            }
          }
          return dsResponse(ds);
        }),
      query: (args: QueryArgs) =>
        run("dataSources.query", args, false, () => {
          const ds = liveDs(normId(args.data_source_id, "path.data_source_id"));
          const size = pageSizeOf(args.page_size);
          const trashed = args.in_trash ?? args.archived ?? false;
          const lag = opts.queryLagMs ?? 0;
          const t = now();
          let rows = Object.values(state.pages).filter(
            (p) =>
              p.parent.type === "data_source_id" &&
              p.parent.data_source_id === ds.id &&
              p.in_trash === trashed &&
              (lag <= 0 || t - p.created >= lag),
          );
          if (args.filter !== undefined) {
            checkFilter(ds, args.filter, 0);
            rows = rows.filter((p) => evalFilter(ds, p, args.filter, 0));
          }
          const sorts = (args.sorts ?? []) as Record<string, unknown>[];
          if (sorts.length > FAKE_LIMITS.arrayItems) invalid("body.sorts: too many sorts.");
          for (const s of sorts) {
            if (typeof s.timestamp === "string") continue;
            if (typeof s.property !== "string" || !findProp(ds, s.property)) {
              invalid(`Could not find sort property with name or id: ${String(s.property)}`);
            }
          }
          rows.sort((a, b) => {
            for (const s of sorts) {
              const c = compareKeys(sortValue(ds, a, s), sortValue(ds, b, s));
              if (c !== 0) return s.direction === "descending" ? -c : c;
            }
            return sorts.length ? a.seq - b.seq : b.seq - a.seq;
          });
          const capped = rows.length > cap;
          if (capped) rows = rows.slice(0, cap);
          const { slice, next } = paginate(rows, args.start_cursor, size);
          const res: QueryDataSourceResponse = {
            type: "page_or_data_source",
            page_or_data_source: {},
            object: "list",
            next_cursor: next,
            has_more: next !== null,
            results: slice.map((p) => pageResponse(p, args.filter_properties)),
          };
          if (capped && next === null) res.request_status = { type: "incomplete", incomplete_reason: "query_result_limit_reached" };
          return res;
        }),
    },

    pages: {
      create: (args: PageCreateArgs) =>
        run("pages.create", args, true, () => {
          const parent = (args.parent ?? {}) as Record<string, unknown>;
          const t = now();
          let page: FakePage;
          if (parent.data_source_id !== undefined || parent.database_id !== undefined) {
            const ds =
              parent.data_source_id !== undefined
                ? liveDs(normId(parent.data_source_id, "body.parent.data_source_id"))
                : liveDs(getDb(normId(parent.database_id, "body.parent.database_id")).data_source_ids[0]);
            const parsed = parseProps(ds.props, ds, args.properties);
            page = {
              id: crypto.randomUUID(),
              seq: nextSeq(),
              parent: { type: "data_source_id", data_source_id: ds.id, database_id: ds.database_id },
              created: t,
              edited: t,
              in_trash: false,
              is_locked: false,
              values: {},
            };
            state.pages[page.id] = page;
            applyProps(page, parsed);
          } else {
            let p: Parent;
            if (parent.page_id !== undefined) {
              const pid = normId(parent.page_id, "body.parent.page_id");
              getPage(pid);
              p = { type: "page_id", page_id: pid };
            } else if (parent.workspace === true) {
              p = { type: "workspace", workspace: true };
            } else {
              invalid("body.parent should be a data source, database, page or workspace.");
            }
            const parsed = parseProps([PAGE_TITLE_PROP], null, args.properties);
            page = { id: crypto.randomUUID(), seq: nextSeq(), parent: p, created: t, edited: t, in_trash: false, is_locked: false, values: {} };
            state.pages[page.id] = page;
            applyProps(page, parsed);
          }
          return pageResponse(page, args.filter_properties);
        }),
      retrieve: (args) =>
        run("pages.retrieve", args, false, () => pageResponse(getPage(normId(args.page_id, "path.page_id")), args.filter_properties)),
      update: (args: PageUpdateArgs) =>
        run("pages.update", args, true, () => {
          const page = getPage(normId(args.page_id, "path.page_id"));
          const trash = args.in_trash ?? args.archived;
          if (page.in_trash && trash !== false && args.properties && Object.keys(args.properties).length > 0) {
            invalid("Can't edit block that is archived. You must unarchive the block before editing.");
          }
          const ds = page.parent.type === "data_source_id" ? getDs(page.parent.data_source_id) : null;
          const parsed = parseProps(schemaOf(page), ds, args.properties);
          if (trash !== undefined) page.in_trash = trash;
          if (args.is_locked !== undefined) page.is_locked = args.is_locked;
          applyProps(page, parsed);
          page.edited = now();
          return pageResponse(page, args.filter_properties);
        }),
    },

    blocks: {
      children: {
        list: (args: BlockChildrenListArgs) =>
          run("blocks.children.list", args, false, () => {
            const id = normId(args.block_id, "path.block_id");
            const page = getPage(id);
            void page;
            const size = pageSizeOf(args.page_size);
            type Child = { id: string; seq: number; block: ChildDatabaseBlockObjectResponse | ChildPageBlockObjectResponse };
            const common = (created: number, edited: number) => ({
              parent: { type: "page_id" as const, page_id: id },
              object: "block" as const,
              created_time: minuteIso(created),
              created_by: BOT,
              last_edited_time: minuteIso(edited),
              last_edited_by: BOT,
              has_children: false,
              in_trash: false,
              archived: false,
            });
            const children: Child[] = [
              ...Object.values(state.databases)
                .filter((d) => d.parent_page_id === id && !d.in_trash)
                .map((d) => ({
                  id: d.id,
                  seq: d.seq,
                  block: { ...common(d.created, d.edited), id: d.id, type: "child_database" as const, child_database: { title: d.title } },
                })),
              ...Object.values(state.pages)
                .filter((p) => p.parent.type === "page_id" && p.parent.page_id === id && !p.in_trash)
                .map((p) => ({
                  id: p.id,
                  seq: p.seq,
                  block: { ...common(p.created, p.edited), id: p.id, type: "child_page" as const, child_page: { title: pageTitle(p) } },
                })),
            ].sort((a, b) => a.seq - b.seq);
            const { slice, next } = paginate(children, args.start_cursor, size);
            const res: ListBlockChildrenResponse = {
              type: "block",
              block: {},
              object: "list",
              next_cursor: next,
              has_more: next !== null,
              results: slice.map((c) => c.block),
            };
            return res;
          }),
      },
    },

    search: (args: SearchArgs) =>
      run("search", args, false, () => {
        const size = pageSizeOf(args.page_size);
        const q = (args.query ?? "").toLowerCase();
        const kind = args.filter && "property" in args.filter ? args.filter.value : undefined;
        type Hit = { id: string; edited: number; result: SearchResponse["results"][number] };
        const hits: Hit[] = [];
        if (kind !== "data_source") {
          for (const p of Object.values(state.pages)) {
            if (p.in_trash) continue;
            if (q && !pageTitle(p).toLowerCase().includes(q)) continue;
            hits.push({ id: p.id, edited: p.edited, result: pageResponse(p) });
          }
        }
        if (kind !== "page") {
          for (const ds of Object.values(state.dataSources)) {
            if (ds.in_trash) continue;
            if (q && !ds.title.toLowerCase().includes(q)) continue;
            hits.push({ id: ds.id, edited: ds.edited, result: dsResponse(ds) });
          }
        }
        const asc = args.sort && "timestamp" in args.sort && args.sort.direction === "ascending";
        hits.sort((a, b) => (asc ? a.edited - b.edited : b.edited - a.edited));
        const { slice, next } = paginate(hits, args.start_cursor, size);
        const res: SearchResponse = {
          type: "page_or_data_source",
          page_or_data_source: {},
          object: "list",
          next_cursor: next,
          has_more: next !== null,
          results: slice.map((h) => h.result),
        };
        return res;
      }),

    fileUploads: {
      create: (args: FileUploadCreateArgs) =>
        run("fileUploads.create", args, true, () => {
          const mode = args.mode ?? "single_part";
          if (mode !== "single_part") invalid(`body.mode: the fake supports only single_part uploads (got ${mode}).`);
          const filename = args.filename ?? null;
          if (filename) {
            const ext = path.extname(filename).toLowerCase();
            if (UNSUPPORTED_EXTENSIONS.has(ext)) invalid(`Files with the extension ${ext} are not supported by Notion.`);
          }
          const t = now();
          const up: FakeUpload = {
            id: crypto.randomUUID(),
            filename,
            content_type: args.content_type ?? null,
            status: "pending",
            created: t,
            expires: t + 3_600_000,
            size: null,
          };
          state.uploads[up.id] = up;
          return uploadResponse(up);
        }),
      send: (args: FileUploadSendArgs) =>
        run("fileUploads.send", { file_upload_id: args.file_upload_id, filename: args.file?.filename }, true, async () => {
          // Read the bytes first, so every state lookup below happens after the only await.
          const data = args.file?.data;
          const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data ? Buffer.from(await data.arrayBuffer()) : null;
          const up = state.uploads[normId(args.file_upload_id, "path.file_upload_id")];
          if (!up) notFound("file upload", String(args.file_upload_id));
          if (up.status !== "pending") invalid(`File upload is ${up.status}; expected pending.`);
          if (up.expires < now()) {
            up.status = "expired";
            invalid("File upload has expired.");
          }
          if (!buf) invalid("body.file.data is required.");
          if (buf.byteLength > maxFileBytes) {
            invalid(`The file is ${buf.byteLength} bytes; the workspace limit is ${maxFileBytes} bytes per file.`);
          }
          writeBytes(up, buf);
          up.size = buf.byteLength;
          up.status = "uploaded";
          if (args.file?.filename && !up.filename) up.filename = args.file.filename;
          return uploadResponse(up);
        }),
    },
  };

  const controls: FakeControls = {
    calls,
    callCount: (method) => (method ? calls.filter((c) => c.method === method).length : calls.length),
    resetCalls: () => {
      calls.length = 0;
      maxInFlight = 0;
    },
    injectFault: (spec) => {
      faults.push({ ...spec, left: spec.count ?? 1 });
    },
    clearFaults: () => {
      faults = [];
    },
    get maxInFlight() {
      return maxInFlight;
    },
    fileBytes,
    reset: () => {
      state = emptyState();
      if (file && fs.existsSync(/*turbopackIgnore: true*/ file)) fs.rmSync(/*turbopackIgnore: true*/ file);
      if (filesDir && fs.existsSync(/*turbopackIgnore: true*/ filesDir)) fs.rmSync(/*turbopackIgnore: true*/ filesDir, { recursive: true, force: true });
      fileMtime = 0;
    },
    pageCount: () => Object.keys(state.pages).length,
  };

  const inst = { fileBytes };
  instances.add(inst);

  return { ...api, fake: controls };
}

/** True when `n` is (or wraps) a fake created by createFakeNotion. */
export function isFakeNotion(n: unknown): n is FakeNotion {
  return typeof n === "object" && n !== null && "fake" in n;
}
