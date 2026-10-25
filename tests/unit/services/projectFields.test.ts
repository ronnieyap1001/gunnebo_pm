import { beforeEach, describe, expect, it } from "vitest";
import { EV } from "@/server/services/context";
import {
  addProjectFieldChoice,
  archiveProjectField,
  createProjectField,
  listProjectFields,
  restoreProjectField,
  updateProjectField,
} from "@/server/services/projectFields";
import { createProject, expectAppError, historyOfType, seedLibrary, world, type World } from "./_helpers";

let w: World;
beforeEach(async () => {
  w = world();
  await seedLibrary(w);
});

const field = async (key: string) => (await listProjectFields(w.repo, { includeArchived: true })).find((f) => f.key === key)!;

describe("project fields", () => {
  it("the seed creates the 7 default fields with system keys on Customer and Project type", async () => {
    const fields = await listProjectFields(w.repo);
    expect(fields.map((f) => f.key)).toEqual(["customer", "end-user", "site-country", "product", "quantity", "project-type", "notes"]);
    expect(fields.filter((f) => f.systemKey).map((f) => f.systemKey)).toEqual(["customer", "projectType"]);
  });

  it("creates a field (no File type) and logs it", async () => {
    const f = await createProjectField(w.ctx(), { label: "Related project", fieldType: "TEXT", showInSummary: false });
    expect(f).toMatchObject({ key: "related-project", order: 8, archived: false });
    await expectAppError(createProjectField(w.ctx(), { label: "Docs", fieldType: "FILE" }), "VALIDATION", /File/);
    expect(await historyOfType(w, EV.projectFieldCreated)).toHaveLength(1);
  });

  it("system fields can be renamed and get choices, but not be archived or lose their choices type", async () => {
    const customer = await field("customer");
    await updateProjectField(w.ctx(), customer.id, { label: "Client" });
    await expectAppError(archiveProjectField(w.ctx(), customer.id), "FORBIDDEN");
    await expectAppError(updateProjectField(w.ctx(), customer.id, { fieldType: "TEXT" }), "FORBIDDEN");
    const { choiceId } = await addProjectFieldChoice(w.ctx(), customer.id, "Thales");
    expect(choiceId).toBe("thales");
    const again = await addProjectFieldChoice(w.ctx(), customer.id, "thales");
    expect(again.choiceId).toBe("thales");
    expect((await field("customer")).choices.filter((c) => c.id === "thales")).toHaveLength(1);
  });

  it("retypes convert every project's value losslessly (Dropdown -> Multiple)", async () => {
    const product = await field("product");
    const p1 = await createProject(w, { code: "C1", details: { product: "afl" } });
    const p2 = await createProject(w, { code: "C2" });
    await updateProjectField(w.ctx(), product.id, { fieldType: "MULTIPLE" });
    expect((await w.repo.projects.get(p1))!.details[product.id]).toEqual({ choiceIds: ["afl"] });
    expect((await w.repo.projects.get(p2))!.details[product.id]).toBeUndefined();
    const row = (await historyOfType(w, EV.projectFieldUpdated))[0];
    expect(row.data).toMatchObject({ convertedProjects: [p1] });
  });

  it("a retype that would lose a value is refused, naming the blocking projects", async () => {
    const product = await field("product");
    await updateProjectField(w.ctx(), product.id, { fieldType: "MULTIPLE" });
    const id = await createProject(w, { code: "C0822", details: { product: ["afl", "abcs"] } });
    await expectAppError(updateProjectField(w.ctx(), product.id, { fieldType: "DROPDOWN" }), "VALIDATION", /C0822/);
    expect((await w.repo.projects.get(id))!.details[product.id]).toEqual({ choiceIds: ["afl", "abcs"] });
    expect((await field("product")).fieldType).toBe("MULTIPLE");
  });

  it("choices are never removed: left-out choices are archived and values keep resolving", async () => {
    const product = await field("product");
    const id = await createProject(w, { code: "C9", details: { product: "immsec" } });
    const updated = await updateProjectField(w.ctx(), product.id, { choices: [{ id: "afl", label: "AFL" }] });
    expect(updated.choices.find((c) => c.id === "immsec")).toMatchObject({ archived: true, label: "ImmSec" });
    expect((await w.repo.projects.get(id))!.details[product.id]).toEqual({ choiceId: "immsec" });
  });

  it("archives and restores a user field", async () => {
    const notes = await field("notes");
    await archiveProjectField(w.ctx(), notes.id);
    expect((await field("notes")).archived).toBe(true);
    await restoreProjectField(w.ctx(), notes.id);
    expect((await field("notes")).archived).toBe(false);
    expect(await historyOfType(w, EV.projectFieldArchived)).toHaveLength(1);
    expect(await historyOfType(w, EV.projectFieldRestored)).toHaveLength(1);
  });
});
