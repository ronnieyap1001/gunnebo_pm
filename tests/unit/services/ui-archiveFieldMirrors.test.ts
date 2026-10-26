/**
 * Archiving or restoring a project field shown in the summary changes the Summary line of the projects that have a
 * value in it, so their Notion copy (the Summary column) is rewritten too, with the same limit and note as a field
 * edit (review finding UI-6).
 */
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { archiveProjectFieldAction, restoreProjectFieldAction } from "@/app/(app)/library/actions";
import type { ProjectInput, ProjectMirrors } from "@/server/repo/types";
import { EV, type Ctx } from "@/server/services/context";
import {
  archiveProjectField,
  listProjectFields,
  MIRROR_REFRESH_LIMIT,
  restoreProjectField,
  updateProjectField,
} from "@/server/services/projectFields";
import { updateProject } from "@/server/services/projects";
import { createProject, historyOfType, seedLibrary, world, type World } from "./_helpers";

// The Library's Server Actions run on this test's memory repo (no sign-in, no cache tags).
const action = vi.hoisted(() => ({ ctx: null as null | (() => Ctx) }));
vi.mock("@/server/actions/run", () => ({
  runAction: async (_opId: string, fn: (ctx: Ctx) => Promise<unknown>) => ({ ok: true, data: await fn(action.ctx!()) }),
}));

let w: World;
/** What the Notion columns show: each mirror keeps its last written value (the memory repo keeps only the last write). */
let columns: Map<string, ProjectMirrors>;
/** Projects whose mirrors were written since the last reset. */
let mirrorWrites: string[];

beforeEach(async () => {
  w = world();
  await seedLibrary(w);
  columns = new Map();
  mirrorWrites = [];
  const { create, update } = w.repo.projects;
  const record = (id: string, mirrors: ProjectMirrors | undefined) => {
    if (!mirrors) return;
    columns.set(id, { ...columns.get(id), ...mirrors });
    mirrorWrites.push(id);
  };
  w.repo.projects.create = async (input) => {
    const p = await create(input);
    record(p.id, input.mirrors);
    return p;
  };
  w.repo.projects.update = async (id, patch) => {
    const p = await update(id, patch);
    record(id, patch.mirrors);
    return p;
  };
});

const mirrorsOf = (id: string) => columns.get(id) ?? {};
const field = async (key: string) => (await listProjectFields(w.repo, { includeArchived: true })).find((f) => f.key === key)!;

