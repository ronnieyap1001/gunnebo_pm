import { createFakeNotion, type FakeNotion, type FakeNotionOptions } from "@/server/notion/fake";
import { createRegistryHandle, runSchemaStep, type RegistryOptions } from "@/server/notion/registry";
import { createNotionRepo } from "@/server/repo/notionRepo";

export const FAKE_OPTS: RegistryOptions = {
  mode: "fake",
  parentTitle: "Gunnebo PM",
  createParentIfMissing: true,
};

/** Runs Setup until done; returns the messages. */
export async function runSetup(notion: FakeNotion, opts: RegistryOptions = FAKE_OPTS, max = 40): Promise<string[]> {
  const messages: string[] = [];
  for (let i = 0; i < max; i++) {
    const r = await runSchemaStep(notion, opts);
    messages.push(r.message);
    if (r.done) return messages;
  }
  throw new Error(`Setup did not finish in ${max} steps: ${messages.join(" | ")}`);
}

/** A fake Notion with all databases set up, plus a repo on it. */
export async function setupFake(fakeOpts?: FakeNotionOptions) {
  const notion = createFakeNotion(fakeOpts);
  const messages = await runSetup(notion);
  const handle = createRegistryHandle(notion, FAKE_OPTS);
  const repo = createNotionRepo(notion, handle);
  notion.fake.resetCalls();
  return { notion, repo, handle, messages };
}

/** A minimal page + database in a fresh fake, for limit tests. */
export async function fakeWithTable(fakeOpts?: FakeNotionOptions) {
  const notion = createFakeNotion(fakeOpts);
  const root = await notion.pages.create({
    parent: { type: "workspace", workspace: true },
    properties: { title: { title: [{ type: "text", text: { content: "Root" } }] } },
  });
  const target = await notion.databases.create({
    parent: { type: "page_id", page_id: root.id },
    title: [{ type: "text", text: { content: "Targets" } }],
    initial_data_source: { properties: { Name: { type: "title", title: {} } } },
  });
  const targetDs = "data_sources" in target ? target.data_sources[0].id : "";
  const db = await notion.databases.create({
    parent: { type: "page_id", page_id: root.id },
    title: [{ type: "text", text: { content: "Things" } }],
    initial_data_source: {
      properties: {
        Name: { type: "title", title: {} },
        Notes: { type: "rich_text", rich_text: {} },
        Count: { type: "number", number: { format: "number" } },
        Done: { type: "checkbox", checkbox: {} },
        Colour: { type: "select", select: { options: [{ name: "Red", color: "red" }] } },
        When: { type: "date", date: {} },
        Link: { type: "url", url: {} },
        Targets: {
          type: "relation",
          relation: { data_source_id: targetDs, type: "dual_property", dual_property: { synced_property_name: "Things" } },
        },
      },
    },
  });
  const ds = "data_sources" in db ? db.data_sources[0].id : "";
  return { notion, rootId: root.id, dsId: ds, targetDsId: targetDs, databaseId: db.id };
}

export function text(content: string) {
  return [{ type: "text" as const, text: { content } }];
}
