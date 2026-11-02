import { describe, expect, it } from "vitest";
import { isFullDataSource, isFullPage } from "@notionhq/client";
import type { Cell, Choice, Flow } from "@/domain/types";
import { FileTooLargeError, NotSharedError, ValueTooLargeError } from "@/server/notion/errors";
import { fakeFileBytes } from "@/server/notion/fake";
import { discoverRegistry } from "@/server/notion/registry";
import { jsonToRichText } from "@/server/notion/richtext";
import { MAX_FILE_BYTES, PAYLOAD_SPLIT_BYTES, historyHash } from "@/server/repo/notionRepo";
import type { HistoryAppendInput, ProjectInput, StepInput } from "@/server/repo/types";
import { FAKE_OPTS, setupFake } from "./helpers";

const choices: Choice[] = [
  { id: "awaiting", label: "Awaiting", state: "WAITING" },
  { id: "loi", label: "LOI received", state: "IN_PROGRESS" },
  { id: "po", label: "Full PO", state: "DONE" },
  { id: "old", label: "Old", state: "DONE", archived: true },
];

function projectInput(over: Partial<ProjectInput> = {}): ProjectInput {
  return {
    code: "C0822",
    name: "Heathrow T5",
    status: "ACTIVE",
    details: { customer: { choiceId: "sita" } },
    flow: { nodes: {}, edges: [] },
    cells: {},
    progress: 58,
    templateRevision: 3,
    syncDismissed: {},
    setup: "READY",
    archived: false,
    ...over,
  };
}

function stepInput(projectId: string, over: Partial<StepInput> = {}): StepInput {
  return {
    projectId,
    name: "Customer PO / LOI",
    description: "Order received",
    fieldType: "DROPDOWN",
    choices,
    config: {},
    value: null,
    notApplicable: false,
    flag: null,
    order: 8,
    rev: 0,
    archived: false,
    stepKey: `${projectId}:m8`,
    ...over,
  };
}

function bigFlowAndCells(n: number, valueText = "x".repeat(40)): { flow: Flow; cells: Record<string, Cell> } {
  const flow: Flow = { nodes: {}, edges: [] };
  const cells: Record<string, Cell> = {};
  for (let i = 0; i < n; i++) {
    const id = `step-${i.toString(36)}-0000-4000-8000-${"0".repeat(12)}`;
    flow.nodes[id] = { x: i * 13.5, y: i * 7.25 };
    if (i > 0) flow.edges.push({ id: `edge-${i}`, from: `step-${(i - 1).toString(36)}`, to: id, createdAt: "2026-10-24T06:05:00.000Z" });
    cells[id] = { m: `milestone-${i}`, k: `key-${i}`, n: `Milestone number ${i} with a longer name`, t: "TEXT", v: { text: valueText }, o: i };
  }
  return { flow, cells };
}

/** Bytes the two JSON properties take in a request body (JSON inside JSON: quotes are escaped twice). */
const requestBytes = (...values: unknown[]) =>
  values.reduce<number>((n, v) => n + Buffer.byteLength(JSON.stringify(jsonToRichText(v)), "utf8"), 0);

describe("settings", () => {
  it("gets, sets (overwriting in place) and lists by prefix", async () => {
    const { repo, notion } = await setupFake();
    expect(await repo.settings.get("app.timezone")).toBeUndefined();
    await repo.settings.set("app.timezone", "Asia/Singapore");
    await repo.settings.set("app.timezone", "Europe/London");
    await repo.settings.set("template.flow", { nodes: { a: { x: 1, y: 2 } }, edges: [] });
    await repo.settings.set("template.revision", 4);
    expect(await repo.settings.get("app.timezone")).toBe("Europe/London");
    expect(await repo.settings.get<number>("template.revision")).toBe(4);
    expect(await repo.settings.list("template.")).toEqual({
      "template.flow": { nodes: { a: { x: 1, y: 2 } }, edges: [] },
      "template.revision": 4,
    });
    const allKeys = Object.keys(await repo.settings.list());
    expect(allKeys).toEqual(expect.arrayContaining(["app.timezone", "schema.registry", "schema.version"]));
    // One row per key.
    const reg = await discoverRegistry(notion, FAKE_OPTS);
    const rows = await notion.dataSources.query({ data_source_id: reg.dbs.settings!.dataSourceId });
    expect(rows.results).toHaveLength(5);
  });
});

