import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { APIResponseError, isFullDataSource, isFullPage } from "@notionhq/client";
import { createFakeNotion, fakeFileBytes } from "@/server/notion/fake";
import { fakeWithTable, text } from "./helpers";

async function expectNotionError(p: Promise<unknown>, code: string, message?: RegExp) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(APIResponseError.isAPIResponseError(err)).toBe(true);
  const e = err as APIResponseError;
  expect(e.code).toBe(code);
  if (message) expect(e.message).toMatch(message);
  return e;
}

async function propIds(notion: Awaited<ReturnType<typeof fakeWithTable>>["notion"], dsId: string) {
  const ds = await notion.dataSources.retrieve({ data_source_id: dsId });
  if (!isFullDataSource(ds)) throw new Error("no ds");
  return Object.fromEntries(Object.values(ds.properties).map((p) => [p.name, p.id]));
}

describe("fake Notion limits", () => {
  it("rejects a 2,001-character rich text item and more than 100 items", async () => {
    const { notion, dsId } = await fakeWithTable();
    const parent = { type: "data_source_id" as const, data_source_id: dsId };
    await expectNotionError(
      notion.pages.create({ parent, properties: { Notes: { rich_text: text("x".repeat(2001)) } } }),
      "validation_error",
      /≤ `2000`/,
    );
    const many = Array.from({ length: 101 }, () => text("a")[0]);
    await expectNotionError(notion.pages.create({ parent, properties: { Notes: { rich_text: many } } }), "validation_error", /≤ `100`/);
    const ok = await notion.pages.create({ parent, properties: { Notes: { rich_text: text("x".repeat(2000)) } } });
    expect(isFullPage(ok)).toBe(true);
  });

  it("rejects empty text items and empty URLs", async () => {
    const { notion, dsId } = await fakeWithTable();
    const parent = { type: "data_source_id" as const, data_source_id: dsId };
    await expectNotionError(notion.pages.create({ parent, properties: { Notes: { rich_text: text("") } } }), "validation_error");
    await expectNotionError(notion.pages.create({ parent, properties: { Link: { url: "" } } }), "validation_error");
  });

  it("rejects select names with commas and auto-creates unknown options without colour", async () => {
    const { notion, dsId } = await fakeWithTable();
    const parent = { type: "data_source_id" as const, data_source_id: dsId };
    await expectNotionError(
      notion.pages.create({ parent, properties: { Colour: { select: { name: "Acme, Inc." } } } }),
      "validation_error",
      /commas/,
    );
    await notion.pages.create({ parent, properties: { Colour: { select: { name: "Teal" } } } });
    const ds = await notion.dataSources.retrieve({ data_source_id: dsId });
    if (!isFullDataSource(ds)) throw new Error("no ds");
    const colour = ds.properties.Colour;
    expect(colour.type === "select" && colour.select.options.map((o) => [o.name, o.color])).toEqual([
      ["Red", "red"],
      ["Teal", "default"],
    ]);
  });

  it("caps relation writes at 100 ids, truncates responses to 25 with has_more, and filters on the full list", async () => {
    const { notion, dsId, targetDsId } = await fakeWithTable();
    const targets: string[] = [];
    for (let i = 0; i < 101; i++) {
      const p = await notion.pages.create({
        parent: { type: "data_source_id", data_source_id: targetDsId },
        properties: { Name: { title: text(`T${i}`) } },
      });
      targets.push(p.id);
    }
    const parent = { type: "data_source_id" as const, data_source_id: dsId };
    await expectNotionError(
      notion.pages.create({ parent, properties: { Targets: { relation: targets.map((id) => ({ id })) } } }),
      "validation_error",
      /≤ `100`/,
    );
    const page = await notion.pages.create({ parent, properties: { Targets: { relation: targets.slice(0, 30).map((id) => ({ id })) } } });
    if (!isFullPage(page)) throw new Error("no page");
    const rel = page.properties.Targets;
    expect(rel.type).toBe("relation");
    if (rel.type === "relation") {
      expect(rel.relation).toHaveLength(25);
      expect((rel as unknown as { has_more: boolean }).has_more).toBe(true);
    }
    const res = await notion.dataSources.query({
      data_source_id: dsId,
      filter: { property: "Targets", relation: { contains: targets[29] } },
    });
    expect(res.results.map((r) => r.id)).toEqual([page.id]);

    // Dual relation: the other side sees the link too; its name was NOT taken from synced_property_name.
    const tds = await notion.dataSources.retrieve({ data_source_id: targetDsId });
    if (!isFullDataSource(tds)) throw new Error("no ds");
    const back = Object.values(tds.properties).find((p) => p.type === "relation");
    expect(back?.name).toBe("Related to Things (Targets)");
    const t0 = await notion.pages.retrieve({ page_id: targets[0] });
    if (!isFullPage(t0)) throw new Error("no page");
    const backValue = Object.values(t0.properties).find((v) => v.type === "relation");
    expect(backValue?.type === "relation" && backValue.relation.map((r) => r.id)).toEqual([page.id]);
  });

  it("enforces page_size ≤ 100 and paginates with cursors", async () => {
    const { notion, dsId } = await fakeWithTable();
    for (let i = 0; i < 230; i++) {
      await notion.pages.create({
        parent: { type: "data_source_id", data_source_id: dsId },
        properties: { Name: { title: text(`Row ${i}`) }, Count: { number: i } },
      });
    }
    await expectNotionError(notion.dataSources.query({ data_source_id: dsId, page_size: 101 }), "validation_error", /page_size/);
    const seen: number[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const res = await notion.dataSources.query({
        data_source_id: dsId,
        page_size: 100,
        start_cursor: cursor,
        sorts: [{ property: "Count", direction: "descending" }],
      });
      pages++;
      for (const r of res.results) {
        if (isFullPage(r) && r.properties.Count.type === "number") seen.push(r.properties.Count.number ?? -1);
      }
      cursor = res.has_more ? (res.next_cursor ?? undefined) : undefined;
    } while (cursor);
    expect(pages).toBe(3);
    expect(seen).toEqual(Array.from({ length: 230 }, (_, i) => 229 - i));
    await expectNotionError(notion.dataSources.query({ data_source_id: dsId, start_cursor: "nope" }), "validation_error");
  });

  it("allows filters nested 2 levels and rejects 3", async () => {
    const { notion, dsId } = await fakeWithTable();
    const leaf = { property: "Done", checkbox: { equals: false } };
    await notion.dataSources.query({ data_source_id: dsId, filter: { and: [{ or: [leaf] }] } });
    await expectNotionError(
      notion.dataSources.query({
        data_source_id: dsId,
        // @ts-expect-error: the SDK types already forbid a third level
        filter: { and: [{ or: [{ and: [leaf] }] }] },
      }),
      "validation_error",
      /2 levels/,
    );
  });

  it("filters by property id or name: rich_text equals/contains, title, checkbox, select (string[]), number", async () => {
    const { notion, dsId } = await fakeWithTable();
    const ids = await propIds(notion, dsId);
    const parent = { type: "data_source_id" as const, data_source_id: dsId };
    const a = await notion.pages.create({
      parent,
      properties: { [ids.Name]: { title: text("Alpha") }, [ids.Notes]: { rich_text: text("Hello World") }, [ids.Count]: { number: 3 } },
    });
    await notion.pages.create({
      parent,
      properties: { Name: { title: text("Beta") }, Colour: { select: { name: "Red" } }, Done: { checkbox: true } },
    });
    const q = async (filter: Parameters<typeof notion.dataSources.query>[0]["filter"]) =>
      (await notion.dataSources.query({ data_source_id: dsId, filter })).results.map((r) =>
        isFullPage(r) && r.properties.Name.type === "title" ? r.properties.Name.title.map((t) => t.plain_text).join("") : "",
      );
    expect(await q({ property: ids.Notes, rich_text: { equals: "Hello World" } })).toEqual(["Alpha"]);
    expect(await q({ property: "Notes", rich_text: { contains: "world" } })).toEqual(["Alpha"]);
    expect(await q({ property: ids.Name, title: { equals: "Beta" } })).toEqual(["Beta"]);
    expect(await q({ property: "Done", checkbox: { equals: true } })).toEqual(["Beta"]);
    expect(await q({ property: "Colour", select: { equals: ["Red", "Blue"] } })).toEqual(["Beta"]);
    expect(await q({ property: "Count", number: { equals: 3 } })).toEqual(["Alpha"]);
    expect(isFullPage(a)).toBe(true);
    await expectNotionError(q({ property: "Nope", checkbox: { equals: true } }), "validation_error");
    await expectNotionError(q({ property: "Notes", checkbox: { equals: true } }), "validation_error");
  });

  it("truncates created_time to the minute and returns date-times as +00:00", async () => {
    let now = Date.UTC(2026, 9, 25, 6, 5, 42, 123);
    const { notion, dsId } = await fakeWithTable({ now: () => now });
    now += 1000;
    const p = await notion.pages.create({
      parent: { type: "data_source_id", data_source_id: dsId },
      properties: { When: { date: { start: "2026-10-24T06:05:07.250Z" } } },
    });
    if (!isFullPage(p)) throw new Error("no page");
    expect(p.created_time).toBe("2026-10-25T06:05:00.000Z");
    expect(p.properties.When.type === "date" && p.properties.When.date?.start).toBe("2026-10-24T06:05:07.250+00:00");
  });

  it("rejects request bodies over 500 KB", async () => {
    const { notion, dsId } = await fakeWithTable();
    const chunk = text("€".repeat(2000))[0]; // 3 bytes each in UTF-8: 100 chunks ≈ 600 KB
    await expectNotionError(
      notion.pages.create({
        parent: { type: "data_source_id", data_source_id: dsId },
        properties: { Notes: { rich_text: Array.from({ length: 100 }, () => chunk) } },
      }),
      "validation_error",
      /too large/,
    );
  });

  it("caps a query at the result limit and reports request_status incomplete", async () => {
    const { notion, dsId } = await fakeWithTable({ queryResultCap: 30 });
    for (let i = 0; i < 45; i++) {
      await notion.pages.create({ parent: { type: "data_source_id", data_source_id: dsId }, properties: { Count: { number: i } } });
    }
    const res = await notion.dataSources.query({ data_source_id: dsId, page_size: 100 });
    expect(res.results).toHaveLength(30);
    expect(res.has_more).toBe(false);
    expect(res.request_status?.type).toBe("incomplete");
  });

  it("refuses edits to trashed pages until restored", async () => {
    const { notion, dsId } = await fakeWithTable();
    const p = await notion.pages.create({ parent: { type: "data_source_id", data_source_id: dsId }, properties: {} });
    await notion.pages.update({ page_id: p.id, in_trash: true });
    await expectNotionError(notion.pages.update({ page_id: p.id, properties: { Count: { number: 1 } } }), "validation_error", /archived/);
    const restored = await notion.pages.update({ page_id: p.id, in_trash: false, properties: { Count: { number: 1 } } });
    expect(isFullPage(restored) && restored.in_trash).toBe(false);
    const res = await notion.dataSources.query({ data_source_id: dsId });
    expect(res.results).toHaveLength(1);
  });

  it("returns object_not_found for unknown ids and validation_error for malformed ones", async () => {
    const notion = createFakeNotion();
    await expectNotionError(notion.pages.retrieve({ page_id: "00000000-0000-4000-8000-000000000000" }), "object_not_found");
    await expectNotionError(notion.pages.retrieve({ page_id: "not-an-id" }), "validation_error");
  });
});