describe("archiving or restoring a summary field refreshes the Summary column in Notion (UI-6)", () => {
  it("archive takes the value out of the Summary, restore puts it back; other projects are not written", async () => {
    const site = await field("site-country");
    expect(site.showInSummary).toBe(true);
    const a = await createProject(w, { code: "C1", details: { [site.id]: "Heathrow T5" } });
    await createProject(w, { code: "C2" });
    expect(mirrorsOf(a).summary).toContain("Heathrow T5");

    mirrorWrites = [];
    expect(await archiveProjectField(w.ctx(), site.id)).toEqual({ mirrorsUpdated: 1 });
    expect(mirrorsOf(a).summary).not.toContain("Heathrow T5");
    expect(mirrorWrites).toEqual([a]); // C2 has no site value: its Summary is the same

    mirrorWrites = [];
    expect(await restoreProjectField(w.ctx(), site.id)).toEqual({ mirrorsUpdated: 1 });
    expect(mirrorsOf(a).summary).toContain("Heathrow T5");
    expect(mirrorWrites).toEqual([a]);
  });

  it("restore adds the value back to a Summary rewritten while the field was archived", async () => {
    const site = await field("site-country");
    const endUser = await field("end-user");
    const a = await createProject(w, { details: { [site.id]: "Heathrow T5" } });
    await archiveProjectField(w.ctx(), site.id);
    await updateProject(w.ctx(), a, { details: { [endUser.id]: "Heathrow Airport" } });
    expect(mirrorsOf(a).summary).toBe("Heathrow Airport");

    await restoreProjectField(w.ctx(), site.id);
    expect(mirrorsOf(a).summary).toContain("Heathrow Airport");
    expect(mirrorsOf(a).summary).toContain("Heathrow T5");
  });

  it("a field that is not in the summary writes only History and the field (no project is read or written)", async () => {
    const notes = await field("notes");
    expect(notes.showInSummary).toBe(false);
    await createProject(w, { details: { [notes.id]: "Gate 3 first" } });
    const writes = w.repo.writeCount();
    expect(await archiveProjectField(w.ctx(), notes.id)).toEqual({});
    expect(await restoreProjectField(w.ctx(), notes.id)).toEqual({});
    expect(w.repo.writeCount() - writes).toBe(4);
  });

  /** One project more than MIRROR_REFRESH_LIMIT with a value in the field. */
  async function tooManyProjects(fieldId: string): Promise<string[]> {
    const base: Omit<ProjectInput, "code"> = {
      name: "x",
      status: "ACTIVE",
      details: { [fieldId]: { text: "Heathrow T5" } },
      flow: { nodes: {}, edges: [] },
      cells: {},
      progress: 0,
      templateRevision: 1,
      syncDismissed: {},
      setup: "READY",
      archived: false,
      mirrors: { summary: "Heathrow T5" },
    };
    const ids: string[] = [];
    for (let i = 0; i <= MIRROR_REFRESH_LIMIT; i++) ids.push((await w.repo.projects.create({ ...base, code: `P${i}` })).id);
    return ids;
  }

  it(`more than ${MIRROR_REFRESH_LIMIT} affected projects: left to Repair mirrors, with the same note as a field edit`, async () => {
    const site = await field("site-country");
    const ids = await tooManyProjects(site.id);

    let writes = w.repo.writeCount();
    const archived = await archiveProjectField(w.ctx(), site.id);
    expect(archived.mirrorsNote).toMatch(/31 projects.*Repair mirrors/);
    expect(archived.mirrorsUpdated).toBeUndefined();
    expect(w.repo.writeCount() - writes).toBe(2); // History row + the field; no project writes
    expect(mirrorsOf(ids[0]).summary).toBe("Heathrow T5");

    writes = w.repo.writeCount();
    const restored = await restoreProjectField(w.ctx(), site.id);
    expect(restored.mirrorsNote).toBe(archived.mirrorsNote);
    expect(w.repo.writeCount() - writes).toBe(2);

    // The same rule and wording as hiding the field from the summary.
    const hidden = await updateProjectField(w.ctx(), site.id, { showInSummary: false });
    expect(hidden.mirrorsNote).toBe(archived.mirrorsNote);
  });

  it("the Library's archive and restore actions pass the note on to the fields tab", async () => {
    const site = await field("site-country");
    await tooManyProjects(site.id);
    action.ctx = () => w.ctx();
    const note = expect.stringMatching(/31 projects.*Repair mirrors/);
    expect(await archiveProjectFieldAction(randomUUID(), site.id)).toEqual({ ok: true, data: { id: site.id, mirrorsNote: note } });
    expect(await restoreProjectFieldAction(randomUUID(), site.id)).toEqual({ ok: true, data: { id: site.id, mirrorsNote: note } });
    // Nothing to say when the mirrors were rewritten (or none changed).
    const notes = await field("notes");
    expect(await archiveProjectFieldAction(randomUUID(), notes.id)).toEqual({ ok: true, data: { id: notes.id } });
  });

  it("a retry with the same opId after a crash before the field write finishes the archive, with one History row", async () => {
    const site = await field("site-country");
    const a = await createProject(w, { details: { [site.id]: "Heathrow T5" } });
    const opId = randomUUID();
    w.repo.beforeWrite = (op) => {
      if (op === "projectFields.update") throw new Error("crash");
    };
    await expect(archiveProjectField(w.ctx({ opId }), site.id)).rejects.toThrow("crash");
    w.repo.beforeWrite = null;
    expect((await field("site-country")).archived).toBe(false);

    expect(await archiveProjectField(w.ctx({ opId }), site.id)).toEqual({ mirrorsUpdated: 1 });
    expect((await field("site-country")).archived).toBe(true);
    expect(mirrorsOf(a).summary).not.toContain("Heathrow T5");
    expect(await historyOfType(w, EV.projectFieldArchived)).toHaveLength(1);
  });
});
