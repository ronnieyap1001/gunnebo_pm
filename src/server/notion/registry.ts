import "server-only";
import { extractNotionId, isFullBlock, isFullDatabase, isFullDataSource, isFullPage } from "@notionhq/client";
import type { DatabaseObjectResponse, DataSourceObjectResponse, PageObjectResponse } from "@notionhq/client";
import type { SetupStatus, SetupStepResult, StorageAdmin, StorageMode } from "@/server/repo/types";
import type { DataSourceUpdateArgs, EnvLike, NotionLike, PropertyConfig, PropValue, QueryFilter } from "./client";
import { storageMode } from "./client";
import {
  NotConfiguredError,
  NotSharedError,
  NotionError,
  SetupIncompleteError,
  isNotionCode,
  mapNotionError,
} from "./errors";
import { jsonToRichText, richTextToJson, richTextToText, textToRichText, titleOf } from "./richtext";
import {
  DB_ORDER,
  SCHEMA,
  SCHEMA_VERSION,
  dbDescription,
  dbKeyFrom,
  parseDbMarker,
  parseMapPointer,
  parsePropMarker,
  propertyConfig,
  type DbKey,
} from "./schema";

/**
 * Schema registry: where each app database lives in Notion and the id of every property.
 *
 * Discovery (one pass, ~2 + 2×8 requests): parent page (NOTION_PARENT_PAGE_ID or an exact-title search) →
 * its child_database blocks → databases.retrieve (description marker `gunnebo-pm:<key>:v1`, title as fallback)
 * → dataSources.retrieve (property ids). Each property is matched by its description marker `[gpm:<key>]`,
 * then by the id saved in Settings 'schema.registry', then by name, so renaming a property in Notion
 * never breaks the app.
 *
 * Caching: `createRegistryHandle` memoises the registry per instance (complete: 1 h, incomplete: 10 s) and
 * accepts an external `loader`, so the app can wrap `discoverRegistry` with Next's unstable_cache
 * (this module does not import next/*). After a stale-id error the memo is dropped and the next load
 * bypasses the external loader once.
 */

export interface DbEntry {
  key: DbKey;
  /** Current title in Notion. */
  title: string;
  databaseId: string;
  dataSourceId: string;
  url?: string;
  locked: boolean;
  matchedBy: "marker" | "title";
  /** Logical property key → Notion property id. */
  props: Record<string, string>;
  /** Logical property key → current Notion name. */
  propNames: Record<string, string>;
  /** Logical keys the schema expects but Notion does not have (Setup adds them). */
  missing: string[];
  /** Select property key → option name → option id (every option currently defined). */
  options: Record<string, Record<string, string>>;
  /** Settings only: the page id of the 'schema.registry' row, from the `[map:…]` pointer in the description. */
  mapPageId?: string;
}

export interface SavedMap {
  v: 1;
  schemaVersion: number;
  dbs: Partial<Record<DbKey, { databaseId: string; dataSourceId: string; props: Record<string, string> }>>;
}

export interface Registry {
  schemaVersion: number;
  mode: StorageMode;
  parent: { id: string; title: string; url?: string } | null;
  dbs: Partial<Record<DbKey, DbEntry>>;
  /** Blocking problems in plain English. */
  problems: string[];
  /** Non-blocking notes (e.g. two databases with the same marker). */
  warnings: string[];
  /** The map stored in Settings 'schema.registry' at discovery time. */
  saved: SavedMap | null;
  discoveredAt: string;
}

export interface RegistryOptions {
  mode?: StorageMode;
  /** Defaults to env NOTION_PARENT_PAGE_ID. */
  parentPageId?: string;
  /** Defaults to 'Gunnebo PM', or 'Gunnebo PM (Preview)' when VERCEL_ENV is 'preview'. */
  parentTitle?: string;
  /** Create the parent page when it is missing (default: only in fake mode). */
  createParentIfMissing?: boolean;
}

export const SETTINGS_REGISTRY_KEY = "schema.registry";
export const SETTINGS_SCHEMA_VERSION_KEY = "schema.version";
export const SETTINGS_SEED_KEY = "seed.appliedAt";

export function parentTitleFor(env: EnvLike = process.env): string {
  return env.VERCEL_ENV === "preview" ? "Gunnebo PM (Preview)" : "Gunnebo PM";
}