describe("fake Notion file uploads", () => {
  it("uploads, attaches and serves bytes through an expiring signed URL", async () => {
    let now = Date.UTC(2026, 9, 25, 6, 0, 0);
    const { notion, rootId } = await fakeWithTable({ now: () => now });
    const db = await notion.databases.create({
      parent: { type: "page_id", page_id: rootId },
      title: text("Files"),
      initial_data_source: { properties: { Name: { type: "title", title: {} }, File: { type: "files", files: {} } } },
    });
    const ds = "data_sources" in db ? db.data_sources[0].id : "";
    await expectNotionError(notion.fileUploads.create({ mode: "single_part", filename: "mail.msg" }), "validation_error", /\.msg/);
    const up = await notion.fileUploads.create({ mode: "single_part", filename: "a.pdf", content_type: "application/pdf" });
    expect(up.status).toBe("pending");
    await expectNotionError(
      notion.pages.create({
        parent: { type: "data_source_id", data_source_id: ds },
        properties: { File: { files: [{ type: "file_upload", file_upload: { id: up.id }, name: "a.pdf" }] } },
      }),
      "validation_error",
      /pending/,
    );
    const sent = await notion.fileUploads.send({
      file_upload_id: up.id,
      file: { filename: "a.pdf", data: new Blob([new Uint8Array([1, 2, 3])], { type: "application/pdf" }) },
    });
    expect(sent.status).toBe("uploaded");
    const page = await notion.pages.create({
      parent: { type: "data_source_id", data_source_id: ds },
      properties: { File: { files: [{ type: "file_upload", file_upload: { id: up.id }, name: "a.pdf" }] } },
    });
    if (!isFullPage(page)) throw new Error("no page");
    const files = page.properties.File;
    if (files.type !== "files" || files.files[0]?.type !== "file") throw new Error("no file");
    const url = files.files[0].file.url;
    expect(Array.from(fakeFileBytes(url)?.data ?? [])).toEqual([1, 2, 3]);
    expect(fakeFileBytes(url.replace(/sig=[0-9a-f]+/, "sig=bad"))).toBeNull();
    now += 2 * 3_600_000;
    expect(fakeFileBytes(url)).toBeNull();
  });

  it("rejects files above the workspace limit", async () => {
    const notion = createFakeNotion({ maxFileBytes: 10 });
    const up = await notion.fileUploads.create({ mode: "single_part", filename: "big.bin" });
    await expectNotionError(
      notion.fileUploads.send({ file_upload_id: up.id, file: { filename: "big.bin", data: new Blob([new Uint8Array(11)]) } }),
      "validation_error",
      /limit/,
    );
  });
});

