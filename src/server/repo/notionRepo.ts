import "server-only";
import crypto from "node:crypto";
import { extractNotionId, isFullDataSource, isFullPage } from "@notionhq/client";
import type { PageObjectResponse } from "@notionhq/client";
import type {
  Attachment,
  Choice,
  EventSource,
  FieldConfig,
  FieldType,
  Flow,
  Milestone,
  Note,
  Project,
  ProjectField,
  SystemFieldKey,
  Value,
} from "@/domain/types";
import type { NotionLike, PropValue, PropWrite, PropWrites, QueryArgs, QueryFilter } from "@/server/notion/client";
import { historyHash } from "@/server/services/historyHash";
import {
  FileTooLargeError,
  NotSharedError,
  NotionError,
  SetupIncompleteError,
  ValueTooLargeError,
  isNotionCode,
  mapNotionError,
} from "@/server/notion/errors";
import {
  findSettingRow,
  propById,
  upsertSettingRow,
  type DbEntry,
  type Registry,
  type RegistryHandle,
} from "@/server/notion/registry";
import {
  jsonToRichText,
  mirrorText,
  richTextToJson,
  richTextToText,
  textToRichText,
  truncateText,
} from "@/server/notion/richtext";
import {
  FIELD_TYPE_LABELS,
  FLAG_LABELS,
  KIND_LABELS,
  PROJECT_STATUS_LABELS,
  SCHEMA,
  SETUP_LABELS,
  SOURCE_LABELS,
  STATE_CODES,
  STATE_LABELS,
  fromLabel,
  sanitizeSelectName,
  type DbKey,
} from "@/server/notion/schema";
import type {
  FileDownload,
  HistoryAppendInput,
  HistoryQuery,
  MilestoneInput,
  NoteInput,
  Page,
  ProjectFieldInput,
  ProjectInput,
  Repo,
  StepInput,
  StoredHistoryEvent,
  StoredStep,
} from "./types";

/** Files bigger than this are refused (Vercel's 4.5 MB request cap, Notion Free's 5 MiB per file). */
export const MAX_FILE_BYTES = 4_000_000;
/** Notion accepts 500 KB per request; bigger writes are split into several requests below this. */
export const PAYLOAD_SPLIT_BYTES = 450_000;
/** History `data` larger than this (as JSON) is replaced by a marker so a change is never lost to its log. */
const HISTORY_DATA_MAX_CHARS = 150_000;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

type FilterItem = Extract<QueryFilter, { and: unknown }>["and"][number];

function has<T extends object>(o: T, k: keyof T): boolean {
  return Object.prototype.hasOwnProperty.call(o, k);
}

/** Drops keys whose value is undefined (so domain objects compare cleanly). */
function compact<T extends object>(o: T): T {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined) delete o[k];
  return o;
}

/** Canonical dashed lower-case page id, or the input when it is not an id. */
export function normalizeId(id: string): string {
  return extractNotionId(id) ?? id;
}

function sameId(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  try {
    return decodeURIComponent(a) === decodeURIComponent(b);
  } catch {
    return false;
  }
}

