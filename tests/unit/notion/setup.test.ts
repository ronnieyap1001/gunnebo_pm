import { describe, expect, it } from "vitest";
import { isFullDataSource } from "@notionhq/client";
import { createFakeNotion } from "@/server/notion/fake";
import {
  createRegistryHandle,
  createStorageAdmin,
  discoverRegistry,
  isComplete,
  nextPendingStep,
  runSchemaStep,
} from "@/server/notion/registry";
import { DB_ORDER, SCHEMA, dbMarker } from "@/server/notion/schema";
import { createNotionRepo } from "@/server/repo/notionRepo";
import { FAKE_OPTS, runSetup, setupFake, text } from "./helpers";

describe("schema setup end-to-end", () => {
  it("creates the parent page and all 8 databases, then finishes the schema work", async () => {
    const notion = createFakeNotion();
    const messages = await runSetup(notion);
    expect(messages.slice(0, 8)).toEqual(DB_ORDER.map((k, i) => `Created database ${SCHEMA[k].title} (${i + 1} of 8)`));
    expect(messages).toContain('Named the Steps link on Projects "Steps"');
    expect(messages).toContain("Saved the property map in Settings");
    expect(messages.some((m) => m.startsWith("Locked the layout of 8 databases"))).toBe(true);
    expect(messages.at(-1)).toBe("Notion is set up.");

    const reg = await discoverRegistry(notion, FAKE_OPTS);
    expect(reg.problems).toEqual([]);
    expect(reg.warnings).toEqual([]);
    expect(reg.parent?.title).toBe("Gunnebo PM");
    expect(isComplete(reg)).toBe(true);
    expect(nextPendingStep(reg)).toBeNull();
    for (const k of DB_ORDER) {
      const e = reg.dbs[k]!;
      expect(e.matchedBy).toBe("marker");
      expect(e.locked).toBe(true);
      expect(e.missing).toEqual([]);
      for (const pk of Object.keys(SCHEMA[k].props)) expect(e.props[pk], `${k}.${pk}`).toBeTruthy();
    }
    expect(reg.dbs.projects!.propNames.steps).toBe("Steps");
    expect(reg.saved?.dbs.steps?.props).toEqual(reg.dbs.steps!.props);

    // Pre-created select options carry colours.
    const steps = await notion.dataSources.retrieve({ data_source_id: reg.dbs.steps!.dataSourceId });
    if (!isFullDataSource(steps)) throw new Error("no ds");
    const state = Object.values(steps.properties).find((p) => p.name === "State");
    expect(state?.type === "select" && state.select.options.map((o) => `${o.name}:${o.color}`)).toEqual([
      "Not started:gray",
      "In progress:blue",
      "Waiting:yellow",
      "Blocked:red",
      "Done:green",
      "Not applicable:default",
    ]);
  });

  it("is idempotent: a second run creates nothing", async () => {
    const notion = createFakeNotion();
    await runSetup(notion);
    notion.fake.resetCalls();
    const r = await runSchemaStep(notion, FAKE_OPTS);
    expect(r.done).toBe(true);
    expect(notion.fake.callCount("databases.create")).toBe(0);
    expect(notion.fake.callCount("dataSources.update")).toBe(0);
    expect(notion.fake.callCount("pages.create")).toBe(0);

    // Also from a cold start (no memo in this instance).
    const handle = createRegistryHandle(notion, FAKE_OPTS);
    const admin = createStorageAdmin(notion, handle, FAKE_OPTS);
    await admin.resetCaches();
    const again = await admin.runSchemaStep();
    expect(again.done).toBe(true);
    expect(notion.fake.callCount("databases.create")).toBe(0);
  });

  it("keeps mapping a property by id after it is renamed in Notion (marker, then saved map)", async () => {
    const { notion, repo, handle } = await setupFake();
    const before = await discoverRegistry(notion, FAKE_OPTS);
    const steps = before.dbs.steps!;
    const valueDataId = steps.props.valueData;

    // Rename "Value data" and also strip its description marker: only the saved map can find it now.
    await notion.dataSources.update({
      data_source_id: steps.dataSourceId,
      properties: { [valueDataId]: { name: "Raw value", description: null, rich_text: {} } },
    });
    // Rename the whole database too: the description marker still finds it.
    await notion.databases.update({ database_id: steps.databaseId, title: text("Project steps") });

    const after = await discoverRegistry(notion, FAKE_OPTS);
    expect(after.dbs.steps!.props.valueData).toBe(valueDataId);
    expect(after.dbs.steps!.propNames.valueData).toBe("Raw value");
    expect(after.dbs.steps!.missing).toEqual([]);
    expect(after.dbs.steps!.title).toBe("Project steps");

    // The repo keeps working with the renamed property.
    handle.reset();
    const project = await repo.projects.create({
      code: "c1",
      name: "Renamed",
      status: "ACTIVE",
      details: {},
      flow: { nodes: {}, edges: [] },
      cells: {},
      progress: 0,
      templateRevision: 1,
      syncDismissed: {},
      setup: "READY",
      archived: false,
    });
    const step = await repo.steps.create({
      projectId: project.id,
      name: "PO",
      description: "",
      fieldType: "TEXT",
      choices: [],
      config: {},
      value: { text: "kept" },
      notApplicable: false,
      flag: null,
      order: 1,
      rev: 0,
      archived: false,
      stepKey: `${project.id}:x`,
    });
    expect((await repo.steps.get(step.id))?.value).toEqual({ text: "kept" });
  });

  it("adds a property that was deleted in Notion back on the next setup step", async () => {
    const notion = createFakeNotion();
    await runSetup(notion);
    const reg = await discoverRegistry(notion, FAKE_OPTS);
    await notion.dataSources.update({ data_source_id: reg.dbs.history!.dataSourceId, properties: { [reg.dbs.history!.props.hash]: null } });
    const handle = createRegistryHandle(notion, FAKE_OPTS);
    const admin = createStorageAdmin(notion, handle, FAKE_OPTS);
    await admin.resetCaches();
    const s = await admin.status();
    expect(s.schemaReady).toBe(false);
    expect(s.databases.find((d) => d.name === "History")?.ok).toBe(false);
    await expect(createNotionRepo(notion, handle).history.hasOp("x")).rejects.toThrow(/History database in Notion is missing "Hash"/);
    const step = await admin.runSchemaStep();
    expect(step.message).toBe("Added 1 missing property to History");
    const done = await runSetup(notion);
    expect(done.at(-1)).toBe("Notion is set up.");
    const fixed = await discoverRegistry(notion, FAKE_OPTS);
    expect(fixed.dbs.history!.missing).toEqual([]);
    expect(fixed.dbs.history!.props.hash).not.toBe(reg.dbs.history!.props.hash);
  });

  it("matches by title when the marker is missing, and warns about duplicates", async () => {
    const notion = createFakeNotion();
    await runSetup(notion);
    const reg = await discoverRegistry(notion, FAKE_OPTS);
    // A second database with the Notes marker in the same page.
    await notion.databases.create({
      parent: { type: "page_id", page_id: reg.parent!.id },
      title: text("Notes copy"),
      description: text(`copy (${dbMarker("notes")})`),
      initial_data_source: { properties: { Title: { type: "title", title: {} } } },
    });
    const again = await discoverRegistry(notion, FAKE_OPTS);
    expect(again.dbs.notes!.databaseId).toBe(reg.dbs.notes!.databaseId);
    expect(again.warnings.join(" ")).toMatch(/look like "Notes"/);

    // Title fallback: strip the Settings marker.
    await notion.databases.update({ database_id: reg.dbs.settings!.databaseId, description: text("plain") });
    const byTitle = await discoverRegistry(notion, FAKE_OPTS);
    expect(byTitle.dbs.settings!.matchedBy).toBe("title");
    expect(byTitle.dbs.settings!.databaseId).toBe(reg.dbs.settings!.databaseId);
  });

  it("reports status before and after setup, and the seed flag", async () => {
    const notion = createFakeNotion();
    const handle = createRegistryHandle(notion, FAKE_OPTS);
    const admin = createStorageAdmin(notion, handle, FAKE_OPTS);
    const s0 = await admin.status();
    expect(s0.mode).toBe("fake");
    expect(s0.schemaReady).toBe(false);
    expect(s0.databases.every((d) => !d.ok)).toBe(true);
    expect(s0.parentPage?.title).toBe("Gunnebo PM");

    for (let i = 0; i < 30; i++) if ((await admin.runSchemaStep()).done) break;
    const s1 = await admin.status();
    expect(s1.problems).toEqual([]);
    expect(s1.schemaReady).toBe(true);
    expect(s1.seeded).toBe(false);
    expect(s1.databases.map((d) => d.name)).toEqual(DB_ORDER.map((k) => SCHEMA[k].title));

    await createNotionRepo(notion, handle).settings.set("seed.appliedAt", "2026-10-25T00:00:00.000Z");
    expect((await admin.status()).seeded).toBe(true);
    expect(admin.databaseNames()).toEqual([...DB_ORDER]);
  });

  it("finds the parent page by exact title only, and asks for NOTION_PARENT_PAGE_ID when there are several", async () => {
    const notion = createFakeNotion();
    const opts = { ...FAKE_OPTS, createParentIfMissing: false };
    expect((await discoverRegistry(notion, opts)).problems[0]).toMatch(/No Notion page called "Gunnebo PM"/);
    // A page whose title only contains the name does not count.
    await notion.pages.create({ parent: { type: "workspace", workspace: true }, properties: { title: { title: text("Gunnebo PM notes") } } });
    expect((await discoverRegistry(notion, opts)).parent).toBeNull();
    const a = await notion.pages.create({ parent: { type: "workspace", workspace: true }, properties: { title: { title: text("Gunnebo PM") } } });
    expect((await discoverRegistry(notion, opts)).parent?.id).toBe(a.id);
    await notion.pages.create({ parent: { type: "page_id", page_id: a.id }, properties: { title: { title: text("Gunnebo PM") } } });
    const two = await discoverRegistry(notion, opts);
    expect(two.parent).toBeNull();
    expect(two.problems[0]).toMatch(/Several Notion pages/);
    const byId = await discoverRegistry(notion, { ...opts, parentPageId: a.id.replace(/-/g, "") });
    expect(byId.parent?.id).toBe(a.id);
    const preview = await discoverRegistry(notion, { ...opts, parentTitle: "Gunnebo PM (Preview)" });
    expect(preview.problems[0]).toMatch(/Gunnebo PM \(Preview\)/);
    const missing = await discoverRegistry(notion, { ...opts, parentPageId: "11111111-1111-4111-8111-111111111111" });
    expect(missing.problems[0]).toMatch(/cannot see the page in NOTION_PARENT_PAGE_ID/);
  });

  it("trashAll moves the databases to the trash and setup recreates them", async () => {
    const notion = createFakeNotion();
    await runSetup(notion);
    const handle = createRegistryHandle(notion, FAKE_OPTS);
    const admin = createStorageAdmin(notion, handle, FAKE_OPTS);
    const before = await discoverRegistry(notion, FAKE_OPTS);
    await admin.trashAll();
    const gone = await discoverRegistry(notion, FAKE_OPTS);
    expect(Object.keys(gone.dbs)).toEqual([]);
    const db = await notion.databases.retrieve({ database_id: before.dbs.steps!.databaseId });
    expect("in_trash" in db && db.in_trash).toBe(true);
    await runSetup(notion);
    const after = await discoverRegistry(notion, FAKE_OPTS);
    expect(isComplete(after)).toBe(true);
    expect(after.dbs.steps!.databaseId).not.toBe(before.dbs.steps!.databaseId);
  });

  it("exportPage pages through every row, also past the query result cap", async () => {
    let now = Date.UTC(2026, 9, 25, 0, 0, 0);
    const { notion, handle, repo } = await setupFake({ now: () => now, queryResultCap: 40 });
    for (let i = 0; i < 95; i++) {
      now += 61_000; // a new minute for each row so created_time windows can advance
      await repo.settings.set(`k.${String(i).padStart(3, "0")}`, { i });
    }
    const admin = createStorageAdmin(notion, handle, FAKE_OPTS);
    const ids = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res: { rows: unknown[]; nextCursor: string | null } = await admin.exportPage("Settings", cursor);
      for (const r of res.rows as { id: string; values: Record<string, unknown> }[]) {
        expect(ids.has(r.id)).toBe(false);
        ids.add(r.id);
        expect(typeof r.values.key).toBe("string");
      }
      cursor = res.nextCursor;
      pages++;
    } while (cursor && pages < 50);
    // 95 rows + schema.registry + schema.version written by setup.
    expect(ids.size).toBe(97);
    await expect(admin.exportPage("Nope", null)).rejects.toThrow(/Unknown database/);
  });
});