describe("milestones and project fields", () => {
  it("round-trips milestones, lists by order, hides archived, and writes the readable choices mirror", async () => {
    const { repo, notion } = await setupFake();
    const a = await repo.milestones.create({
      key: "customer-po-loi",
      name: "Customer PO / LOI",
      description: "Purchase order or letter of intent",
      fieldType: "DROPDOWN",
      choices,
      config: {},
      order: 2,
      archived: false,
    });
    const b = await repo.milestones.create({
      key: "fat",
      name: "FAT",
      description: "",
      fieldType: "DATE",
      choices: [],
      config: { unit: "days" },
      order: 1.5,
      archived: false,
    });
    expect(a.id).toBeTruthy();
    expect(await repo.milestones.get(a.id)).toEqual(a);
    expect((await repo.milestones.list()).map((m) => m.key)).toEqual(["fat", "customer-po-loi"]);

    const archived = await repo.milestones.update(b.id, { archived: true, archivedAt: "2026-10-25T01:02:03.456Z", archiveBatch: "batch-1" });
    expect(archived).toMatchObject({ archived: true, archivedAt: "2026-10-25T01:02:03.456Z", archiveBatch: "batch-1", name: "FAT", config: { unit: "days" } });
    expect((await repo.milestones.list()).map((m) => m.key)).toEqual(["customer-po-loi"]);
    expect((await repo.milestones.list({ includeArchived: true })).length).toBe(2);
    const restored = await repo.milestones.update(b.id, { archived: false, archivedAt: undefined, archiveBatch: undefined });
    expect(restored.archivedAt).toBeUndefined();
    expect(restored.archiveBatch).toBeUndefined();

    const page = await notion.pages.retrieve({ page_id: a.id });
    if (!isFullPage(page)) throw new Error("no page");
    const readable = page.properties["Choices (readable)"];
    expect(readable.type === "rich_text" && readable.rich_text.map((t) => t.plain_text).join("")).toBe(
      "Awaiting [W] · LOI received [IP] · Full PO [D]",
    );
    expect(await repo.milestones.get("00000000-0000-4000-8000-000000000000")).toBeNull();
    expect(await repo.milestones.get("not-an-id")).toBeNull();
  });

  it("round-trips project fields", async () => {
    const { repo } = await setupFake();
    const f = await repo.projectFields.create({
      key: "customer",
      label: "Customer",
      fieldType: "DROPDOWN",
      choices: [{ id: "sita", label: "SITA" }],
      config: {},
      order: 1,
      showInSummary: true,
      systemKey: "customer",
      archived: false,
    });
    expect(await repo.projectFields.list()).toEqual([f]);
    const g = await repo.projectFields.update(f.id, { label: "Client", choices: [...f.choices, { id: "nec", label: "NEC" }] });
    expect(g).toMatchObject({ label: "Client", systemKey: "customer", showInSummary: true });
    expect(g.choices).toHaveLength(2);
  });
});

