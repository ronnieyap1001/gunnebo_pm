/**
 * Regression tests for defects found in the storage-layer review (each failed before its fix).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { APIErrorCode, APIResponseError, isFullPage } from "@notionhq/client";
import type { Value } from "@/domain/types";
import { createGate, createRealNotion, setNotionForTesting, withConcurrencyGate } from "@/server/notion/client";
import { NotSharedError, NotionError, SetupIncompleteError, mapNotionError } from "@/server/notion/errors";
import { createFakeNotion } from "@/server/notion/fake";
import { createRegistryHandle, createStorageAdmin, discoverRegistry } from "@/server/notion/registry";
import { truncateText } from "@/server/notion/richtext";
import { KNOWN_EVENT_TYPES } from "@/server/notion/schema";
import { createNotionRepo } from "@/server/repo/notionRepo";
import type { ProjectInput, StepInput } from "@/server/repo/types";
import { EV } from "@/server/services/context";
import { FAKE_OPTS, runSetup, setupFake, text } from "./helpers";

function projectInput(over: Partial<ProjectInput> = {}): ProjectInput {
  return {
    code: "C0822",
    name: "Heathrow T5",
    status: "ACTIVE",
    details: {},
    flow: { nodes: {}, edges: [] },
    cells: {},
    progress: 0,
    templateRevision: 1,
    syncDismissed: {},
    setup: "READY",
    archived: false,
    ...over,
  };
}

function stepInput(projectId: string, over: Partial<StepInput> = {}): StepInput {
  return {
    projectId,
    name: "FAT",
    description: "",
    fieldType: "TEXT",
    choices: [],
    config: {},
    value: null,
    notApplicable: false,
    flag: null,
    order: 1,
    rev: 0,
    archived: false,
    stepKey: `${projectId}:fat`,
    ...over,
  };
}

describe("writes never cross into another database", () => {
  it("an update with an id from another database is refused before anything is written", async () => {
    const { repo } = await setupFake();
    const p = await repo.projects.create(projectInput());
    // Every database's title property has the id "title": without a check these would overwrite the project's Code.
    await expect(repo.attachments.update(p.id, { name: "HACKED" })).rejects.toThrow(NotSharedError);
    await expect(repo.milestones.update(p.id, { name: "HACKED" })).rejects.toThrow(NotSharedError);
    await expect(repo.steps.update(p.id, { name: "HACKED" })).rejects.toThrow(NotSharedError);
    expect((await repo.projects.get(p.id))?.code).toBe("C0822");
  });

  it("also from a cold instance (one extra light read), and costs nothing extra for pages it has already seen", async () => {
    const { repo, notion } = await setupFake();
    const p = await repo.projects.create(projectInput());
    const s = await repo.steps.create(stepInput(p.id));
    notion.fake.resetCalls();
    await repo.steps.update(s.id, { rev: 1 });
    expect(notion.fake.callCount("pages.retrieve")).toBe(0);

    const cold = createNotionRepo(notion, createRegistryHandle(notion, FAKE_OPTS));
    await cold.settings.get("warm-up");
    await expect(cold.attachments.update(p.id, { name: "HACKED" })).rejects.toThrow(NotSharedError);
    notion.fake.resetCalls();
    expect((await cold.steps.update(s.id, { rev: 2 })).rev).toBe(2);
    expect(notion.fake.callCount("pages.retrieve")).toBe(1);
    expect(notion.fake.callCount("pages.update")).toBe(1);
    expect((await repo.projects.get(p.id))?.code).toBe("C0822");
  });
});

describe("settings stay one row per key", () => {
  it("concurrent sets of one key create one row", async () => {
    const { repo, notion, handle } = await setupFake();
    await Promise.all([repo.settings.set("job:1", { done: 1 }), repo.settings.set("job:1", { done: 2 })]);
    expect(await repo.settings.get("job:1")).toEqual({ done: 2 });
    const reg = await handle.load();
    const e = reg.dbs.settings!;
    const rows = await notion.dataSources.query({ data_source_id: e.dataSourceId, filter: { property: e.props.key, title: { equals: "job:1" } } });
    expect(rows.results).toHaveLength(1);
  });

  it("rapid sets and reads work even while new rows are not yet visible to queries", async () => {
    let now = Date.UTC(2026, 9, 25, 6, 0, 0);
    const { repo, notion, handle } = await setupFake({ now: () => now, queryLagMs: 5_000 });
    now += 10_000;
    await repo.settings.get("warm-up");
    await repo.settings.set("job:abc", { done: ["a"] });
    await repo.settings.set("job:abc", { done: ["a", "b"] });
    expect(await repo.settings.get("job:abc")).toEqual({ done: ["a", "b"] });
    expect(await repo.settings.list("job:")).toEqual({ "job:abc": { done: ["a", "b"] } });
    now += 10_000;
    const reg = await handle.load();
    const e = reg.dbs.settings!;
    const rows = await notion.dataSources.query({ data_source_id: e.dataSourceId, filter: { property: e.props.key, title: { equals: "job:abc" } } });
    expect(rows.results).toHaveLength(1);
  });
});

describe("findByCode", () => {
  it("finds a code someone retyped in lower case in Notion (does not rely on how Notion compares case)", async () => {
    const { repo, notion } = await setupFake();
    const p = await repo.projects.create(projectInput({ code: "C0822" }));
    await repo.projects.create(projectInput({ code: "C08220" }));
    await notion.pages.update({ page_id: p.id, properties: { title: { title: text("c0822") } } });
    expect((await repo.projects.findByCode("C0822"))?.id).toBe(p.id);
    expect(await repo.projects.findByCode("C08")).toBeNull();
  });
});

describe("backup export", () => {
  it("exports each row once when the last minute of a capped window spans two pages", async () => {
    let now = Date.UTC(2026, 9, 25, 0, 0, 0);
    const { notion, handle, repo } = await setupFake({ now: () => now, queryResultCap: 150 });
    for (let i = 0; i < 200; i++) {
      if (i % 80 === 0) now += 60_000; // 80 rows per minute
      await repo.settings.set(`k.${String(i).padStart(3, "0")}`, i);
    }
    const admin = createStorageAdmin(notion, handle, FAKE_OPTS);
    const ids: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res: { rows: unknown[]; nextCursor: string | null } = await admin.exportPage("Settings", cursor);
      ids.push(...(res.rows as { id: string }[]).map((r) => r.id));
      cursor = res.nextCursor;
      pages++;
    } while (cursor && pages < 50);
    expect(ids.length).toBe(new Set(ids).size);
    expect(ids.length).toBe(202); // + schema.registry and schema.version
  });
});

describe("a property deleted in Notion while the registry is cached", () => {
  it("rediscovers and reports the missing property in plain English (writes and filters)", async () => {
    const { repo, notion } = await setupFake();
    const p = await repo.projects.create(projectInput());
    const reg = await discoverRegistry(notion, FAKE_OPTS);
    const notes = reg.dbs.notes!;
    await notion.dataSources.update({ data_source_id: notes.dataSourceId, properties: { [notes.props.author]: null } });
    const err = await repo.notes.create({ projectId: p.id, body: "x", author: "me", archived: false }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SetupIncompleteError);
    expect((err as Error).message).toMatch(/Notes database in Notion is missing "Author"/);

    const steps = reg.dbs.steps!;
    await notion.dataSources.update({ data_source_id: steps.dataSourceId, properties: { [steps.props.archived]: null } });
    await expect(repo.steps.listByProject(p.id)).rejects.toThrow(SetupIncompleteError);
  });
});

describe("hand-edited JSON of the wrong shape never reaches the app", () => {
  it("falls back for Flow, Cells, Details, Choices, Config, Value data and History data", async () => {
    const { repo, notion } = await setupFake();
    const reg = await discoverRegistry(notion, FAKE_OPTS);
    const P = reg.dbs.projects!.props;
    const S = reg.dbs.steps!.props;
    const H = reg.dbs.history!.props;
    const p = await repo.projects.create(projectInput());
    const s = await repo.steps.create(stepInput(p.id, { choices: [{ id: "a", label: "A", state: "DONE" }], value: { text: "v" } }));
    const h = await repo.history.append({
      opId: "op-1",
      projectId: p.id,
      stepId: s.id,
      type: "step.value_changed",
      source: "MANUAL",
      actor: "me",
      summary: "x",
      data: { n: 1 },
      occurredAt: "2026-10-25T00:00:00.000Z",
    });

    await notion.pages.update({
      page_id: p.id,
      properties: {
        [P.flow]: { rich_text: text("null") },
        [P.cells]: { rich_text: text("[1,2]") },
        [P.details]: { rich_text: text('"x"') },
        [P.syncDismissed]: { rich_text: text("{not json") },
      },
    });
    const got = await repo.projects.get(p.id);
    expect(got).toMatchObject({ flow: { nodes: {}, edges: [] }, cells: {}, details: {}, syncDismissed: {} });
    expect((await repo.projects.list())[0].flow).toEqual({ nodes: {}, edges: [] });

    await notion.pages.update({ page_id: p.id, properties: { [P.flow]: { rich_text: text('{"nodes":[],"edges":{"a":1}}') } } });
    expect((await repo.projects.get(p.id))?.flow).toEqual({ nodes: {}, edges: [] });

    await notion.pages.update({
      page_id: s.id,
      properties: {
        [S.choices]: { rich_text: text('[{"id":"a","label":"A"},7,{"label":"no id"}]') },
        [S.config]: { rich_text: text("[1]") },
        [S.valueData]: { rich_text: text('"text"') },
      },
    });
    const step = await repo.steps.get(s.id);
    expect(step).toMatchObject({ choices: [{ id: "a", label: "A" }], config: {}, value: null });

    await notion.pages.update({ page_id: h.id, properties: { [H.data]: { rich_text: text("[1]") } } });
    const [row] = (await repo.history.listByStep(s.id)).items;
    expect(row.data).toBeUndefined();
  });
});

describe("mirrors never make the real write fail", () => {
  it("a value that is not a calendar date leaves the Date mirror empty instead of failing", async () => {
    const { repo } = await setupFake();
    const p = await repo.projects.create(projectInput());
    const s = await repo.steps.create(stepInput(p.id, { fieldType: "DATE" }));
    const odd = { date: "soon" } as Value;
    expect((await repo.steps.update(s.id, { value: odd })).value).toEqual(odd);
    const range = { start: "2026-11-12", end: "12/01/2026" } as Value;
    expect((await repo.steps.update(s.id, { fieldType: "DATE_RANGE", value: range })).value).toEqual(range);
  });
});

describe("malformed ids", () => {
  it("lists by a malformed project or step id return nothing instead of a Notion validation error", async () => {
    const { repo } = await setupFake();
    expect(await repo.steps.listByProject("not-an-id")).toEqual([]);
    expect(await repo.notes.listByProject("not-an-id")).toEqual([]);
    expect(await repo.attachments.listByProject("")).toEqual([]);
    expect(await repo.history.listByStep("../x")).toEqual({ items: [], nextCursor: null });
    expect(await repo.history.listByProject("x")).toEqual({ items: [], nextCursor: null });
  });
});

describe("status", () => {
  it("cosmetic drift in Notion (unlocked database, renamed Steps link) does not block the app; Setup tidies it up", async () => {
    const notion = createFakeNotion();
    await runSetup(notion);
    const reg = await discoverRegistry(notion, FAKE_OPTS);
    await notion.databases.update({ database_id: reg.dbs.notes!.databaseId, is_locked: false });
    await notion.dataSources.update({
      data_source_id: reg.dbs.projects!.dataSourceId,
      properties: { [reg.dbs.projects!.props.steps]: { name: "Project steps" } },
    });
    const admin = createStorageAdmin(notion, createRegistryHandle(notion, FAKE_OPTS), FAKE_OPTS);
    const s = await admin.status();
    expect(s.schemaReady).toBe(true);
    expect(s.problems).toEqual([]);
    expect(s.warnings?.join(" ")).toMatch(/Open Setup/);
    const messages: string[] = [];
    for (let i = 0; i < 10; i++) {
      const r = await admin.runSchemaStep();
      messages.push(r.message);
      if (r.done) break;
    }
    expect(messages).toContain('Named the Steps link on Projects "Steps"');
    expect(messages.some((m) => m.startsWith("Locked the layout of 1 database"))).toBe(true);
    expect((await admin.status()).warnings).toEqual([]);
  });

  it("is not ready while the saved property map is missing", async () => {
    const notion = createFakeNotion();
    const handle = createRegistryHandle(notion, FAKE_OPTS);
    const admin = createStorageAdmin(notion, handle, FAKE_OPTS);
    for (let i = 0; i < 30; i++) {
      const r = await admin.runSchemaStep();
      if (r.message.startsWith("Saved the property map")) break;
      if (i > 0 && r.message.startsWith("Named")) expect((await admin.status()).schemaReady).toBe(false);
    }
    expect((await admin.status()).schemaReady).toBe(true);
  });
});

describe("files", () => {
  it("explains a file type Notion does not accept", async () => {
    const { repo } = await setupFake();
    const p = await repo.projects.create(projectInput());
    const err = await repo.attachments
      .createFile({ projectId: p.id, name: "Re: PO.msg", contentType: "application/vnd.ms-outlook", size: 3, data: new Blob(["abc"]) })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotionError);
    expect((err as NotionError).code).toBe("unsupported_file_type");
    expect((err as Error).message).toMatch(/zip/i);
    expect((err as Error).message).toMatch(/SharePoint/);
  });
});

describe("secrets and request contents stay out of errors and logs", () => {
  const echo = 'body.properties.Customer.select.name should be valid, instead was `"Acme, Inc. confidential"`.';

  it("mapped errors keep no echo of submitted values, not even in `detail`", () => {
    const raw = new APIResponseError({
      code: APIErrorCode.ValidationError,
      status: 400,
      message: echo,
      headers: {},
      rawBodyText: JSON.stringify({ object: "error", status: 400, code: "validation_error", message: echo }),
      additional_data: undefined,
      request_id: undefined,
    });
    const m = mapNotionError(raw) as NotionError;
    expect(m).toBeInstanceOf(NotionError);
    expect(`${m.message} ${m.detail}`).not.toMatch(/confidential/);
  });

  it("the real client's log lines carry neither the token nor echoed values", async () => {
    const lines: string[] = [];
    const spies = (["warn", "info", "debug", "error", "log"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
      }),
    );
    try {
      const fetch = async () => ({
        ok: false,
        status: 400,
        headers: new Headers({ "content-type": "application/json" }),
        text: async () => JSON.stringify({ object: "error", status: 400, code: "validation_error", message: echo }),
      });
      const notion = createRealNotion({ auth: "secret_TOKEN_VALUE_123", fetch });
      await notion.pages.retrieve({ page_id: "11111111-1111-4111-8111-111111111111" }).catch(() => undefined);
      expect(lines.length).toBeGreaterThan(0);
      expect(lines.join("\n")).not.toMatch(/confidential|secret_TOKEN_VALUE_123/);
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });
});

describe("concurrency gate", () => {
  it("never lets a newcomer take a freed slot before the woken waiter runs", async () => {
    const gate = createGate(1);
    let inFlight = 0;
    let max = 0;
    const task = async () => {
      inFlight++;
      max = Math.max(max, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
    };
    let releaseFirst!: () => void;
    const first = gate(() => new Promise<void>((r) => (releaseFirst = r)));
    const waiter = gate(task);
    releaseFirst();
    // Queued right after the release: runs between the slot being freed and the waiter resuming.
    const newcomer = Promise.resolve().then(() => gate(task));
    await Promise.all([first, waiter, newcomer]);
    expect(max).toBe(1);
  });
});

describe("schema", () => {
  it("pre-creates a History Type option for every event type the services log", () => {
    for (const t of Object.values(EV)) expect(KNOWN_EVENT_TYPES, t).toContain(t);
  });
});

describe("fake fidelity: Notion may merge text items on read", () => {
  it("big JSON and long text still round-trip when Notion returns one merged item", async () => {
    const { repo } = await setupFake({ mergeRichTextOnRead: true });
    const cells: Record<string, { n: string; t: "TEXT"; v: null }> = {};
    for (let i = 0; i < 400; i++) cells[`step-${i}`] = { n: `Milestone ${i} 😀`, t: "TEXT", v: null };
    const p = await repo.projects.create(projectInput({ cells }));
    expect((await repo.projects.get(p.id))?.cells).toEqual(cells);
    const body = "line\n".repeat(1000);
    const n = await repo.notes.create({ projectId: p.id, body, author: "me", archived: false });
    expect(n.body).toBe(body);
    expect((await repo.notes.update(n.id, { archived: true })).body).toBe(body);
  });
});

describe("process-wide registry loader", () => {
  afterEach(() => setNotionForTesting(null));

  it("setRegistryLoader takes an onReset hook (e.g. revalidateTag('schema')) that runs when caches are cleared", async () => {
    if (process.env.NOTION_TOKEN || process.env.VERCEL) return;
    const { getRepo, getStorageAdmin, resetRepoForTesting, setRegistryLoader } = await import("@/server/repo");
    const fake = createFakeNotion();
    await runSetup(fake);
    setNotionForTesting(withConcurrencyGate(fake));
    resetRepoForTesting();
    const onReset = vi.fn();
    let loads = 0;
    setRegistryLoader(async () => {
      loads++;
      return discoverRegistry(fake, FAKE_OPTS);
    }, onReset);
    expect(await getRepo().settings.get("nothing")).toBeUndefined();
    expect(loads).toBe(1);
    await getStorageAdmin().resetCaches();
    expect(onReset).toHaveBeenCalled();
    setRegistryLoader(undefined);
    resetRepoForTesting();
  });
});

describe("fake page responses", () => {
  it("a page whose parent is the workspace has the real parent shape", async () => {
    const notion = createFakeNotion();
    const p = await notion.pages.create({ parent: { type: "workspace", workspace: true }, properties: { title: { title: text("R") } } });
    expect(isFullPage(p) && p.parent).toEqual({ type: "workspace", workspace: true });
  });
});

describe("setup while queries lag behind writes", () => {
  it("finishes, stays finished and writes one schema.registry row (the map is found through the Settings pointer)", async () => {
    let now = Date.UTC(2026, 9, 25, 6, 0, 0);
    const notion = createFakeNotion({ now: () => now, queryLagMs: 5_000 });
    const messages = await runSetup(notion);
    expect(messages.at(-1)).toBe("Notion is set up.");
    const admin = createStorageAdmin(notion, createRegistryHandle(notion, FAKE_OPTS), FAKE_OPTS);
    expect((await admin.status()).schemaReady).toBe(true); // a cold instance, still inside the lag window
    now += 10_000;
    const reg = await discoverRegistry(notion, FAKE_OPTS);
    const e = reg.dbs.settings!;
    const rows = await notion.dataSources.query({
      data_source_id: e.dataSourceId,
      filter: { property: e.props.key, title: { equals: "schema.registry" } },
    });
    expect(rows.results).toHaveLength(1);
    expect(e.mapPageId).toBe(rows.results[0].id);
  });
});

describe("pages changed in Notion", () => {
  it("an update of a row someone moved to Notion's trash says so in plain English", async () => {
    const { repo, notion } = await setupFake();
    const p = await repo.projects.create(projectInput());
    const n = await repo.notes.create({ projectId: p.id, body: "x", author: "me", archived: false });
    await notion.pages.update({ page_id: n.id, in_trash: true });
    const err = await repo.notes.update(n.id, { body: "y" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotSharedError);
    expect((err as Error).message).toMatch(/trash/);
  });

  it("a file added in Notion as an external link is flagged, so the download route redirects instead of fetching it", async () => {
    const { repo, notion } = await setupFake();
    const reg = await discoverRegistry(notion, FAKE_OPTS);
    const F = reg.dbs.files!.props;
    const p = await repo.projects.create(projectInput());
    const a = await repo.attachments.createLink({ projectId: p.id, name: "x", url: "https://example.com/a" });
    await notion.pages.update({
      page_id: a.id,
      properties: { [F.file]: { files: [{ type: "external", name: "meta", external: { url: "http://169.254.169.254/latest" } }] } },
    });
    const dl = await repo.attachments.openFile(a.id);
    expect(dl.external).toBe(true);
  });

  it("a link URL retyped in Notion as javascript: is not handed to the app", async () => {
    const { repo, notion } = await setupFake();
    const reg = await discoverRegistry(notion, FAKE_OPTS);
    const F = reg.dbs.files!.props;
    const p = await repo.projects.create(projectInput());
    const a = await repo.attachments.createLink({ projectId: p.id, name: "x", url: "https://example.com/a" });
    await notion.pages.update({ page_id: a.id, properties: { [F.link]: { url: "javascript:alert(1)" } } });
    expect((await repo.attachments.get(a.id))?.url).toBeUndefined();
    await expect(repo.attachments.createLink({ projectId: p.id, name: "y", url: "javascript:alert(1)" })).rejects.toThrow(NotionError);
  });
});

describe("a property whose type was changed in Notion", () => {
  it("is treated as missing: rediscovery, a plain message, and Setup adds a fresh one", async () => {
    const { repo, notion } = await setupFake();
    const p = await repo.projects.create(projectInput());
    const s = await repo.steps.create(stepInput(p.id));
    const reg = await discoverRegistry(notion, FAKE_OPTS);
    const steps = reg.dbs.steps!;
    // Same id, new type.
    await notion.dataSources.update({ data_source_id: steps.dataSourceId, properties: { [steps.props.rev]: { rich_text: {} } } });
    const err = await repo.steps.update(s.id, { rev: 1 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SetupIncompleteError);
    expect((err as Error).message).toMatch(/Steps database in Notion is missing "Rev"/);
    const done = await runSetup(notion);
    expect(done).toContain("Added 1 missing property to Steps");
    const fixed = await discoverRegistry(notion, FAKE_OPTS);
    expect(fixed.dbs.steps!.props.rev).not.toBe(steps.props.rev);
    const again = createNotionRepo(notion, createRegistryHandle(notion, FAKE_OPTS));
    expect((await again.steps.update(s.id, { rev: 2 })).rev).toBe(2);
  });

  it("a value bug (not a schema change) is reported as Notion's error after one rediscovery, not as missing setup", async () => {
    const { repo, notion } = await setupFake();
    const p = await repo.projects.create(projectInput());
    notion.fake.resetCalls();
    notion.fake.injectFault({ status: 400, message: "Template revision is expected to be number.", method: "pages.update", count: 2 });
    const err = await repo.projects.update(p.id, { templateRevision: 3 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotionError);
    expect(err).not.toBeInstanceOf(SetupIncompleteError);
    expect((err as NotionError).notionCode).toBe("validation_error");
    expect(notion.fake.callCount("blocks.children.list")).toBe(1); // exactly one rediscovery
    expect(notion.fake.callCount("pages.update")).toBe(2);
  });

  it("numbers that are not finite are written as empty, never sent as invalid values", async () => {
    const { repo } = await setupFake();
    const p = await repo.projects.create(projectInput());
    expect((await repo.steps.create(stepInput(p.id, { order: Number.NaN }))).order).toBe(0);
  });
});

describe("a create that Notion saved but answered with 503", () => {
  it("carries on with the page Notion names in committed_resource_id (no duplicate when the batch is retried)", async () => {
    const { repo, notion, handle } = await setupFake();
    const p = await repo.projects.create(projectInput());
    notion.fake.injectFault({ status: 503, afterCommit: true, method: "pages.create" });
    const s = await repo.steps.create(stepInput(p.id));
    expect(s.stepKey).toBe(`${p.id}:fat`);
    expect(await repo.steps.listByProject(p.id)).toHaveLength(1);

    notion.fake.injectFault({ status: 503, afterCommit: true, method: "pages.create" });
    await repo.settings.set("job:x", { done: [] });
    const reg = await handle.load();
    const e = reg.dbs.settings!;
    const rows = await notion.dataSources.query({ data_source_id: e.dataSourceId, filter: { property: e.props.key, title: { equals: "job:x" } } });
    expect(rows.results).toHaveLength(1);
  });
});

describe("fake page property values have Notion's exact shapes", () => {
  it("title, rich_text, number, select, checkbox, date, url, relation, files, created_time", async () => {
    const { repo, notion } = await setupFake();
    const p = await repo.projects.create(projectInput());
    const a = await repo.attachments.createFile({ projectId: p.id, name: "a.pdf", contentType: "application/pdf", size: 1, data: new Blob(["x"]) });
    const page = await notion.pages.retrieve({ page_id: a.id });
    if (!isFullPage(page)) throw new Error("no page");
    const v = page.properties;
    const item = { type: "text", text: { content: "a.pdf", link: null }, plain_text: "a.pdf", href: null,
      annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" } };
    expect(v.Name).toEqual({ id: "title", type: "title", title: [item] });
    expect(v.Kind).toEqual({ id: expect.any(String), type: "select", select: { id: expect.any(String), name: "File", color: "blue" } });
    expect(v.Size).toEqual({ id: expect.any(String), type: "number", number: 1 });
    expect(v["Archived at"]).toEqual({ id: expect.any(String), type: "date", date: null });
    expect(v["Created at"]).toEqual({ id: expect.any(String), type: "date", date: { start: expect.stringMatching(/\+00:00$/), end: null, time_zone: null } });
    expect(v.Archived).toEqual({ id: expect.any(String), type: "checkbox", checkbox: false });
    expect(v.Link).toEqual({ id: expect.any(String), type: "url", url: null });
    expect(v.Project).toEqual({ id: expect.any(String), type: "relation", relation: [{ id: p.id }], has_more: false });
    expect(v.Step).toEqual({ id: expect.any(String), type: "relation", relation: [], has_more: false });
    expect(v.File).toEqual({
      id: expect.any(String),
      type: "files",
      files: [{ name: "a.pdf", type: "file", file: { url: expect.stringMatching(/^https:\/\//), expiry_time: expect.any(String) } }],
    });
    expect(v["Content type"]).toMatchObject({ type: "rich_text", rich_text: [{ plain_text: "application/pdf" }] });
    expect(Object.keys(v).sort()).toEqual(["Archived", "Archived at", "Content type", "Created at", "File", "Kind", "Link", "Name", "Project", "Size", "Step"]);
    expect(page.created_time).toMatch(/:00\.000Z$/);
  });
});

describe("richtext", () => {
  it("truncateText never returns more than max characters", () => {
    expect(truncateText("abc", 0)).toBe("");
    expect(truncateText("abc", 1)).toBe("…");
  });
});

describe("history rows are never lost to a related step that is gone", () => {
  it("also when Notion answers the missing related page with 404", async () => {
    const { repo, notion } = await setupFake();
    const p = await repo.projects.create(projectInput());
    const s = await repo.steps.create(stepInput(p.id));
    notion.fake.resetCalls();
    notion.fake.injectFault({ status: 404, method: "pages.create" });
    const h = await repo.history.append({
      opId: "op-bulk",
      projectId: p.id,
      type: "step.archived",
      source: "MANUAL",
      actor: "me",
      summary: "archived",
      data: { stepIds: [s.id] },
      occurredAt: "2026-10-25T00:00:00.000Z",
    });
    expect(h.opId).toBe("op-bulk");
    expect(notion.fake.callCount("blocks.children.list")).toBe(0); // no needless rediscovery
    expect(await repo.history.hasOp("op-bulk")).toBe(true);
  });
});