describe("fake Notion persistence", () => {
  it("persists to a JSON file and reloads it in another instance", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-notion-"));
    const file = path.join(dir, "fake-notion.json");
    try {
      const a = createFakeNotion({ file });
      const p = await a.pages.create({ parent: { type: "workspace", workspace: true }, properties: { title: { title: text("Gunnebo PM") } } });
      const b = createFakeNotion({ file });
      const again = await b.pages.retrieve({ page_id: p.id });
      expect(again.id).toBe(p.id);
      // A change made by `b` is picked up by `a`.
      await b.pages.update({ page_id: p.id, properties: { title: { title: text("Renamed") } } });
      const seen = await a.pages.retrieve({ page_id: p.id });
      expect(isFullPage(seen) && seen.properties.title.type === "title" && seen.properties.title.title[0].plain_text).toBe("Renamed");

      // Uploaded bytes live next to the JSON file, not inside it.
      const db = await a.databases.create({
        parent: { type: "page_id", page_id: p.id },
        title: text("Files"),
        initial_data_source: { properties: { Name: { type: "title", title: {} }, File: { type: "files", files: {} } } },
      });
      const up = await a.fileUploads.create({ mode: "single_part", filename: "a.txt", content_type: "text/plain" });
      await a.fileUploads.send({ file_upload_id: up.id, file: { filename: "a.txt", data: new Blob(["hello"]) } });
      const row = await a.pages.create({
        parent: { type: "data_source_id", data_source_id: "data_sources" in db ? db.data_sources[0].id : "" },
        properties: { File: { files: [{ type: "file_upload", file_upload: { id: up.id }, name: "a.txt" }] } },
      });
      expect(fs.readFileSync(file, "utf8")).not.toContain(Buffer.from("hello").toString("base64"));
      const fromB = await b.pages.retrieve({ page_id: row.id });
      const files = isFullPage(fromB) ? fromB.properties.File : undefined;
      const url = files?.type === "files" && files.files[0]?.type === "file" ? files.files[0].file.url : "";
      expect(Buffer.from(b.fake.fileBytes(url)?.data ?? []).toString()).toBe("hello");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