describe("projects", () => {
  it("round-trips a project with big Flow and Cells JSON (split into several requests)", async () => {
    const { repo, notion } = await setupFake();
    const { flow, cells } = bigFlowAndCells(850, '"'.repeat(40));
    expect(JSON.stringify(cells).length).toBeLessThanOrEqual(200_000);
    expect(JSON.stringify(flow).length).toBeLessThanOrEqual(200_000);
    expect(requestBytes(flow, cells)).toBeGreaterThan(PAYLOAD_SPLIT_BYTES); // too big for one request
    const created = await repo.projects.create(projectInput({ flow, cells }));
    expect(notion.fake.callCount("pages.create")).toBe(1);
    expect(notion.fake.callCount("pages.update")).toBeGreaterThanOrEqual(1); // the rest went in a second request
    const got = await repo.projects.get(created.id);
    expect(got).toEqual(created);
    expect(got?.cells).toEqual(cells);
    expect(got?.flow).toEqual(flow);
    expect(got?.progress).toBe(58);
    expect(got?.code).toBe("C0822");
  });

  it("refuses a JSON value over 100 chunks with a clear error", async () => {
    const { repo } = await setupFake();
    const { cells } = bigFlowAndCells(1500);
    await expect(repo.projects.create(projectInput({ cells }))).rejects.toThrow(ValueTooLargeError);
    await expect(repo.projects.create(projectInput({ cells }))).rejects.toThrow(/The project cells is too long/);
  });

  it("writes progress as pct/100, upper-cases codes, finds by code and sanitises select mirrors", async () => {
    const { repo, notion } = await setupFake();
    const p = await repo.projects.create(
      projectInput({ code: " c0900-sp1 ", mirrors: { customer: "Acme, Inc.", projectType: "AFL-Compact", summary: "Acme · AFL", current: "FAT" } }),
    );
    expect(p.code).toBe("C0900-SP1");
    const page = await notion.pages.retrieve({ page_id: p.id });
    if (!isFullPage(page)) throw new Error("no page");
    expect(page.properties.Progress.type === "number" && page.properties.Progress.number).toBe(0.58);
    expect(page.properties.Customer.type === "select" && page.properties.Customer.select?.name).toBe("Acme · Inc.");
    // The new option was added to the schema before the page write.
    const methods = notion.fake.calls.map((c) => c.method);
    expect(methods.indexOf("dataSources.update")).toBeLessThan(methods.indexOf("pages.create"));
    expect(await repo.projects.findByCode("c0900-SP1")).toEqual(p);
    expect(await repo.projects.findByCode("C0901")).toBeNull();

    const archived = await repo.projects.update(p.id, { archived: true, archivedAt: "2026-10-25T08:00:00.000Z", progress: 100, status: "CLOSED" });
    expect(archived).toMatchObject({ archived: true, progress: 100, status: "CLOSED", name: "Heathrow T5" });
    expect(await repo.projects.findByCode("C0900-SP1")).toMatchObject({ archived: true });
  });

  it("lists the Portfolio with ONE paginated query that skips the Steps back-relation and mirrors", async () => {
    const { repo, notion } = await setupFake();
    const { flow, cells } = bigFlowAndCells(20);
    const ids: string[] = [];
    for (let i = 0; i < 105; i++) {
      const p = await repo.projects.create(projectInput({ code: `P${String(i).padStart(3, "0")}`, flow, cells, mirrors: { summary: "s", customer: "SITA" } }));
      ids.push(p.id);
    }
    await repo.projects.update(ids[3], { archived: true });
    // 30 steps on one project: its Steps back-relation would be truncated to 25 (never read).
    for (let i = 0; i < 30; i++) await repo.steps.create(stepInput(ids[0], { stepKey: `${ids[0]}:${i}`, order: i }));

    notion.fake.resetCalls();
    const list = await repo.projects.list();
    expect(notion.fake.callCount()).toBe(2); // one query, two pages of 100
    expect(notion.fake.calls.every((c) => c.method === "dataSources.query")).toBe(true);
    const reg = await discoverRegistry(notion, FAKE_OPTS);
    const props = (notion.fake.calls[0].args as { filter_properties: string[] }).filter_properties;
    const p = reg.dbs.projects!.props;
    expect(props).not.toContain(p.steps);
    expect(props).not.toContain(p.summary);
    expect(props).not.toContain(p.customer);
    for (const k of ["code", "name", "status", "details", "flow", "cells", "progress", "templateRevision", "archived"]) {
      expect(props).toContain(p[k]);
    }
    expect(list).toHaveLength(104);
    expect(list.map((x) => x.code)).toEqual(
      Array.from({ length: 105 }, (_, i) => `P${String(i).padStart(3, "0")}`).filter((c) => c !== "P003"),
    );
    const first = list[0];
    expect(first.cells).toEqual(cells);
    expect(first.flow).toEqual(flow);
    expect(first.details).toEqual({ customer: { choiceId: "sita" } });
    expect(first.progress).toBe(58);
    expect(first.templateRevision).toBe(3);
    expect((await repo.projects.list({ includeArchived: true })).length).toBe(105);
  });
});