function resolveOptions(opts: RegistryOptions = {}): Required<Omit<RegistryOptions, "parentPageId">> & { parentPageId?: string } {
  const mode = opts.mode ?? storageMode();
  return {
    mode,
    parentPageId: opts.parentPageId ?? (process.env.NOTION_PARENT_PAGE_ID || undefined),
    parentTitle: opts.parentTitle ?? parentTitleFor(),
    createParentIfMissing: opts.createParentIfMissing ?? mode === "fake",
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sameId(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  try {
    return decodeURIComponent(a) === decodeURIComponent(b);
  } catch {
    return false;
  }
}

function normPageId(id: string): string {
  return id.replace(/-/g, "").toLowerCase();
}

function pageTitle(p: PageObjectResponse): string {
  for (const v of Object.values(p.properties)) if (v.type === "title") return titleOf(v);
  return "";
}

/** Value of a page property looked up by property id. */
export function propById(page: PageObjectResponse, id: string | undefined): PropValue | undefined {
  if (!id) return undefined;
  for (const v of Object.values(page.properties)) if (sameId(v.id, id)) return v;
  return undefined;
}

async function listChildDatabases(notion: NotionLike, pageId: string): Promise<{ id: string; title: string }[]> {
  const out: { id: string; title: string }[] = [];
  let cursor: string | undefined;
  do {
    const res = await notion.blocks.children.list({ block_id: pageId, page_size: 100, start_cursor: cursor });
    for (const b of res.results) {
      if (isFullBlock(b) && b.type === "child_database") out.push({ id: b.id, title: b.child_database.title });
    }
    cursor = res.has_more && res.next_cursor ? res.next_cursor : undefined;
  } while (cursor);
  return out;
}

async function findParent(
  notion: NotionLike,
  o: ReturnType<typeof resolveOptions>,
): Promise<{ parent: Registry["parent"]; problems: string[] }> {
  if (o.parentPageId) {
    const id = extractNotionId(o.parentPageId);
    if (!id) return { parent: null, problems: ["NOTION_PARENT_PAGE_ID is not a valid Notion page id or link."] };
    try {
      const p = await notion.pages.retrieve({ page_id: id });
      if (!isFullPage(p)) return { parent: null, problems: ["Notion returned an incomplete page for NOTION_PARENT_PAGE_ID."] };
      if (p.in_trash) return { parent: null, problems: ["The page in NOTION_PARENT_PAGE_ID is in Notion's trash. Restore it first."] };
      return { parent: { id: p.id, title: pageTitle(p), url: p.url }, problems: [] };
    } catch (e) {
      if (isNotionCode(e, "object_not_found") || isNotionCode(e, "validation_error")) {
        return {
          parent: null,
          problems: ["Notion cannot see the page in NOTION_PARENT_PAGE_ID. Open it in Notion, then ··· → Connections → add the integration."],
        };
      }
      throw e;
    }
  }

  const title = o.parentTitle;
  const matches: PageObjectResponse[] = [];
  let cursor: string | undefined;
  let rounds = 0;
  do {
    const res = await notion.search({ query: title, filter: { property: "object", value: "page" }, page_size: 100, start_cursor: cursor });
    for (const r of res.results) {
      if (r.object !== "page" || !isFullPage(r) || r.in_trash) continue;
      if (r.parent.type !== "workspace" && r.parent.type !== "page_id") continue;
      if (pageTitle(r).trim() === title) matches.push(r);
    }
    cursor = res.has_more && res.next_cursor ? res.next_cursor : undefined;
  } while (cursor && ++rounds < 5);

  if (matches.length === 1) {
    const p = matches[0];
    return { parent: { id: p.id, title, url: p.url }, problems: [] };
  }
  if (matches.length > 1) {
    return {
      parent: null,
      problems: [`Several Notion pages are called "${title}". Put the link of the right one into NOTION_PARENT_PAGE_ID and redeploy.`],
    };
  }
  if (o.createParentIfMissing) {
    const p = await notion.pages.create({
      parent: { type: "workspace", workspace: true },
      properties: { title: { title: textToRichText(title) } },
    });
    if (isFullPage(p)) return { parent: { id: p.id, title, url: p.url }, problems: [] };
  }
  return {
    parent: null,
    problems: [
      `No Notion page called "${title}" is shared with the integration. Create the page in Notion, then open its ··· menu → Connections and add the integration. (New pages can take a minute to appear.)`,
    ],
  };
}

type DsProps = DataSourceObjectResponse["properties"];
type DsProp = DsProps[string];

function mapEntry(
  key: DbKey,
  db: DatabaseObjectResponse,
  ds: DataSourceObjectResponse,
  matchedBy: DbEntry["matchedBy"],
  saved: SavedMap | null,
): DbEntry {
  const def = SCHEMA[key];
  const all = Object.values(ds.properties);
  const savedProps = saved?.dbs[key]?.databaseId && normPageId(saved.dbs[key]!.databaseId) === normPageId(db.id) ? saved.dbs[key]!.props : {};
  const entry: DbEntry = {
    key,
    title: richTextToText(db.title),
    databaseId: db.id,
    dataSourceId: ds.id,
    url: db.url,
    locked: db.is_locked,
    matchedBy,
    props: {},
    propNames: {},
    missing: [],
    options: {},
  };
  if (key === "settings") {
    const ptr = parseMapPointer(richTextToText(db.description));
    if (ptr) entry.mapPageId = ptr;
  }
  const used = new Set<string>();
  const take = (pk: string, p: DsProp) => {
    entry.props[pk] = p.id;
    entry.propNames[pk] = p.name;
    used.add(p.id);
    if (p.type === "select") entry.options[pk] = Object.fromEntries(p.select.options.map((o) => [o.name, o.id]));
  };
  for (const [pk, pd] of Object.entries(def.props)) {
    if (pd.backOf) continue;
    const ok = (p: DsProp) => p.type === pd.type && !used.has(p.id);
    const found =
      all.find((p) => ok(p) && parsePropMarker(p.description) === pk) ??
      all.find((p) => ok(p) && sameId(p.id, savedProps[pk])) ??
      all.find((p) => ok(p) && p.name === pd.name && !parsePropMarker(p.description)) ??
      (pd.type === "title" ? all.find((p) => p.type === "title") : undefined);
    if (found) take(pk, found);
    else entry.missing.push(pk);
  }
  return entry;
}

/** Fills Projects' back-relation (`steps`) from Steps.Project's dual_property.synced_property_id. */
function linkBackRelations(dbs: Partial<Record<DbKey, DbEntry>>, dsById: Map<string, DataSourceObjectResponse>): void {
  for (const key of DB_ORDER) {
    for (const [pk, pd] of Object.entries(SCHEMA[key].props)) {
      if (!pd.backOf) continue;
      const self = dbs[key];
      const from = dbs[pd.backOf.db];
      if (!self || !from) continue;
      const fromDs = dsById.get(from.dataSourceId);
      const fwdId = from.props[pd.backOf.prop];
      const fwd = fromDs ? Object.values(fromDs.properties).find((p) => sameId(p.id, fwdId)) : undefined;
      if (!fwd || fwd.type !== "relation" || fwd.relation.type !== "dual_property") continue;
      const syncedId = fwd.relation.dual_property.synced_property_id;
      const selfDs = dsById.get(self.dataSourceId);
      const back = selfDs ? Object.values(selfDs.properties).find((p) => sameId(p.id, syncedId)) : undefined;
      if (back) {
        self.props[pk] = back.id;
        self.propNames[pk] = back.name;
      }
    }
  }
}

/** A live Settings row with exactly this key, read by id (null when gone, trashed, elsewhere or another key). */
async function settingRowById(notion: NotionLike, settings: DbEntry, pageId: string, key: string): Promise<PageObjectResponse | null> {
  try {
    const p = await notion.pages.retrieve({ page_id: pageId });
    if (!isFullPage(p) || p.in_trash || p.parent.type !== "data_source_id") return null;
    if (normPageId(p.parent.data_source_id) !== normPageId(settings.dataSourceId)) return null;
    return titleOf(propById(p, settings.props.key)) === key ? p : null;
  } catch (e) {
    if (isNotionCode(e, "object_not_found") || isNotionCode(e, "validation_error")) return null;
    throw e;
  }
}

async function readSavedMap(notion: NotionLike, settings: DbEntry | undefined): Promise<SavedMap | null> {
  if (!settings?.props.key || !settings.props.value) return null;
  try {
    const row =
      (settings.mapPageId ? await settingRowById(notion, settings, settings.mapPageId, SETTINGS_REGISTRY_KEY) : null) ??
      (await findSettingRow(notion, settings, SETTINGS_REGISTRY_KEY));
    if (!row) return null;
    const saved = richTextToJson<SavedMap | null>(propValueRichText(propById(row, settings.props.value)), null);
    return saved && saved.v === 1 ? saved : null;
  } catch {
    return null;
  }
}

function propValueRichText(v: PropValue | undefined) {
  if (!v) return [];
  if (v.type === "rich_text") return v.rich_text;
  if (v.type === "title") return v.title;
  return [];
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/** One full discovery pass. The result is plain JSON (safe for unstable_cache). */
export async function discoverRegistry(notion: NotionLike, options?: RegistryOptions): Promise<Registry> {
  const o = resolveOptions(options);
  const reg: Registry = {
    schemaVersion: SCHEMA_VERSION,
    mode: o.mode,
    parent: null,
    dbs: {},
    problems: [],
    warnings: [],
    saved: null,
    discoveredAt: new Date().toISOString(),
  };
  if (o.mode === "unconfigured") {
    reg.problems.push(new NotConfiguredError().message);
    return reg;
  }
  try {
    const { parent, problems } = await findParent(notion, o);
    reg.parent = parent;
    reg.problems.push(...problems);
    if (!parent) return reg;

    const children = await listChildDatabases(notion, parent.id);
    const dbs = (
      await Promise.all(
        children.map(async (c) => {
          try {
            const d = await notion.databases.retrieve({ database_id: c.id });
            return isFullDatabase(d) && !d.in_trash ? d : null;
          } catch (e) {
            if (isNotionCode(e, "object_not_found")) return null;
            throw e;
          }
        }),
      )
    ).filter((d): d is DatabaseObjectResponse => d !== null);

    const candidates = new Map<DbKey, { db: DatabaseObjectResponse; by: DbEntry["matchedBy"] }[]>();
    const push = (k: DbKey, db: DatabaseObjectResponse, by: DbEntry["matchedBy"]) => {
      const list = candidates.get(k) ?? [];
      list.push({ db, by });
      candidates.set(k, list);
    };
    for (const db of dbs) {
      const k = parseDbMarker(richTextToText(db.description));
      if (k) push(k, db, "marker");
    }
    for (const db of dbs) {
      if (parseDbMarker(richTextToText(db.description))) continue;
      const k = dbKeyFrom(richTextToText(db.title));
      if (k && !(candidates.get(k) ?? []).some((c) => c.by === "marker")) push(k, db, "title");
    }

    const chosen: { key: DbKey; db: DatabaseObjectResponse; by: DbEntry["matchedBy"] }[] = [];
    for (const key of DB_ORDER) {
      const list = (candidates.get(key) ?? []).sort((a, b) =>
        a.by !== b.by ? (a.by === "marker" ? -1 : 1) : a.db.created_time.localeCompare(b.db.created_time),
      );
      if (list.length === 0) continue;
      if (list.length > 1) {
        reg.warnings.push(
          `Two or more Notion databases look like "${SCHEMA[key].title}". The app uses the oldest one; move the others out of the "${parent.title}" page.`,
        );
      }
      chosen.push({ key, db: list[0].db, by: list[0].by });
    }

    const dsById = new Map<string, DataSourceObjectResponse>();
    await Promise.all(
      chosen.map(async (c) => {
        const dsId = c.db.data_sources[0]?.id;
        if (!dsId) {
          reg.warnings.push(`The Notion database "${SCHEMA[c.key].title}" has no data source.`);
          return;
        }
        const ds = await notion.dataSources.retrieve({ data_source_id: dsId });
        if (isFullDataSource(ds)) dsById.set(ds.id, ds);
      }),
    );

    // Settings first (it holds the saved property-id map used as a fallback for the others).
    const settingsChoice = chosen.find((c) => c.key === "settings");
    if (settingsChoice) {
      const ds = dsById.get(settingsChoice.db.data_sources[0]?.id ?? "");
      if (ds) reg.dbs.settings = mapEntry("settings", settingsChoice.db, ds, settingsChoice.by, null);
      reg.saved = await readSavedMap(notion, reg.dbs.settings);
      if (ds && reg.saved) reg.dbs.settings = mapEntry("settings", settingsChoice.db, ds, settingsChoice.by, reg.saved);
    }
    for (const c of chosen) {
      if (c.key === "settings") continue;
      const ds = dsById.get(c.db.data_sources[0]?.id ?? "");
      if (ds) reg.dbs[c.key] = mapEntry(c.key, c.db, ds, c.by, reg.saved);
    }
    linkBackRelations(reg.dbs, dsById);
  } catch (e) {
    // Busy, unavailable or a bad token: never cache a half-discovered registry; status() shows the message.
    throw mapNotionError(e);
  }
  return reg;
}

/** All databases exist and every property the app reads or writes is mapped. */
export function isComplete(reg: Registry): boolean {
  return !!reg.parent && DB_ORDER.every((k) => reg.dbs[k] && reg.dbs[k]!.missing.length === 0);
}

/**
 * The app can run: every database and property exists and the property-id map is saved in Settings.
 * Cosmetic drift (missing colour options, the Steps link renamed, a database unlocked in Notion) does not count:
 * Setup still fixes it (runSchemaStep reports done only when nothing is left), but the app is not blocked.
 */
export function isSchemaReady(reg: Registry): boolean {
  return isComplete(reg) && sameSaved(reg.saved, savedMapOf(reg));
}

/** Plain-English list of the cosmetic setup work still pending (empty when none, or when the schema is not ready). */
export function cosmeticWork(reg: Registry): string[] {
  if (!isSchemaReady(reg)) return [];
  const out: string[] = [];
  if (DB_ORDER.some((k) => missingOptions(reg.dbs[k]!).length)) out.push("some colour-coded choices are missing");
  for (const key of DB_ORDER) {
    for (const [pk, pd] of Object.entries(SCHEMA[key].props)) {
      const e = reg.dbs[key]!;
      if (pd.backOf && e.props[pk] && e.propNames[pk] !== pd.name) out.push(`the link on ${e.title} is not called "${pd.name}"`);
    }
  }
  const unlocked = DB_ORDER.filter((k) => !reg.dbs[k]!.locked);
  if (unlocked.length) out.push(`${unlocked.map((k) => reg.dbs[k]!.title).join(", ")} ${unlocked.length === 1 ? "is" : "are"} unlocked`);
  return out;
}

export function savedMapOf(reg: Registry): SavedMap {
  const dbs: SavedMap["dbs"] = {};
  for (const k of DB_ORDER) {
    const e = reg.dbs[k];
    if (e) dbs[k] = { databaseId: e.databaseId, dataSourceId: e.dataSourceId, props: { ...e.props } };
  }
  return { v: 1, schemaVersion: SCHEMA_VERSION, dbs };
}

function sameSaved(a: SavedMap | null, b: SavedMap): boolean {
  return !!a && JSON.stringify(a) === JSON.stringify(b);
}

type PendingStep =
  | { kind: "parent" }
  | { kind: "create"; key: DbKey }
  | { kind: "props"; key: DbKey }
  | { kind: "options"; key: DbKey; props: string[] }
  | { kind: "backRelation"; key: DbKey; prop: string; id: string; name: string }
  | { kind: "saveMap" }
  | { kind: "lock"; keys: DbKey[] };

function missingOptions(entry: DbEntry): string[] {
  const out: string[] = [];
  for (const [pk, pd] of Object.entries(SCHEMA[entry.key].props)) {
    if (pd.type !== "select" || !pd.options?.length || !entry.props[pk]) continue;
    const have = entry.options[pk] ?? {};
    if (pd.options.some((o) => !(o.name in have))) out.push(pk);
  }
  return out;
}

/** The next thing Setup has to do, or null when Notion is fully set up. */
export function nextPendingStep(reg: Registry): PendingStep | null {
  if (!reg.parent) return { kind: "parent" };
  for (const key of DB_ORDER) if (!reg.dbs[key]) return { kind: "create", key };
  for (const key of DB_ORDER) if (reg.dbs[key]!.missing.length) return { kind: "props", key };
  for (const key of DB_ORDER) {
    const props = missingOptions(reg.dbs[key]!);
    if (props.length) return { kind: "options", key, props };
  }
  for (const key of DB_ORDER) {
    const e = reg.dbs[key]!;
    for (const [pk, pd] of Object.entries(SCHEMA[key].props)) {
      if (!pd.backOf) continue;
      const id = e.props[pk];
      if (id && e.propNames[pk] !== pd.name) return { kind: "backRelation", key, prop: pk, id, name: pd.name };
    }
  }
  if (!sameSaved(reg.saved, savedMapOf(reg))) return { kind: "saveMap" };
  const unlocked = DB_ORDER.filter((k) => !reg.dbs[k]!.locked);
  if (unlocked.length) return { kind: "lock", keys: unlocked };
  return null;
}

// ---------------------------------------------------------------------------
// Settings rows (used by setup and by the repository)
// ---------------------------------------------------------------------------

/** The Settings row whose Key is exactly `key` (oldest wins if there are duplicates). */
export async function findSettingRow(notion: NotionLike, settings: DbEntry, key: string): Promise<PageObjectResponse | null> {
  const res = await notion.dataSources.query({
    data_source_id: settings.dataSourceId,
    filter: { property: settings.props.key, title: { equals: key } },
    sorts: [{ timestamp: "created_time", direction: "ascending" }],
    page_size: 10,
  });
  for (const r of res.results) {
    if (isFullPage(r) && titleOf(propById(r, settings.props.key)) === key) return r;
  }
  return null;
}

/**
 * Writes one Settings row (used by Setup; the repository has its own cached version). `knownId` is the row's page
 * id when known: it is updated by id, which does not depend on the query index being current. Returns the page id.
 */
export async function upsertSettingRow(notion: NotionLike, settings: DbEntry, key: string, value: unknown, knownId?: string): Promise<string> {
  const properties = {
    [settings.props.key]: { title: textToRichText(key, `Setting ${key}`) },
    [settings.props.value]: { rich_text: jsonToRichText(value, `Setting ${key}`) },
  };
  const existing = (knownId ? await settingRowById(notion, settings, knownId, key) : null) ?? (await findSettingRow(notion, settings, key));
  if (existing) {
    await notion.pages.update({ page_id: existing.id, properties });
    return existing.id;
  }
  const created = await notion.pages.create({ parent: { type: "data_source_id", data_source_id: settings.dataSourceId }, properties });
  return created.id;
}

// ---------------------------------------------------------------------------
// Setup steps
// ---------------------------------------------------------------------------

async function refreshEntry(notion: NotionLike, reg: Registry, key: DbKey, by: DbEntry["matchedBy"] = "marker"): Promise<void> {
  const e = reg.dbs[key];
  const dbId = e?.databaseId;
  if (!dbId) return;
  const db = await notion.databases.retrieve({ database_id: dbId });
  if (!isFullDatabase(db)) return;
  const ds = await notion.dataSources.retrieve({ data_source_id: db.data_sources[0].id });
  if (!isFullDataSource(ds)) return;
  const prev = reg.dbs[key];
  reg.dbs[key] = mapEntry(key, db, ds, prev?.matchedBy ?? by, reg.saved);
  // Back-relations of this database live on others' data sources: relink with fresh copies.
  const dsById = new Map<string, DataSourceObjectResponse>([[ds.id, ds]]);
  for (const k of DB_ORDER) {
    const other = reg.dbs[k];
    if (!other || other.dataSourceId === ds.id) continue;
    const needs =
      Object.values(SCHEMA[k].props).some((p) => p.backOf?.db === key) ||
      Object.values(SCHEMA[key].props).some((p) => p.backOf?.db === k);
    if (!needs) continue;
    const ods = await notion.dataSources.retrieve({ data_source_id: other.dataSourceId });
    if (isFullDataSource(ods)) {
      dsById.set(ods.id, ods);
      const odb = await notion.databases.retrieve({ database_id: other.databaseId });
      if (isFullDatabase(odb)) reg.dbs[k] = mapEntry(k, odb, ods, other.matchedBy, reg.saved);
    }
  }
  linkBackRelations(reg.dbs, dsById);
}

function dsIdResolver(reg: Registry): (k: DbKey) => string {
  return (k) => {
    const id = reg.dbs[k]?.dataSourceId;
    if (!id) throw new SetupIncompleteError(`The "${SCHEMA[k].title}" database must be created first.`);
    return id;
  };
}

const setupMemo = new WeakMap<NotionLike, { reg: Registry; at: number }>();
/** A setup sequence reuses its registry between steps for this long. */
const SETUP_MEMO_TTL_MS = 60_000;

/**
 * During a setup sequence, reuses this instance's last setup registry unless the parent page's child databases
 * changed. Never after setup finished (people may change things in Notion later) and never for longer than a minute.
 */
async function setupRegistry(notion: NotionLike, o: RegistryOptions): Promise<Registry> {
  const held = setupMemo.get(notion);
  const memo = held && Date.now() - held.at < SETUP_MEMO_TTL_MS && nextPendingStep(held.reg) !== null ? held.reg : undefined;
  if (memo?.parent) {
    const children = await listChildDatabases(notion, memo.parent.id);
    const ids = new Set(children.map((c) => normPageId(c.id)));
    const known = Object.values(memo.dbs).map((d) => normPageId(d!.databaseId));
    const titles = new Set(DB_ORDER.map((k) => SCHEMA[k].title.toLowerCase()));
    const unchanged =
      known.every((id) => ids.has(id)) &&
      children.every((c) => known.includes(normPageId(c.id)) || !titles.has(c.title.trim().toLowerCase()));
    if (unchanged) return memo;
  }
  return discoverRegistry(notion, o);
}

/**
 * Does the next piece of setup work (one database, or one schema fix) and says what it did.
 * Idempotent: call repeatedly until `done`.
 */
export async function runSchemaStep(notion: NotionLike, options?: RegistryOptions): Promise<SetupStepResult & { registry: Registry }> {
  const o = resolveOptions(options);
  if (o.mode === "unconfigured") throw new NotConfiguredError();
  try {
    const reg = await setupRegistry(notion, o);
    const step = nextPendingStep(reg);
    const finish = (message: string, done = false) => {
      setupMemo.set(notion, { reg, at: Date.now() });
      return { done, message, registry: reg };
    };
    if (!step) return finish("Notion is set up.", true);
    switch (step.kind) {
      case "parent":
        throw new NotSharedError(reg.problems[0] ?? `No Notion page called "${o.parentTitle}" was found.`);
      case "create": {
        const def = SCHEMA[step.key];
        const properties: Record<string, PropertyConfig> = {};
        for (const [pk, pd] of Object.entries(def.props)) {
          if (!pd.backOf) properties[pd.name] = propertyConfig(pk, pd, dsIdResolver(reg));
        }
        const db = await notion.databases.create({
          parent: { type: "page_id", page_id: reg.parent!.id },
          title: textToRichText(def.title),
          description: textToRichText(dbDescription(step.key)),
          is_inline: false,
          initial_data_source: { properties },
        });
        if (!isFullDatabase(db)) throw new NotionError("Notion returned an incomplete database after creating it.");
        reg.dbs[step.key] = {
          key: step.key,
          title: def.title,
          databaseId: db.id,
          dataSourceId: db.data_sources[0].id,
          locked: false,
          matchedBy: "marker",
          props: {},
          propNames: {},
          missing: [],
          options: {},
        };
        await refreshEntry(notion, reg, step.key);
        const n = DB_ORDER.indexOf(step.key) + 1;
        return finish(`Created database ${def.title} (${n} of ${DB_ORDER.length})`);
      }
      case "props": {
        const e = reg.dbs[step.key]!;
        const def = SCHEMA[step.key];
        const ds = await notion.dataSources.retrieve({ data_source_id: e.dataSourceId });
        const taken = new Set(isFullDataSource(ds) ? Object.keys(ds.properties).map((n) => n.toLowerCase()) : []);
        const properties: NonNullable<DataSourceUpdateArgs["properties"]> = {};
        for (const pk of e.missing) {
          const pd = def.props[pk];
          let name = pd.name;
          for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${pd.name} (${i})`;
          taken.add(name.toLowerCase());
          properties[name] = propertyConfig(pk, pd, dsIdResolver(reg)) as NonNullable<DataSourceUpdateArgs["properties"]>[string];
        }
        await notion.dataSources.update({ data_source_id: e.dataSourceId, properties });
        await refreshEntry(notion, reg, step.key);
        return finish(`Added ${e.missing.length} missing ${e.missing.length === 1 ? "property" : "properties"} to ${def.title}`);
      }
      case "options": {
        const e = reg.dbs[step.key]!;
        const properties: NonNullable<DataSourceUpdateArgs["properties"]> = {};
        for (const pk of step.props) {
          const have = e.options[pk] ?? {};
          const wanted = SCHEMA[step.key].props[pk].options ?? [];
          const keep = Object.entries(have).map(([name, id]) => ({ id, name }));
          const add = wanted.filter((w) => !(w.name in have)).map((w) => ({ name: w.name, color: w.color }));
          properties[e.props[pk]] = { select: { options: [...keep, ...add] } };
        }
        await notion.dataSources.update({ data_source_id: e.dataSourceId, properties });
        await refreshEntry(notion, reg, step.key);
        return finish(`Added missing choices to ${SCHEMA[step.key].title}`);
      }
      case "backRelation": {
        const e = reg.dbs[step.key]!;
        const clash = Object.entries(e.propNames).some(([pk, n]) => pk !== step.prop && n.toLowerCase() === step.name.toLowerCase());
        if (clash) {
          reg.warnings.push(`Projects already has a property called "${step.name}"; the link back to Steps keeps its name.`);
          e.propNames[step.prop] = step.name; // do not try again in this session
          return finish(`Kept the name of the Steps link on ${e.title}`);
        }
        await notion.dataSources.update({ data_source_id: e.dataSourceId, properties: { [step.id]: { name: step.name } } });
        await refreshEntry(notion, reg, step.key);
        return finish(`Named the Steps link on ${e.title} "${step.name}"`);
      }
      case "saveMap": {
        const settings = reg.dbs.settings!;
        const map = savedMapOf(reg);
        const id = await upsertSettingRow(notion, settings, SETTINGS_REGISTRY_KEY, map, settings.mapPageId);
        await upsertSettingRow(notion, settings, SETTINGS_SCHEMA_VERSION_KEY, SCHEMA_VERSION);
        if (!settings.mapPageId || normPageId(settings.mapPageId) !== normPageId(id)) {
          await notion.databases.update({ database_id: settings.databaseId, description: textToRichText(dbDescription("settings", id)) });
          settings.mapPageId = id;
        }
        reg.saved = map;
        return finish("Saved the property map in Settings");
      }
      case "lock": {
        await Promise.all(
          step.keys.map(async (k) => {
            await notion.databases.update({ database_id: reg.dbs[k]!.databaseId, is_locked: true });
            reg.dbs[k]!.locked = true;
          }),
        );
        return finish(`Locked the layout of ${step.keys.length} ${step.keys.length === 1 ? "database" : "databases"} in Notion`);
      }
    }
  } catch (e) {
    setupMemo.delete(notion);
    throw mapNotionError(e);
  }
}

// ---------------------------------------------------------------------------
// Handle (memo + optional external loader) used by the repository
// ---------------------------------------------------------------------------

export interface RegistryHandle {
  /** The registry (memoised; may be incomplete). */
  load(): Promise<Registry>;
  /** The registry, or SetupIncompleteError / NotSharedError when the app databases are not ready. */
  require(): Promise<Registry>;
  /** Forget the memo; the next load does a fresh discovery (bypassing the external loader once). */
  reset(): void;
}

export interface RegistryHandleOptions extends RegistryOptions {
  /** e.g. `unstable_cache(() => discoverRegistry(getNotion()), ['schema', String(SCHEMA_VERSION)], { tags: ['schema'], revalidate: 3600 })`. */
  loader?: () => Promise<Registry>;
  /** Called after reset() (e.g. to revalidateTag('schema') where allowed). */
  onReset?: () => void;
}

const COMPLETE_TTL_MS = 3_600_000;
const INCOMPLETE_TTL_MS = 10_000;
const handles = new Set<RegistryHandle>();

export function createRegistryHandle(notion: NotionLike, opts: RegistryHandleOptions = {}): RegistryHandle {
  let memo: { reg: Registry; at: number } | null = null;
  let inflight: Promise<Registry> | null = null;
  let bypassLoader = false;

  const fresh = () => {
    const viaLoader = opts.loader && !bypassLoader;
    bypassLoader = false;
    return viaLoader ? opts.loader!() : discoverRegistry(notion, opts);
  };

  const handle: RegistryHandle = {
    async load() {
      if (memo) {
        const ttl = isComplete(memo.reg) ? COMPLETE_TTL_MS : INCOMPLETE_TTL_MS;
        if (Date.now() - memo.at < ttl) return memo.reg;
      }
      if (!inflight) {
        inflight = fresh()
          .then((reg) => {
            memo = { reg, at: Date.now() };
            return reg;
          })
          .finally(() => {
            inflight = null;
          });
      }
      return inflight;
    },
    async require() {
      const reg = await handle.load();
      if (isComplete(reg)) return reg;
      if (reg.mode === "unconfigured") throw new NotConfiguredError();
      if (!reg.parent) throw new NotSharedError(reg.problems[0]);
      const missingDb = DB_ORDER.find((k) => !reg.dbs[k]);
      if (missingDb) throw new SetupIncompleteError();
      const k = DB_ORDER.find((x) => reg.dbs[x]!.missing.length)!;
      throw new SetupIncompleteError(
        `The ${SCHEMA[k].title} database in Notion is missing ${reg.dbs[k]!.missing.map((p) => `"${SCHEMA[k].props[p].name}"`).join(", ")}. Open Setup to repair it.`,
      );
    },
    reset() {
      memo = null;
      bypassLoader = true;
      try {
        opts.onReset?.();
      } catch {
        // A cache hook must never turn a recoverable reset into a failure.
      }
    },
  };
  handles.add(handle);
  return handle;
}

/** Drops every registry memo in this instance (setup memo included). */
export function resetRegistryCaches(): void {
  for (const h of handles) h.reset();
}

// ---------------------------------------------------------------------------
// Storage admin (Setup screen, reset, backup)
// ---------------------------------------------------------------------------

interface ExportCursor {
  /** Notion cursor within the current window. */
  c: string | null;
  /** created_time lower bound of the current window (after the 10,000-row cap). */
  t: string | null;
  /** Ids already exported at exactly `t`. */
  s: string[];
  /** Latest created_time seen so far in the current window. */
  lt: string | null;
  /** Ids seen at exactly `lt` in the current window (on any of its pages). */
  ls: string[];
}

function encodeCursor(c: ExportCursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

function strings(x: unknown): string[] {
  return Array.isArray(x) ? x.filter((v): v is string => typeof v === "string") : [];
}

function decodeCursor(s: string | null): ExportCursor {
  if (!s) return { c: null, t: null, s: [], lt: null, ls: [] };
  try {
    const c = JSON.parse(Buffer.from(s, "base64url").toString("utf8")) as Partial<ExportCursor>;
    return { c: c.c ?? null, t: c.t ?? null, s: strings(c.s), lt: c.lt ?? null, ls: strings(c.ls) };
  } catch {
    throw new NotionError("The backup cursor is not valid; start the backup again.", { code: "bad_cursor" });
  }
}

/** A JSON-friendly copy of one property value (signed file URLs are left out: they expire). */
export function simplifyValue(v: PropValue): unknown {
  switch (v.type) {
    case "title":
      return richTextToText(v.title);
    case "rich_text":
      return richTextToText(v.rich_text);
    case "number":
      return v.number;
    case "checkbox":
      return v.checkbox;
    case "select":
      return v.select?.name ?? null;
    case "date":
      return v.date ? { start: v.date.start, end: v.date.end } : null;
    case "url":
      return v.url;
    case "relation": {
      const ids = v.relation.map((r) => r.id);
      return (v as { has_more?: boolean }).has_more ? { ids, truncated: true } : ids;
    }
    case "files":
      return v.files.map((f) => ({ name: f.name, type: f.type }));
    case "created_time":
      return v.created_time;
    case "last_edited_time":
      return v.last_edited_time;
    default:
      return null;
  }
}

export function createStorageAdmin(notion: NotionLike | (() => NotionLike), handle: RegistryHandle | (() => RegistryHandle), options?: RegistryOptions): StorageAdmin {
  const n = () => (typeof notion === "function" ? notion() : notion);
  const h = () => (typeof handle === "function" ? handle() : handle);
  // 'seed.appliedAt' never goes away except through trashAll / resetCaches: once seen, status() stops querying it.
  let seededSeen = false;

  return {
    async status(): Promise<SetupStatus> {
      const mode = options?.mode ?? storageMode();
      const empty = DB_ORDER.map((k) => ({ name: SCHEMA[k].title, ok: false }));
      if (mode === "unconfigured") {
        return { mode, problems: [new NotConfiguredError().message], databases: empty, schemaReady: false, seeded: false };
      }
      try {
        const reg = await h().load();
        let seeded = seededSeen;
        if (!seeded && reg.dbs.settings && reg.dbs.settings.missing.length === 0) {
          seeded = (await findSettingRow(n(), reg.dbs.settings, SETTINGS_SEED_KEY)) !== null;
          seededSeen = seeded;
        }
        const warnings = [...reg.warnings];
        const tidy = cosmeticWork(reg);
        if (tidy.length) warnings.push(`Setup has small fixes for the Notion databases (${tidy.join("; ")}). Open Setup to apply them.`);
        return {
          mode,
          problems: [...reg.problems],
          warnings,
          parentPage: reg.parent ?? undefined,
          databases: DB_ORDER.map((k) => ({ name: SCHEMA[k].title, ok: !!reg.dbs[k] && reg.dbs[k]!.missing.length === 0 })),
          schemaReady: isSchemaReady(reg),
          seeded,
        };
      } catch (e) {
        const mapped = mapNotionError(e);
        if (!(mapped instanceof NotionError)) throw mapped;
        return { mode, problems: [mapped.message], databases: empty, schemaReady: false, seeded: false };
      }
    },

    async runSchemaStep(): Promise<SetupStepResult> {
      const res = await runSchemaStep(n(), options);
      h().reset();
      return { done: res.done, message: res.message };
    },

    async resetCaches() {
      seededSeen = false;
      resetRegistryCaches();
      setupMemo.delete(n());
    },

    async trashAll() {
      try {
        const reg = await discoverRegistry(n(), options);
        await Promise.all(
          DB_ORDER.map(async (k) => {
            const e = reg.dbs[k];
            if (e) await n().databases.update({ database_id: e.databaseId, in_trash: true });
          }),
        );
      } catch (e) {
        throw mapNotionError(e);
      } finally {
        seededSeen = false;
        resetRegistryCaches();
        setupMemo.delete(n());
      }
    },

    async exportPage(database, cursor) {
      const key = dbKeyFrom(database);
      if (!key) throw new NotionError(`Unknown database "${database}".`, { code: "unknown_database" });
      const reg = await h().require();
      const e = reg.dbs[key]!;
      const cur = decodeCursor(cursor);
      const keyById = new Map(Object.entries(e.props).map(([pk, id]) => [id, pk]));
      const skipBack = Object.entries(SCHEMA[key].props)
        .filter(([, pd]) => pd.backOf)
        .map(([pk]) => e.props[pk])
        .filter(Boolean);
      const filterProps = Object.values(e.props).filter((id) => !skipBack.includes(id));
      const filter: QueryFilter | undefined = cur.t ? { timestamp: "created_time", created_time: { on_or_after: cur.t } } : undefined;
      try {
        const res = await n().dataSources.query({
          data_source_id: e.dataSourceId,
          filter,
          sorts: [{ timestamp: "created_time", direction: "ascending" }],
          page_size: 100,
          start_cursor: cur.c ?? undefined,
          filter_properties: filterProps,
        });
        const pages = res.results.filter(isFullPage);
        const rows = pages
          .filter((p) => !cur.s.includes(p.id))
          .map((p) => {
            const values: Record<string, unknown> = {};
            const other: Record<string, unknown> = {};
            for (const [name, v] of Object.entries(p.properties)) {
              const pk = [...keyById.entries()].find(([id]) => sameId(id, v.id))?.[1];
              if (pk) values[pk] = simplifyValue(v);
              else other[name] = simplifyValue(v);
            }
            return { id: p.id, createdTime: p.created_time, lastEditedTime: p.last_edited_time, url: p.url, values, other };
          });
        // Track the latest minute of this window across ALL its pages: when the window is cut by the result cap,
        // the next window starts at that minute and must skip every row of it already exported, including rows
        // that came on an earlier page of this window.
        let lt = cur.lt;
        let ls = cur.ls;
        for (const p of pages) {
          if (lt === null || p.created_time > lt) {
            lt = p.created_time;
            ls = [p.id];
          } else if (p.created_time === lt && !ls.includes(p.id)) {
            ls = [...ls, p.id];
          }
        }
        let next: ExportCursor | null = null;
        if (res.has_more && res.next_cursor) {
          next = { c: res.next_cursor, t: cur.t, s: cur.s, lt, ls };
        } else if (res.request_status?.type === "incomplete" && lt !== null) {
          const s = lt === cur.t ? [...new Set([...cur.s, ...ls])] : ls;
          // A window that brings nothing new (over 10,000 rows created in one minute) cannot advance: stop.
          const stuck = lt === cur.t && s.length === cur.s.length;
          if (!stuck) next = { c: null, t: lt, s, lt: null, ls: [] };
        }
        return { rows, nextCursor: next ? encodeCursor(next) : null };
      } catch (err) {
        throw mapNotionError(err);
      }
    },

    databaseNames() {
      return [...DB_ORDER];
    },
  };
}