/** Notion date-times come back as '…+00:00'; the app uses '…Z'. Date-only values stay as they are. */
function normInstant(s: string | null | undefined): string | undefined {
  if (!s) return undefined;
  if (!s.includes("T")) return s;
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

function sizeOf(x: unknown): number {
  return Buffer.byteLength(JSON.stringify(x), "utf8");
}


// ---------------------------------------------------------------------------
// Reading pages (by property id)
// ---------------------------------------------------------------------------

class Row {
  private readonly byId = new Map<string, PropValue>();

  constructor(
    readonly page: PageObjectResponse,
    private readonly e: DbEntry,
  ) {
    for (const v of Object.values(page.properties)) this.byId.set(v.id, v);
  }

  private v(pk: string): PropValue | undefined {
    const id = this.e.props[pk];
    if (!id) return undefined;
    return this.byId.get(id) ?? propById(this.page, id);
  }
  text(pk: string): string {
    const v = this.v(pk);
    if (!v) return "";
    if (v.type === "title") return richTextToText(v.title);
    if (v.type === "rich_text") return richTextToText(v.rich_text);
    return "";
  }
  optText(pk: string): string | undefined {
    return this.text(pk) || undefined;
  }
  json<T>(pk: string, fallback: T): T {
    const v = this.v(pk);
    if (!v || v.type !== "rich_text") return fallback;
    return richTextToJson<T>(v.rich_text, fallback);
  }
  num(pk: string): number | null {
    const v = this.v(pk);
    return v && v.type === "number" ? v.number : null;
  }
  bool(pk: string): boolean {
    const v = this.v(pk);
    return v && v.type === "checkbox" ? v.checkbox : false;
  }
  select(pk: string): string | null {
    const v = this.v(pk);
    return v && v.type === "select" ? (v.select?.name ?? null) : null;
  }
  instant(pk: string): string | undefined {
    const v = this.v(pk);
    return v && v.type === "date" ? normInstant(v.date?.start) : undefined;
  }
  ids(pk: string): string[] {
    const v = this.v(pk);
    return v && v.type === "relation" ? v.relation.map((r) => r.id) : [];
  }
  url(pk: string): string | null {
    const v = this.v(pk);
    return v && v.type === "url" ? v.url : null;
  }
  files(pk: string): { name: string; url: string }[] {
    const v = this.v(pk);
    if (!v || v.type !== "files") return [];
    return v.files.map((f) => ({ name: f.name, url: f.type === "file" ? f.file.url : f.external.url }));
  }
  get id(): string {
    return this.page.id;
  }
  get created(): string {
    return this.page.created_time;
  }
  get edited(): string {
    return this.page.last_edited_time;
  }
}

// ---------------------------------------------------------------------------
// Writing pages (keyed by property id)
// ---------------------------------------------------------------------------

class Writes {
  readonly props: PropWrites = {};
  constructor(private readonly e: DbEntry) {}

  private id(pk: string): string {
    const id = this.e.props[pk];
    if (!id) {
      const name = SCHEMA[this.e.key].props[pk]?.name ?? pk;
      throw new SetupIncompleteError(`The ${SCHEMA[this.e.key].title} database in Notion has no "${name}" property. Open Setup to repair it.`);
    }
    return id;
  }
  private set(pk: string, v: PropWrite): this {
    this.props[this.id(pk)] = v;
    return this;
  }
  get size(): number {
    return Object.keys(this.props).length;
  }
  title(pk: string, s: string | undefined, field?: string) {
    return this.set(pk, { title: textToRichText(s ?? "", field) });
  }
  text(pk: string, s: string | undefined | null, field?: string) {
    return this.set(pk, { rich_text: textToRichText(s ?? "", field) });
  }
  mirror(pk: string, s: string | undefined | null) {
    return this.set(pk, { rich_text: mirrorText(s) });
  }
  json(pk: string, v: unknown, field?: string) {
    return this.set(pk, { rich_text: jsonToRichText(v, field) });
  }
  num(pk: string, n: number | null | undefined) {
    return this.set(pk, { number: n === undefined || n === null || !Number.isFinite(n) ? null : n });
  }
  bool(pk: string, b: boolean | undefined) {
    return this.set(pk, { checkbox: !!b });
  }
  select(pk: string, name: string | null | undefined) {
    const clean = sanitizeSelectName(name);
    return this.set(pk, { select: clean ? { name: clean } : null });
  }
  instant(pk: string, iso: string | null | undefined) {
    return this.set(pk, { date: iso ? { start: iso } : null });
  }
  dateRange(pk: string, d: { start: string; end?: string | null } | null) {
    return this.set(pk, { date: d ? { start: d.start, end: d.end ?? null } : null });
  }
  rel(pk: string, ids: (string | undefined | null)[]) {
    const list = ids.filter((x): x is string => !!x).map((id) => ({ id: normalizeId(id) }));
    if (list.length > 100) throw new ValueTooLargeError("Notion accepts at most 100 links in one relation.");
    return this.set(pk, { relation: list });
  }
  url(pk: string, u: string | null | undefined) {
    return this.set(pk, { url: u ? u : null });
  }
  raw(pk: string, v: PropWrite) {
    return this.set(pk, v);
  }
}

/** Splits a property set into request-sized groups (each ≤ PAYLOAD_SPLIT_BYTES as JSON). */
export function splitWrites(props: PropWrites, limit = PAYLOAD_SPLIT_BYTES): PropWrites[] {
  const entries = Object.entries(props);
  if (sizeOf(props) <= limit) return [props];
  const sized = entries.map(([k, v]) => ({ k, v, size: sizeOf({ [k]: v }) })).sort((a, b) => a.size - b.size);
  const groups: { props: PropWrites; size: number }[] = [];
  for (const { k, v, size } of sized) {
    if (size > limit) throw new ValueTooLargeError("One of the values is too large to save in Notion (more than 450 KB).");
    const g = groups.find((x) => x.size + size <= limit);
    if (g) {
      g.props[k] = v;
      g.size += size;
    } else groups.push({ props: { [k]: v }, size: size + 2 });
  }
  return groups.map((g) => g.props);
}

// ---------------------------------------------------------------------------
// Value display fallbacks (used when the service does not pass mirrors)
// ---------------------------------------------------------------------------

export function simpleDisplay(v: Value | null | undefined, choices?: Choice[]): string {
  if (!v) return "";
  const label = (id: string) => choices?.find((c) => c.id === id)?.label ?? id;
  if ("text" in v) return truncateText(v.text, 100);
  if ("number" in v) return String(v.number);
  if ("percent" in v) return `${v.percent} %`;
  if ("date" in v) return v.date;
  if ("choiceId" in v) return label(v.choiceId);
  if ("choiceIds" in v) return v.choiceIds.map(label).join(", ");
  if ("checked" in v) return v.checked ? "Yes" : "";
  if ("url" in v) return v.label || v.url;
  if ("start" in v || "end" in v) return `${v.start ?? "…"} → ${v.end ?? "…"}`;
  return "";
}

function dateMirror(v: Value | null | undefined): { start: string; end?: string | null } | null {
  if (!v) return null;
  if ("date" in v) return { start: v.date };
  if ("start" in v || "end" in v) {
    const start = v.start ?? v.end;
    if (!start) return null;
    return { start, end: v.start && v.end ? v.end : null };
  }
  return null;
}

function choicesReadable(choices: Choice[]): string {
  return choices
    .filter((c) => !c.archived)
    .map((c) => (c.state ? `${c.label} [${STATE_CODES[c.state]}]` : c.label))
    .join(" · ");
}

function fieldTypeOf(label: string | null): FieldType {
  return fromLabel(FIELD_TYPE_LABELS, label) ?? "TEXT";
}

const EMPTY_FLOW: Flow = { nodes: {}, edges: [] };

// History hashing (tamper evidence) uses the one shared rule, so "Verify history" works for every Repo.
export { historyHash };

/** Step ids a bulk event relates to besides its main step (`data.stepIds`, as the services log them). */
function relatedStepIds(data: Record<string, unknown> | undefined, main: string | undefined): string[] {
  const raw = data?.stepIds;
  if (!Array.isArray(raw)) return [];
  const ids = raw.filter((x): x is string => typeof x === "string").map(normalizeId);
  return [...new Set(ids)].filter((id) => id !== main).slice(0, 100);
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

/** Thrown inside a call when a data source id looks stale; the call is retried once after rediscovery. */
class StaleRegistry extends Error {}

function staticHandle(reg: Registry): RegistryHandle {
  return {
    load: async () => reg,
    require: async () => reg,
    reset: () => undefined,
  };
}

/**
 * Repo on Notion. Reads map page properties through each value's `id`; writes are keyed by property id,
 * so renaming a property in Notion does not break anything.
 *
 * `projects.list()` is one paginated query that asks Notion (filter_properties) only for the properties the
 * Project mapping reads, leaving out the Steps back-relation and the Notion-only mirrors (Customer,
 * Project type, Summary, Current). Every returned Project is complete: code, name, status, details, flow,
 * cells, progress, templateRevision, syncDismissed, setup, archived, archivedAt, createdAt, updatedAt.
 */
export function createNotionRepo(notion: NotionLike, registry: RegistryHandle | Registry): Repo {
  const handle: RegistryHandle = "load" in registry ? registry : staticHandle(registry);

  // History.Seq: epoch ms × 1000 + a per-instance counter (strictly increasing within this instance).
  let lastSeq = 0;
  const nextSeq = () => {
    const base = Date.now() * 1000 + crypto.randomInt(0, 50);
    lastSeq = Math.max(base, lastSeq + 1);
    return lastSeq;
  };
  // "Created at" of notes and files: strictly increasing per instance, so newest-first order is stable.
  let lastCreated = 0;
  const createdNow = () => {
    lastCreated = Math.max(Date.now(), lastCreated + 1);
    return new Date(lastCreated).toISOString();
  };

  async function call<T>(fn: (reg: Registry) => Promise<T>): Promise<T> {
    try {
      const reg = await handle.require();
      try {
        return await fn(reg);
      } catch (e) {
        if (!(e instanceof StaleRegistry)) throw e;
        handle.reset();
        const fresh = await handle.require();
        try {
          return await fn(fresh);
        } catch (e2) {
          if (e2 instanceof StaleRegistry) throw new NotSharedError((e2.cause as Error | undefined)?.message);
          throw e2;
        }
      }
    } catch (e) {
      throw mapNotionError(e);
    }
  }

  const entry = (reg: Registry, key: DbKey): DbEntry => {
    const e = reg.dbs[key];
    if (!e) throw new SetupIncompleteError();
    return e;
  };

  /** Data-source scoped calls: object_not_found means our cached ids are stale. */
  async function dsScoped<T>(p: Promise<T>): Promise<T> {
    try {
      return await p;
    } catch (e) {
      if (isNotionCode(e, "object_not_found")) {
        const s = new StaleRegistry("stale data source");
        (s as { cause?: unknown }).cause = mapNotionError(e);
        throw s;
      }
      throw e;
    }
  }

  async function query(e: DbEntry, args: Omit<QueryArgs, "data_source_id">) {
    return dsScoped(notion.dataSources.query({ ...args, data_source_id: e.dataSourceId }));
  }

  async function queryAll(e: DbEntry, args: Omit<QueryArgs, "data_source_id" | "page_size" | "start_cursor">): Promise<PageObjectResponse[]> {
    const out: PageObjectResponse[] = [];
    let cursor: string | undefined;
    do {
      const res = await query(e, { ...args, page_size: 100, start_cursor: cursor });
      for (const r of res.results) if (isFullPage(r)) out.push(r);
      cursor = res.has_more && res.next_cursor ? res.next_cursor : undefined;
    } while (cursor);
    return out;
  }

  function inDataSource(p: PageObjectResponse, e: DbEntry): boolean {
    return p.parent.type === "data_source_id" && normalizeId(p.parent.data_source_id) === normalizeId(e.dataSourceId);
  }

  async function getPage(e: DbEntry, id: string, filterProps?: string[]): Promise<PageObjectResponse | null> {
    const pid = extractNotionId(id);
    if (!pid) return null;
    try {
      const p = await notion.pages.retrieve({ page_id: pid, filter_properties: filterProps });
      if (!isFullPage(p) || p.in_trash || !inDataSource(p, e)) return null;
      return p;
    } catch (err) {
      if (isNotionCode(err, "object_not_found") || isNotionCode(err, "validation_error")) return null;
      throw err;
    }
  }

  async function createPage(e: DbEntry, w: Writes, filterProps?: string[]): Promise<PageObjectResponse> {
    const [first, ...rest] = splitWrites(w.props);
    const created = await dsScoped(
      notion.pages.create({
        parent: { type: "data_source_id", data_source_id: e.dataSourceId },
        properties: first,
        filter_properties: rest.length ? undefined : filterProps,
      }),
    );
    let page = created;
    for (let i = 0; i < rest.length; i++) {
      page = await notion.pages.update({
        page_id: created.id,
        properties: rest[i],
        filter_properties: i === rest.length - 1 ? filterProps : undefined,
      });
    }
    if (!isFullPage(page)) throw new NotionError("Notion returned an incomplete page.");
    return page;
  }

  async function updatePage(e: DbEntry, id: string, w: Writes, filterProps?: string[]): Promise<PageObjectResponse> {
    const pid = extractNotionId(id);
    if (!pid) throw new NotSharedError();
    if (w.size === 0) {
      const p = await getPage(e, pid, filterProps);
      if (!p) throw new NotSharedError();
      return p;
    }
    const groups = splitWrites(w.props);
    let page: Awaited<ReturnType<NotionLike["pages"]["update"]>> | undefined;
    for (let i = 0; i < groups.length; i++) {
      page = await notion.pages.update({
        page_id: pid,
        properties: groups[i],
        filter_properties: i === groups.length - 1 ? filterProps : undefined,
      });
    }
    if (!page || !isFullPage(page)) throw new NotionError("Notion returned an incomplete page.");
    if (!inDataSource(page, e)) throw new NotSharedError("This item belongs to a different Notion database.");
    return page;
  }

  function relContains(e: DbEntry, pk: string, id: string): FilterItem {
    return { property: e.props[pk], relation: { contains: normalizeId(id) } };
  }
  function notArchived(e: DbEntry): FilterItem {
    return { property: e.props.archived, checkbox: { equals: false } };
  }
  function all(...items: (FilterItem | undefined | false)[]): QueryFilter | undefined {
    const list = items.filter((x): x is FilterItem => !!x);
    if (list.length === 0) return undefined;
    if (list.length === 1) return list[0] as QueryFilter;
    return { and: list };
  }

  /** Adds select options (e.g. a new Customer) before pages use them, so Notion never auto-creates them. */
  async function ensureOptions(e: DbEntry, pk: string, names: (string | null | undefined)[]): Promise<void> {
    const wanted = names.map((n) => sanitizeSelectName(n)).filter((n): n is string => !!n);
    const known = (e.options[pk] ??= {});
    const missing = wanted.filter((n) => !(n in known));
    if (!missing.length) return;
    const ds = await dsScoped(notion.dataSources.retrieve({ data_source_id: e.dataSourceId }));
    const prop = isFullDataSource(ds) ? Object.values(ds.properties).find((p) => sameId(p.id, e.props[pk])) : undefined;
    if (!prop || prop.type !== "select") return;
    const current = prop.select.options;
    const add = missing.filter((n) => !current.some((o) => o.name === n));
    if (add.length) {
      await notion.dataSources.update({
        data_source_id: e.dataSourceId,
        properties: {
          [e.props[pk]]: {
            select: { options: [...current.map((o) => ({ id: o.id, name: o.name })), ...add.map((name) => ({ name }))] },
          },
        },
      });
    }
    for (const o of current) known[o.name] = o.id;
    for (const n of add) known[n] = known[n] ?? "";
  }

  // -- mapping: milestones -----------------------------------------------------
  function toMilestone(r: Row): Milestone {
    return compact({
      id: r.id,
      key: r.text("key"),
      name: r.text("name"),
      description: r.text("description"),
      fieldType: fieldTypeOf(r.select("fieldType")),
      choices: r.json<Choice[]>("choices", []),
      config: r.json<FieldConfig>("config", {}),
      order: r.num("order") ?? 0,
      archived: r.bool("archived"),
      archivedAt: r.instant("archivedAt"),
      archiveBatch: r.optText("archiveBatch"),
      createdAt: r.created,
      updatedAt: r.edited,
    });
  }
  function milestoneWrites(e: DbEntry, m: Partial<MilestoneInput>): Writes {
    const w = new Writes(e);
    if (has(m, "name")) w.title("name", m.name, "The milestone name");
    if (has(m, "key")) w.text("key", m.key);
    if (has(m, "fieldType") && m.fieldType) w.select("fieldType", FIELD_TYPE_LABELS[m.fieldType]);
    if (has(m, "choices")) {
      w.json("choices", m.choices ?? [], "The choice list");
      w.mirror("choicesReadable", choicesReadable(m.choices ?? []));
    }
    if (has(m, "config")) w.json("config", m.config ?? {});
    if (has(m, "description")) w.text("description", m.description, "The description");
    if (has(m, "order")) w.num("order", m.order);
    if (has(m, "archived")) w.bool("archived", m.archived);
    if (has(m, "archivedAt")) w.instant("archivedAt", m.archivedAt);
    if (has(m, "archiveBatch")) w.text("archiveBatch", m.archiveBatch);
    return w;
  }

  // -- mapping: project fields -------------------------------------------------
  function toProjectField(r: Row): ProjectField {
    const sk = r.text("systemKey");
    return compact({
      id: r.id,
      key: r.text("key"),
      label: r.text("label"),
      fieldType: fieldTypeOf(r.select("fieldType")),
      choices: r.json<Choice[]>("choices", []),
      config: r.json<FieldConfig>("config", {}),
      order: r.num("order") ?? 0,
      showInSummary: r.bool("showInSummary"),
      systemKey: sk === "customer" || sk === "projectType" ? (sk as SystemFieldKey) : undefined,
      archived: r.bool("archived"),
      archivedAt: r.instant("archivedAt"),
    });
  }
  function projectFieldWrites(e: DbEntry, f: Partial<ProjectFieldInput>): Writes {
    const w = new Writes(e);
    if (has(f, "label")) w.title("label", f.label, "The field label");
    if (has(f, "key")) w.text("key", f.key);
    if (has(f, "fieldType") && f.fieldType) w.select("fieldType", FIELD_TYPE_LABELS[f.fieldType]);
    if (has(f, "choices")) w.json("choices", f.choices ?? [], "The choice list");
    if (has(f, "config")) w.json("config", f.config ?? {});
    if (has(f, "order")) w.num("order", f.order);
    if (has(f, "showInSummary")) w.bool("showInSummary", f.showInSummary);
    if (has(f, "systemKey")) w.text("systemKey", f.systemKey ?? "");
    if (has(f, "archived")) w.bool("archived", f.archived);
    if (has(f, "archivedAt")) w.instant("archivedAt", f.archivedAt);
    return w;
  }

  // -- mapping: projects -------------------------------------------------------
  /** Property ids the Project mapping reads (everything except the back-relation and the mirrors). */
  function projectReadProps(e: DbEntry): string[] {
    const skip = new Set(["steps", "customer", "projectType", "summary", "current"]);
    return Object.entries(e.props)
      .filter(([pk]) => !skip.has(pk))
      .map(([, id]) => id);
  }
  function toProject(r: Row): Project {
    const pct = r.num("progress");
    const setup = r.select("setup");
    return compact({
      id: r.id,
      code: r.text("code"),
      name: r.text("name"),
      status: fromLabel(PROJECT_STATUS_LABELS, r.select("status")) ?? "ACTIVE",
      details: r.json<Project["details"]>("details", {}),
      flow: r.json<Flow>("flow", EMPTY_FLOW),
      cells: r.json<Project["cells"]>("cells", {}),
      progress: pct === null ? 0 : Math.round(pct * 10_000) / 100,
      templateRevision: r.num("templateRevision") ?? 0,
      syncDismissed: r.json<Record<string, string>>("syncDismissed", {}),
      setup: setup && setup.toLowerCase() === SETUP_LABELS.CREATING.toLowerCase() ? "CREATING" : "READY",
      archived: r.bool("archived"),
      archivedAt: r.instant("archivedAt"),
      createdAt: r.created,
      updatedAt: r.edited,
    } satisfies Project);
  }
  async function projectWrites(e: DbEntry, p: Partial<ProjectInput>): Promise<Writes> {
    const w = new Writes(e);
    if (has(p, "code")) w.title("code", (p.code ?? "").trim().toUpperCase(), "The project code");
    if (has(p, "name")) w.text("name", p.name, "The project name");
    if (has(p, "status") && p.status) w.select("status", PROJECT_STATUS_LABELS[p.status]);
    if (has(p, "details")) w.json("details", p.details ?? {}, "The project details");
    if (has(p, "flow")) w.json("flow", p.flow ?? EMPTY_FLOW, "The project flow");
    if (has(p, "cells")) w.json("cells", p.cells ?? {}, "The project cells");
    if (has(p, "progress")) w.num("progress", p.progress === undefined ? null : Math.round(p.progress * 100) / 10_000);
    if (has(p, "templateRevision")) w.num("templateRevision", p.templateRevision);
    if (has(p, "syncDismissed")) w.json("syncDismissed", p.syncDismissed ?? {});
    if (has(p, "setup") && p.setup) w.select("setup", SETUP_LABELS[p.setup]);
    if (has(p, "archived")) w.bool("archived", p.archived);
    if (has(p, "archivedAt")) w.instant("archivedAt", p.archivedAt);
    const m = p.mirrors;
    if (m) {
      if (has(m, "customer")) {
        await ensureOptions(e, "customer", [m.customer]);
        w.select("customer", m.customer);
      }
      if (has(m, "projectType")) {
        await ensureOptions(e, "projectType", [m.projectType]);
        w.select("projectType", m.projectType);
      }
      if (has(m, "summary")) w.mirror("summary", m.summary);
      if (has(m, "current")) w.mirror("current", m.current);
    }
    return w;
  }

  // -- mapping: steps -----------------------------------------------------------
  function toStep(r: Row): StoredStep {
    return compact({
      id: r.id,
      projectId: r.ids("project")[0] ?? "",
      milestoneId: r.ids("milestone")[0],
      milestoneKey: r.optText("milestoneKey"),
      name: r.text("name"),
      description: r.text("description"),
      fieldType: fieldTypeOf(r.select("fieldType")),
      choices: r.json<Choice[]>("choices", []),
      config: r.json<FieldConfig>("config", {}),
      value: r.json<Value | null>("valueData", null),
      notApplicable: r.bool("notApplicable"),
      flag: fromLabel(FLAG_LABELS, r.select("flag")) ?? null,
      order: r.num("order") ?? 0,
      valueSetAt: r.instant("valueSetAt"),
      stateChangedAt: r.instant("stateChangedAt"),
      lastChangedAt: r.instant("lastChangedAt"),
      rev: r.num("rev") ?? 0,
      archived: r.bool("archived"),
      archivedAt: r.instant("archivedAt"),
      archiveBatch: r.optText("archiveBatch"),
      stepKey: r.text("stepKey"),
      lastOp: r.optText("lastOp"),
      createdAt: r.created,
      updatedAt: r.edited,
    } satisfies StoredStep);
  }
  function stepWrites(e: DbEntry, s: Partial<StepInput>): Writes {
    const w = new Writes(e);
    if (has(s, "name")) w.title("name", s.name, "The step name");
    if (has(s, "projectId")) w.rel("project", [s.projectId]);
    if (has(s, "milestoneId")) w.rel("milestone", [s.milestoneId]);
    if (has(s, "milestoneKey")) w.text("milestoneKey", s.milestoneKey);
    if (has(s, "fieldType") && s.fieldType) w.select("fieldType", FIELD_TYPE_LABELS[s.fieldType]);
    if (has(s, "choices")) w.json("choices", s.choices ?? [], "The choice list");
    if (has(s, "config")) w.json("config", s.config ?? {});
    if (has(s, "description")) w.text("description", s.description, "The description");
    if (has(s, "value")) {
      w.json("valueData", s.value ?? null, "The value");
      w.dateRange("date", dateMirror(s.value));
    }
    const display = s.mirrors?.display ?? (has(s, "value") ? simpleDisplay(s.value, s.choices) : undefined);
    if (display !== undefined) w.mirror("value", display);
    if (has(s, "notApplicable")) w.bool("notApplicable", s.notApplicable);
    if (has(s, "flag")) w.select("flag", s.flag ? FLAG_LABELS[s.flag] : null);
    const state = s.mirrors?.state ?? (s.notApplicable ? "NOT_APPLICABLE" : s.flag ? s.flag : undefined);
    if (state) w.select("state", STATE_LABELS[state]);
    if (has(s, "order")) w.num("order", s.order);
    if (has(s, "valueSetAt")) w.instant("valueSetAt", s.valueSetAt);
    if (has(s, "stateChangedAt")) w.instant("stateChangedAt", s.stateChangedAt);
    if (has(s, "lastChangedAt")) w.instant("lastChangedAt", s.lastChangedAt);
    if (has(s, "rev")) w.num("rev", s.rev);
    if (has(s, "archived")) w.bool("archived", s.archived);
    if (has(s, "archivedAt")) w.instant("archivedAt", s.archivedAt);
    if (has(s, "archiveBatch")) w.text("archiveBatch", s.archiveBatch);
    if (has(s, "stepKey")) w.text("stepKey", s.stepKey);
    if (has(s, "lastOp")) w.text("lastOp", s.lastOp);
    return w;
  }

  // -- mapping: history -----------------------------------------------------------
  function toHistory(r: Row): StoredHistoryEvent {
    const seq = r.num("seq") ?? 0;
    const source = fromLabel(SOURCE_LABELS, r.select("source")) ?? "SYSTEM";
    return compact({
      id: r.id,
      projectId: r.ids("project")[0],
      stepId: r.ids("step")[0],
      milestoneId: r.ids("milestone")[0],
      milestoneKey: r.optText("milestoneKey"),
      type: r.select("type") ?? "",
      source,
      actor: r.text("actor"),
      summary: r.text("summary"),
      oldDisplay: r.optText("oldValue"),
      newDisplay: r.optText("newValue"),
      data: r.json<Record<string, unknown> | undefined>("data", undefined),
      correlationId: r.optText("correlation"),
      externalRef: r.optText("externalRef"),
      occurredAt: normInstant(r.text("occurredAtExact")) ?? r.instant("occurredAt") ?? r.created,
      recordedAt: seq > 0 ? new Date(Math.floor(seq / 1000)).toISOString() : r.created,
      opId: r.optText("opId"),
      seq,
      hash: r.optText("hash"),
    } satisfies StoredHistoryEvent);
  }

  function historyFilter(e: DbEntry, q: HistoryQuery | undefined, scope?: FilterItem): QueryFilter | undefined {
    return all(
      scope,
      q?.type ? { property: e.props.type, select: { equals: sanitizeSelectName(q.type) ?? q.type } } : undefined,
      q?.source ? { property: e.props.source, select: { equals: SOURCE_LABELS[q.source] } } : undefined,
    );
  }

  async function historyPage(reg: Registry, q: HistoryQuery | undefined, scope?: (e: DbEntry) => FilterItem): Promise<Page<StoredHistoryEvent>> {
    const e = entry(reg, "history");
    const limit = Math.min(100, Math.max(1, Math.floor(q?.limit ?? 25)));
    const res = await query(e, {
      filter: historyFilter(e, q, scope?.(e)),
      sorts: [
        { property: e.props.seq, direction: "descending" },
        { timestamp: "created_time", direction: "descending" },
      ],
      page_size: limit,
      start_cursor: q?.cursor ?? undefined,
    });
    return {
      items: res.results.filter(isFullPage).map((p) => toHistory(new Row(p, e))),
      nextCursor: res.has_more ? res.next_cursor : null,
    };
  }

  // -- mapping: notes / attachments -------------------------------------------------
  function toNote(r: Row): Note {
    return compact({
      id: r.id,
      projectId: r.ids("project")[0] ?? "",
      stepId: r.ids("step")[0],
      body: r.text("body"),
      author: r.text("author"),
      archived: r.bool("archived"),
      createdAt: r.instant("createdAt") ?? r.created,
      editedAt: r.instant("editedAt"),
    } satisfies Note);
  }
  function noteWrites(e: DbEntry, n: Partial<NoteInput> & { editedAt?: string }): Writes {
    const w = new Writes(e);
    if (has(n, "body")) {
      const body = n.body ?? "";
      const firstLine = body.split(/\r?\n/).find((l) => l.trim()) ?? "";
      w.title("title", truncateText(firstLine.trim(), 200));
      w.text("body", body, "The note");
    }
    if (has(n, "projectId")) w.rel("project", [n.projectId]);
    if (has(n, "stepId")) w.rel("step", [n.stepId]);
    if (has(n, "author")) w.text("author", n.author);
    if (has(n, "archived")) w.bool("archived", n.archived);
    if (has(n, "editedAt")) w.instant("editedAt", n.editedAt);
    return w;
  }

  function toAttachment(r: Row): Attachment {
    const kind = fromLabel(KIND_LABELS, r.select("kind")) ?? (r.url("link") ? "LINK" : "FILE");
    return compact({
      id: r.id,
      projectId: r.ids("project")[0] ?? "",
      stepId: r.ids("step")[0],
      kind,
      name: r.text("name"),
      url: kind === "LINK" ? (r.url("link") ?? undefined) : undefined,
      size: r.num("size") ?? undefined,
      contentType: r.optText("contentType"),
      archived: r.bool("archived"),
      createdAt: r.instant("createdAt") ?? r.created,
    } satisfies Attachment);
  }

  // -- the Repo ----------------------------------------------------------------------
  const repo: Repo = {
    settings: {
      get: <T = unknown>(key: string) =>
        call(async (reg) => {
          const e = entry(reg, "settings");
          const row = await dsScoped(findSettingRow(notion, e, key));
          if (!row) return undefined;
          return new Row(row, e).json<T | undefined>("value", undefined);
        }),
      set: (key, value) =>
        call(async (reg) => {
          await dsScoped(upsertSettingRow(notion, entry(reg, "settings"), key, value));
        }),
      list: (prefix) =>
        call(async (reg) => {
          const e = entry(reg, "settings");
          const pages = await queryAll(e, {
            filter: prefix ? { property: e.props.key, title: { starts_with: prefix } } : undefined,
            sorts: [{ timestamp: "created_time", direction: "ascending" }],
          });
          const out: Record<string, unknown> = {};
          for (const p of pages) {
            const r = new Row(p, e);
            const k = r.text("key");
            if (!k || (prefix && !k.startsWith(prefix)) || k in out) continue;
            out[k] = r.json<unknown>("value", undefined);
          }
          return out;
        }),
    },

    milestones: {
      list: (opts) =>
        call(async (reg) => {
          const e = entry(reg, "milestones");
          const pages = await queryAll(e, {
            filter: opts?.includeArchived ? undefined : notArchived(e),
            sorts: [{ property: e.props.order, direction: "ascending" }],
          });
          return pages.map((p) => toMilestone(new Row(p, e)));
        }),
      get: (id) =>
        call(async (reg) => {
          const e = entry(reg, "milestones");
          const p = await getPage(e, id);
          return p ? toMilestone(new Row(p, e)) : null;
        }),
      create: (input) =>
        call(async (reg) => {
          const e = entry(reg, "milestones");
          return toMilestone(new Row(await createPage(e, milestoneWrites(e, input)), e));
        }),
      update: (id, patch) =>
        call(async (reg) => {
          const e = entry(reg, "milestones");
          return toMilestone(new Row(await updatePage(e, id, milestoneWrites(e, patch)), e));
        }),
    },

    projectFields: {
      list: (opts) =>
        call(async (reg) => {
          const e = entry(reg, "projectFields");
          const pages = await queryAll(e, {
            filter: opts?.includeArchived ? undefined : notArchived(e),
            sorts: [{ property: e.props.order, direction: "ascending" }],
          });
          return pages.map((p) => toProjectField(new Row(p, e)));
        }),
      create: (input) =>
        call(async (reg) => {
          const e = entry(reg, "projectFields");
          return toProjectField(new Row(await createPage(e, projectFieldWrites(e, input)), e));
        }),
      update: (id, patch) =>
        call(async (reg) => {
          const e = entry(reg, "projectFields");
          return toProjectField(new Row(await updatePage(e, id, projectFieldWrites(e, patch)), e));
        }),
    },

    projects: {
      list: (opts) =>
        call(async (reg) => {
          const e = entry(reg, "projects");
          const pages = await queryAll(e, {
            filter: opts?.includeArchived ? undefined : notArchived(e),
            sorts: [{ property: e.props.code, direction: "ascending" }],
            filter_properties: projectReadProps(e),
          });
          return pages.map((p) => toProject(new Row(p, e)));
        }),
      get: (id) =>
        call(async (reg) => {
          const e = entry(reg, "projects");
          const p = await getPage(e, id, projectReadProps(e));
          return p ? toProject(new Row(p, e)) : null;
        }),
      findByCode: (code) =>
        call(async (reg) => {
          const e = entry(reg, "projects");
          const wanted = code.trim().toUpperCase();
          if (!wanted) return null;
          const res = await query(e, {
            filter: { property: e.props.code, title: { equals: wanted } },
            sorts: [{ timestamp: "created_time", direction: "ascending" }],
            page_size: 10,
            filter_properties: projectReadProps(e),
          });
          const hit = res.results.filter(isFullPage).find((p) => new Row(p, e).text("code").trim().toUpperCase() === wanted);
          return hit ? toProject(new Row(hit, e)) : null;
        }),
      create: (input) =>
        call(async (reg) => {
          const e = entry(reg, "projects");
          return toProject(new Row(await createPage(e, await projectWrites(e, input), projectReadProps(e)), e));
        }),
      update: (id, patch) =>
        call(async (reg) => {
          const e = entry(reg, "projects");
          return toProject(new Row(await updatePage(e, id, await projectWrites(e, patch), projectReadProps(e)), e));
        }),
    },

    steps: {
      listByProject: (projectId, opts) =>
        call(async (reg) => {
          const e = entry(reg, "steps");
          const pages = await queryAll(e, {
            filter: all(relContains(e, "project", projectId), opts?.includeArchived ? undefined : notArchived(e)),
            sorts: [
              { property: e.props.order, direction: "ascending" },
              { timestamp: "created_time", direction: "ascending" },
            ],
          });
          return pages.map((p) => toStep(new Row(p, e)));
        }),
      get: (id) =>
        call(async (reg) => {
          const e = entry(reg, "steps");
          const p = await getPage(e, id);
          return p ? toStep(new Row(p, e)) : null;
        }),
      create: (input) =>
        call(async (reg) => {
          const e = entry(reg, "steps");
          const stepKey = input.stepKey || `${normalizeId(input.projectId)}:${input.milestoneId ?? crypto.randomUUID()}`;
          return toStep(new Row(await createPage(e, stepWrites(e, { ...input, stepKey })), e));
        }),
      update: (id, patch) =>
        call(async (reg) => {
          const e = entry(reg, "steps");
          return toStep(new Row(await updatePage(e, id, stepWrites(e, patch)), e));
        }),
    },

    history: {
      append: (event) =>
        call(async (reg) => {
          const e = entry(reg, "history");
          const dataJson = event.data === undefined ? undefined : JSON.stringify(event.data);
          const data =
            dataJson !== undefined && dataJson.length > HISTORY_DATA_MAX_CHARS
              ? { truncated: true, chars: dataJson.length }
              : event.data;
          const row: Omit<StoredHistoryEvent, "id" | "recordedAt" | "hash"> = compact({
            opId: event.opId,
            seq: nextSeq(),
            type: sanitizeSelectName(event.type) ?? event.type,
            source: event.source,
            actor: event.actor,
            summary: truncateText(event.summary, 2000),
            projectId: event.projectId ? normalizeId(event.projectId) : undefined,
            stepId: event.stepId ? normalizeId(event.stepId) : undefined,
            milestoneId: event.milestoneId ? normalizeId(event.milestoneId) : undefined,
            milestoneKey: event.milestoneKey || undefined,
            oldDisplay: event.oldDisplay ? truncateText(event.oldDisplay, 2000) : undefined,
            newDisplay: event.newDisplay ? truncateText(event.newDisplay, 2000) : undefined,
            data: data === undefined ? undefined : (JSON.parse(JSON.stringify(data)) as Record<string, unknown>),
            correlationId: event.correlationId || undefined,
            externalRef: event.externalRef || undefined,
            occurredAt: normInstant(event.occurredAt) ?? event.occurredAt,
          });
          const hash = historyHash(row);
          const w = new Writes(e)
            .title("summary", row.summary)
            .rel("project", [row.projectId])
            .rel("step", [row.stepId])
            .rel("relatedSteps", relatedStepIds(row.data, row.stepId))
            .rel("milestone", [row.milestoneId])
            .text("milestoneKey", row.milestoneKey)
            .select("type", row.type)
            .select("source", SOURCE_LABELS[row.source as EventSource])
            .text("actor", row.actor)
            .text("oldValue", row.oldDisplay)
            .text("newValue", row.newDisplay)
            .json("data", row.data, "The history data")
            .text("correlation", row.correlationId)
            .text("externalRef", row.externalRef)
            .instant("occurredAt", row.occurredAt)
            .text("occurredAtExact", row.occurredAt)
            .num("seq", row.seq)
            .text("opId", row.opId)
            .text("hash", hash);
          try {
            return toHistory(new Row(await createPage(e, w), e));
          } catch (err) {
            // A related step that no longer exists must not lose the log row (Related steps is not hashed).
            const relId = e.props.relatedSteps;
            const rel = w.props[relId];
            if (!isNotionCode(err, "validation_error") || !rel || !("relation" in rel) || rel.relation.length === 0) throw err;
            w.props[relId] = { relation: [] };
            return toHistory(new Row(await createPage(e, w), e));
          }
        }),
      hasOp: (opId) =>
        call(async (reg) => {
          const e = entry(reg, "history");
          if (!opId) return false;
          const res = await query(e, {
            filter: { property: e.props.opId, rich_text: { equals: opId } },
            page_size: 5,
            filter_properties: [e.props.opId],
          });
          return res.results.filter(isFullPage).some((p) => new Row(p, e).text("opId") === opId);
        }),
      listByStep: (stepId, q) =>
        call((reg) =>
          historyPage(reg, q, (e) => ({ or: [relContains(e, "step", stepId), relContains(e, "relatedSteps", stepId)] }) as FilterItem),
        ),
      listByProject: (projectId, q) => call((reg) => historyPage(reg, q, (e) => relContains(e, "project", projectId))),
      listAll: (q) => call((reg) => historyPage(reg, q)),
    },

    notes: {
      listByProject: (projectId, opts) =>
        call(async (reg) => {
          const e = entry(reg, "notes");
          const pages = await queryAll(e, {
            filter: all(relContains(e, "project", projectId), opts?.includeArchived ? undefined : notArchived(e)),
            sorts: [
              { property: e.props.createdAt, direction: "descending" },
              { timestamp: "created_time", direction: "descending" },
            ],
          });
          return pages.map((p) => toNote(new Row(p, e)));
        }),
      create: (input) =>
        call(async (reg) => {
          const e = entry(reg, "notes");
          const w = noteWrites(e, input).instant("createdAt", createdNow());
          return toNote(new Row(await createPage(e, w), e));
        }),
      update: (id, patch) =>
        call(async (reg) => {
          const e = entry(reg, "notes");
          return toNote(new Row(await updatePage(e, id, noteWrites(e, patch)), e));
        }),
    },

    attachments: {
      listByProject: (projectId, opts) =>
        call(async (reg) => {
          const e = entry(reg, "files");
          const pages = await queryAll(e, {
            filter: all(relContains(e, "project", projectId), opts?.includeArchived ? undefined : notArchived(e)),
            sorts: [
              { property: e.props.createdAt, direction: "ascending" },
              { timestamp: "created_time", direction: "ascending" },
            ],
          });
          return pages.map((p) => toAttachment(new Row(p, e)));
        }),
      get: (id) =>
        call(async (reg) => {
          const e = entry(reg, "files");
          const p = await getPage(e, id);
          return p ? toAttachment(new Row(p, e)) : null;
        }),
      createLink: (input) =>
        call(async (reg) => {
          const e = entry(reg, "files");
          if (input.url.length > 2000) throw new ValueTooLargeError("Links can be at most 2,000 characters long.");
          const w = new Writes(e)
            .title("name", input.name || input.url, "The link name")
            .rel("project", [input.projectId])
            .rel("step", [input.stepId])
            .select("kind", KIND_LABELS.LINK)
            .url("link", input.url)
            .bool("archived", false)
            .instant("createdAt", createdNow());
          return toAttachment(new Row(await createPage(e, w), e));
        }),
      createFile: (input) =>
        call(async (reg) => {
          const e = entry(reg, "files");
          const size = Math.max(input.size, input.data.size);
          if (size > MAX_FILE_BYTES) throw new FileTooLargeError(size, MAX_FILE_BYTES);
          const up = await notion.fileUploads.create({
            mode: "single_part",
            filename: input.name,
            content_type: input.contentType || "application/octet-stream",
          });
          await notion.fileUploads.send({ file_upload_id: up.id, file: { filename: input.name, data: input.data } });
          const w = new Writes(e)
            .title("name", input.name, "The file name")
            .rel("project", [input.projectId])
            .rel("step", [input.stepId])
            .select("kind", KIND_LABELS.FILE)
            .raw("file", { files: [{ type: "file_upload", file_upload: { id: up.id }, name: input.name }] })
            .num("size", input.data.size)
            .text("contentType", input.contentType)
            .bool("archived", false)
            .instant("createdAt", createdNow());
          return toAttachment(new Row(await createPage(e, w), e));
        }),
      update: (id, patch) =>
        call(async (reg) => {
          const e = entry(reg, "files");
          const w = new Writes(e);
          if (has(patch, "name")) w.title("name", patch.name, "The name");
          if (has(patch, "archived")) w.bool("archived", patch.archived);
          if (has(patch, "archivedAt")) w.instant("archivedAt", patch.archivedAt);
          return toAttachment(new Row(await updatePage(e, id, w), e));
        }),
      openFile: (id) =>
        call(async (reg): Promise<FileDownload> => {
          const e = entry(reg, "files");
          const p = await getPage(e, id);
          if (!p) throw new NotSharedError("This file no longer exists in Notion.");
          const r = new Row(p, e);
          const f = r.files("file")[0];
          if (!f) throw new NotionError("This attachment has no file.", { code: "no_file" });
          return compact({ url: f.url, name: r.text("name") || f.name, contentType: r.optText("contentType"), size: r.num("size") ?? undefined });
        }),
    },
  };
  return repo;
}