describe("steps", () => {
  it("creates with a Step key, round-trips values, mirrors and exact instants", async () => {
    const { repo, notion } = await setupFake();
    const project = await repo.projects.create(projectInput());
    const milestone = await repo.milestones.create({
      key: "customer-po-loi",
      name: "Customer PO / LOI",
      description: "",
      fieldType: "DROPDOWN",
      choices,
      config: {},
      order: 8,
      archived: false,
    });
    const s = await repo.steps.create(
      stepInput(project.id, { milestoneId: milestone.id, milestoneKey: milestone.key, stepKey: "", lastOp: "op-1" }),
    );
    expect(s.stepKey).toBe(`${project.id}:${milestone.id}`);
    expect(s).toMatchObject({ projectId: project.id, milestoneId: milestone.id, milestoneKey: "customer-po-loi", value: null, flag: null, rev: 0, lastOp: "op-1" });
    expect(await repo.steps.get(s.id)).toEqual(s);

    const u = await repo.steps.update(s.id, {
      value: { choiceId: "po" },
      rev: 1,
      valueSetAt: "2026-10-24T06:05:07.123Z",
      stateChangedAt: "2026-10-24T06:05:07.123Z",
      lastChangedAt: "2026-10-24T06:05:07.123Z",
      lastOp: "op-2",
      choices,
      mirrors: { state: "DONE", display: "Full PO" },
    });
    expect(u).toMatchObject({ value: { choiceId: "po" }, rev: 1, valueSetAt: "2026-10-24T06:05:07.123Z", lastOp: "op-2" });
    const page = await notion.pages.retrieve({ page_id: s.id });
    if (!isFullPage(page)) throw new Error("no page");
    const { State: state, Value: shown, "Step key": key } = page.properties;
    expect(state.type === "select" && state.select?.name).toBe("Done");
    expect(shown.type === "rich_text" && shown.rich_text[0]?.plain_text).toBe("Full PO");
    expect(key.type === "rich_text" && key.rich_text[0]?.plain_text).toBe(s.stepKey);

    // Fallback mirrors: date value → Date column + readable value without explicit mirrors.
    const d = await repo.steps.update(s.id, { fieldType: "DATE_RANGE", value: { start: "2026-11-12", end: "2026-12-01" } });
    expect(d.value).toEqual({ start: "2026-11-12", end: "2026-12-01" });
    const page2 = await notion.pages.retrieve({ page_id: s.id });
    if (!isFullPage(page2)) throw new Error("no page");
    const date = page2.properties.Date;
    expect(date.type === "date" && date.date).toMatchObject({ start: "2026-11-12", end: "2026-12-01" });
    const value = page2.properties.Value;
    expect(value.type === "rich_text" && value.rich_text[0]?.plain_text).toBe("2026-11-12 → 2026-12-01");

    const na = await repo.steps.update(s.id, { notApplicable: true, flag: "BLOCKED" });
    expect(na).toMatchObject({ notApplicable: true, flag: "BLOCKED" });
    const cleared = await repo.steps.update(s.id, { value: null, flag: null });
    expect(cleared.value).toBeNull();
    expect(cleared.flag).toBeNull();
  });

  it("lists a project's steps in order, without archived ones unless asked", async () => {
    const { repo } = await setupFake();
    const p1 = await repo.projects.create(projectInput());
    const p2 = await repo.projects.create(projectInput({ code: "C0823" }));
    for (const o of [3, 1, 2]) await repo.steps.create(stepInput(p1.id, { order: o, stepKey: `${p1.id}:${o}`, name: `S${o}` }));
    const archived = await repo.steps.create(stepInput(p1.id, { order: 0, stepKey: `${p1.id}:x`, archived: true, archivedAt: "2026-10-25T00:00:00.000Z" }));
    await repo.steps.create(stepInput(p2.id, { stepKey: `${p2.id}:1` }));
    expect((await repo.steps.listByProject(p1.id)).map((s) => s.name)).toEqual(["S1", "S2", "S3"]);
    const withArchived = await repo.steps.listByProject(p1.id, { includeArchived: true });
    expect(withArchived[0].id).toBe(archived.id);
    expect(withArchived).toHaveLength(4);
    expect(await repo.steps.get(p1.id)).toBeNull(); // a project id is not a step
  });
});

describe("history", () => {
  function event(projectId: string, stepId: string, i: number, over: Partial<HistoryAppendInput> = {}): HistoryAppendInput {
    return {
      opId: `op-${i}`,
      projectId,
      stepId,
      milestoneKey: "customer-po-loi",
      type: "node.value_changed",
      source: "MANUAL",
      actor: "local",
      summary: `C0822 · Customer PO / LOI: change ${i}`,
      oldDisplay: i ? `v${i - 1}` : undefined,
      newDisplay: `v${i}`,
      data: { old: { raw: null, display: "", state: "NOT_STARTED" }, n: i },
      correlationId: "corr-1",
      occurredAt: `2026-10-24T06:05:${String(i % 60).padStart(2, "0")}.123Z`,
      ...over,
    };
  }

  it("appends rows with increasing Seq, a verifiable hash, and lists newest first with pagination", async () => {
    const { repo } = await setupFake();
    const p = await repo.projects.create(projectInput());
    const s = await repo.steps.create(stepInput(p.id));
    const appended = [];
    for (let i = 0; i < 23; i++) appended.push(await repo.history.append(event(p.id, s.id, i)));
    for (let i = 1; i < appended.length; i++) expect(appended[i].seq).toBeGreaterThan(appended[i - 1].seq);
    for (const e of appended) {
      expect(e.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(historyHash(e)).toBe(e.hash);
      expect(Date.parse(e.recordedAt)).toBe(Math.floor(e.seq / 1000));
    }
    expect(appended[5]).toMatchObject({
      opId: "op-5",
      projectId: p.id,
      stepId: s.id,
      type: "node.value_changed",
      source: "MANUAL",
      oldDisplay: "v4",
      newDisplay: "v5",
      data: { n: 5 },
      correlationId: "corr-1",
      occurredAt: "2026-10-24T06:05:05.123Z",
    });

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await repo.history.listByProject(p.id, { limit: 10, cursor });
      seen.push(...page.items.map((x) => x.opId ?? ""));
      cursor = page.nextCursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(3);
    expect(seen).toEqual(appended.map((e) => e.opId).reverse());
    expect((await repo.history.listByStep(s.id, { limit: 5 })).items.map((x) => x.opId)).toEqual(["op-22", "op-21", "op-20", "op-19", "op-18"]);
  });

  it("keeps the exact occurredAt (and a valid hash) even if Notion stores date-times to the minute", async () => {
    const { repo } = await setupFake({ minuteDateTimes: true });
    const p = await repo.projects.create(projectInput());
    const s = await repo.steps.create(stepInput(p.id));
    const e = await repo.history.append(event(p.id, s.id, 7, { occurredAt: "2026-10-24T06:05:07.123Z" }));
    expect(e.occurredAt).toBe("2026-10-24T06:05:07.123Z");
    const [listed] = (await repo.history.listByStep(s.id)).items;
    expect(listed.occurredAt).toBe("2026-10-24T06:05:07.123Z");
    expect(historyHash(listed)).toBe(listed.hash);
  });

  it("lists a bulk event under every step in data.stepIds", async () => {
    const { repo } = await setupFake();
    const p = await repo.projects.create(projectInput());
    const [s1, s2, s3] = await Promise.all(
      [1, 2, 3].map((i) => repo.steps.create(stepInput(p.id, { stepKey: `${p.id}:${i}`, order: i }))),
    );
    const bulk = await repo.history.append({
      opId: "op-bulk",
      projectId: p.id,
      type: "node.archived",
      source: "MANUAL",
      actor: "local",
      summary: "C0822 · archived 2 steps",
      data: { stepIds: [s2.id, s3.id] },
      occurredAt: "2026-10-25T00:00:00.000Z",
    });
    expect(bulk.stepId).toBeUndefined();
    expect(historyHash(bulk)).toBe(bulk.hash);
    expect((await repo.history.listByStep(s2.id)).items.map((e) => e.opId)).toEqual(["op-bulk"]);
    expect((await repo.history.listByStep(s3.id, { type: "node.archived" })).items.map((e) => e.opId)).toEqual(["op-bulk"]);
    expect((await repo.history.listByStep(s1.id)).items).toEqual([]);
  });

  it("filters by type and source, answers hasOp, lists library events, and detects edits", async () => {
    const { repo, notion } = await setupFake();
    const p = await repo.projects.create(projectInput());
    const s = await repo.steps.create(stepInput(p.id));
    const m = await repo.milestones.create({ key: "k", name: "M", description: "", fieldType: "TEXT", choices: [], config: {}, order: 1, archived: false });
    await repo.history.append(event(p.id, s.id, 1));
    await repo.history.append(event(p.id, s.id, 2, { type: "note.added", source: "EMAIL", externalRef: "msg-1" }));
    const lib = await repo.history.append({
      opId: "op-lib",
      milestoneId: m.id,
      milestoneKey: "k",
      type: "milestone.updated",
      source: "SYSTEM",
      actor: "local",
      summary: "Library · M renamed",
      occurredAt: "2026-10-25T00:00:00.000Z",
    });
    expect(lib.projectId).toBeUndefined();
    expect(lib.milestoneId).toBe(m.id);
    expect((await repo.history.listByProject(p.id, { type: "note.added" })).items.map((e) => e.externalRef)).toEqual(["msg-1"]);
    expect((await repo.history.listByProject(p.id, { source: "MANUAL" })).items).toHaveLength(1);
    expect((await repo.history.listAll()).items.map((e) => e.opId)).toEqual(["op-lib", "op-2", "op-1"]);
    expect(await repo.history.hasOp("op-2")).toBe(true);
    expect(await repo.history.hasOp("op-3")).toBe(false);

    // Someone edits a row in Notion: the hash no longer matches.
    const reg = await discoverRegistry(notion, FAKE_OPTS);
    const h = reg.dbs.history!;
    await notion.pages.update({ page_id: lib.id, properties: { [h.props.summary]: { title: [{ type: "text", text: { content: "edited" } }] } } });
    const [edited] = (await repo.history.listAll({ limit: 1 })).items;
    expect(edited.summary).toBe("edited");
    expect(historyHash(edited)).not.toBe(edited.hash);
  });
});

describe("notes", () => {
  it("creates with the first line as title, lists newest first and updates", async () => {
    const { repo, notion } = await setupFake();
    const p = await repo.projects.create(projectInput());
    const s = await repo.steps.create(stepInput(p.id));
    const long = `Called SITA\n${"details ".repeat(600)}`; // > 2,000 characters: chunked body
    const n1 = await repo.notes.create({ projectId: p.id, stepId: s.id, body: long, author: "local", archived: false });
    const n2 = await repo.notes.create({ projectId: p.id, body: "Second note", author: "local", archived: false });
    expect(n1.body).toBe(long);
    expect(n1.stepId).toBe(s.id);
    expect(n2.stepId).toBeUndefined();
    const page = await notion.pages.retrieve({ page_id: n1.id });
    if (!isFullPage(page)) throw new Error("no page");
    expect(page.properties.Title.type === "title" && page.properties.Title.title[0].plain_text).toBe("Called SITA");
    const listed = await repo.notes.listByProject(p.id);
    expect(listed.map((n) => n.id)).toEqual([n2.id, n1.id]);
    const edited = await repo.notes.update(n2.id, { body: "Second note, edited", editedAt: "2026-10-25T03:00:00.000Z" });
    expect(edited).toMatchObject({ body: "Second note, edited", editedAt: "2026-10-25T03:00:00.000Z" });
    await repo.notes.update(n1.id, { archived: true });
    expect((await repo.notes.listByProject(p.id)).map((n) => n.id)).toEqual([n2.id]);
    expect(await repo.notes.listByProject(p.id, { includeArchived: true })).toHaveLength(2);
  });
});

describe("attachments", () => {
  it("creates links and files (4 MB boundary), opens files through a signed URL, archives", async () => {
    const { repo } = await setupFake();
    const p = await repo.projects.create(projectInput());
    const link = await repo.attachments.createLink({ projectId: p.id, name: "SharePoint folder", url: "https://gunnebo.sharepoint.com/x" });
    expect(link).toMatchObject({ kind: "LINK", url: "https://gunnebo.sharepoint.com/x", name: "SharePoint folder", archived: false });

    const bytes = new Uint8Array(MAX_FILE_BYTES);
    bytes[0] = 7;
    bytes[MAX_FILE_BYTES - 1] = 9;
    const file = await repo.attachments.createFile({
      projectId: p.id,
      name: "Purchase order 订单.pdf",
      contentType: "application/pdf",
      size: bytes.byteLength,
      data: new Blob([bytes], { type: "application/pdf" }),
    });
    expect(file).toMatchObject({ kind: "FILE", name: "Purchase order 订单.pdf", size: MAX_FILE_BYTES, contentType: "application/pdf" });
    expect(file.url).toBeUndefined();
    const dl = await repo.attachments.openFile(file.id);
    expect(dl).toMatchObject({ name: "Purchase order 订单.pdf", contentType: "application/pdf", size: MAX_FILE_BYTES });
    const got = fakeFileBytes(dl.url);
    expect(got?.size).toBe(MAX_FILE_BYTES);
    expect(got?.data[0]).toBe(7);
    expect(got?.data[MAX_FILE_BYTES - 1]).toBe(9);

    const tooBig = new Uint8Array(MAX_FILE_BYTES + 1);
    await expect(
      repo.attachments.createFile({ projectId: p.id, name: "big.pdf", contentType: "application/pdf", size: tooBig.byteLength, data: new Blob([tooBig]) }),
    ).rejects.toThrow(FileTooLargeError);

    expect((await repo.attachments.listByProject(p.id)).map((a) => a.id)).toEqual([link.id, file.id]);
    expect(await repo.attachments.get(file.id)).toEqual(file);
    const archived = await repo.attachments.update(link.id, { archived: true, archivedAt: "2026-10-25T00:00:00.000Z", name: "Old folder" });
    expect(archived).toMatchObject({ archived: true, name: "Old folder" });
    expect((await repo.attachments.listByProject(p.id)).map((a) => a.id)).toEqual([file.id]);
    await expect(repo.attachments.openFile(link.id)).rejects.toThrow(/no file/);
  });
});

describe("errors and stale ids", () => {
  it("maps a missing page to NotSharedError on update", async () => {
    const { repo } = await setupFake();
    await expect(repo.milestones.update("00000000-0000-4000-8000-000000000000", { name: "x" })).rejects.toThrow(NotSharedError);
  });

  it("rediscovers once when a cached data source id is stale", async () => {
    const { repo, notion, handle } = await setupFake();
    const p = await repo.projects.create(projectInput());
    await handle.load(); // memo now holds the current ids
    // Someone trashes Notes in Notion and Setup recreates it elsewhere (new ids).
    const reg = await discoverRegistry(notion, FAKE_OPTS);
    await notion.databases.update({ database_id: reg.dbs.notes!.databaseId, in_trash: true });
    const { runSetup } = await import("./helpers");
    await runSetup(notion);
    notion.fake.resetCalls();
    const note = await repo.notes.create({ projectId: p.id, body: "after reset", author: "local", archived: false });
    expect(note.body).toBe("after reset");
    expect(notion.fake.callCount("blocks.children.list")).toBe(1); // one rediscovery
    const ds = await notion.dataSources.retrieve({ data_source_id: (await discoverRegistry(notion, FAKE_OPTS)).dbs.notes!.dataSourceId });
    expect(isFullDataSource(ds) && ds.in_trash).toBe(false);
  });
});
