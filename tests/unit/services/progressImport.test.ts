import { beforeEach, describe, expect, it } from "vitest";
import { setStepValue } from "@/server/services/steps";
import { IMPORT_ACTOR, importMayWrite, importOpId, resolveChoice, runProgressImport } from "@/server/services/progressImport";
import { createProject, seedLibrary, world, type World } from "./_helpers";

/** A file like the one prepared from the mailbox: labels instead of ids, a new customer, a note, a link, a flag. */
function file(overrides: Record<string, unknown> = {}) {
  return {
    format: "gunnebo-pm-progress",
    version: 1,
    asOf: "2026-11-03",
    projects: [
      {
        code: "c0381",
        name: "Hanoi Metro L3 Gates",
        details: { customer: "RATP Smart Systems", "Site / country": "Hanoi, Vietnam", product: "Others", quantity: 6, "project-type": "Project" },
        steps: {
          "customer-po-loi": { value: "Full PO", note: "PO CF26002343 received 22/09/2026.", externalRef: "<msg-1@example.com>" },
          "po-check-acknowledgement": { value: "acknowledged" },
          "fat-date": { value: "2026-12-15" },
          bom: { value: "Requested", flag: "WAITING", flagReason: "PE has not released the BOM yet." },
          "pre-po-approval": { na: true },
          "o2f-shipment-requirements": { links: [{ name: "Delivery address thread", url: "https://outlook.office365.com/owa/?ItemID=abc" }] },
        },
        notes: ["Status 3 Nov: payment proof received, waiting for credit control to confirm."],
        ...overrides,
      },
    ],
  };
}

describe("progress import", () => {
  let w: World;
  beforeEach(async () => {
    w = world();
    await seedLibrary(w);
  });

  it("plans without writing anything when not applied", async () => {
    const writes = w.repo.writeCount();
    const r = await runProgressImport(w.repo, file());
    expect(r.applied).toBe(false);
    expect(w.repo.writeCount()).toBe(writes);
    expect(r.counts.error).toBe(0);
    expect(r.items.some((i) => i.outcome === "planned" && i.what.startsWith("create project"))).toBe(true);
    expect(r.items.some((i) => i.what.includes('add choice "RATP Smart Systems"'))).toBe(true);
  });

  it("creates the project with its details, values, flag, N/A, notes and links, attributed to the import", async () => {
    const r = await runProgressImport(w.repo, file(), { apply: true });
    expect(r.counts.error).toBe(0);
    const p = (await w.repo.projects.findByCode("C0381"))!;
    expect(p.name).toBe("Hanoi Metro L3 Gates");
    expect(p.setup).toBe("READY");

    const fields = await w.repo.projectFields.list();
    const customer = fields.find((f) => f.key === "customer")!;
    const ratp = customer.choices!.find((c) => c.label === "RATP Smart Systems")!;
    expect(p.details?.[customer.id]).toEqual({ choiceId: ratp.id });
    expect(p.details?.[fields.find((f) => f.key === "site-country")!.id]).toEqual({ text: "Hanoi, Vietnam" });

    const steps = await w.repo.steps.listByProject(p.id);
    const by = (k: string) => steps.find((s) => s.milestoneKey === k)!;
    expect(by("customer-po-loi").value).toEqual({ choiceId: "full-po" });
    expect(by("po-check-acknowledgement").value).toEqual({ choiceId: "acknowledged" });
    expect(by("fat-date").value).toEqual({ date: "2026-12-15" });
    expect(by("bom").value).toEqual({ choiceId: "requested" });
    expect(by("bom").flag).toBe("WAITING");
    expect(by("pre-po-approval").notApplicable).toBe(true);

    const notes = await w.repo.notes.listByProject(p.id);
    expect(notes.map((n) => n.body)).toEqual(
      expect.arrayContaining(["PO CF26002343 received 22/09/2026.", "Status 3 Nov: payment proof received, waiting for credit control to confirm."]),
    );
    const links = await w.repo.attachments.listByProject(p.id);
    expect(links.filter((a) => a.kind === "LINK")).toHaveLength(1);

    const history = w.repo.store.history.filter((h) => h.projectId === p.id && h.type === "step.value_changed");
    expect(history.length).toBe(4);
    expect(history.every((h) => h.actor === IMPORT_ACTOR && h.source === "EMAIL")).toBe(true);
    expect(w.repo.store.history.some((h) => h.externalRef === "<msg-1@example.com>")).toBe(true);
  });

  it("is safe to run again: the same file changes nothing and adds no duplicates", async () => {
    await runProgressImport(w.repo, file(), { apply: true });
    const historyBefore = w.repo.store.history.length;
    const notesBefore = w.repo.store.notes.size;
    const r = await runProgressImport(w.repo, file(), { apply: true });
    expect(r.counts.error).toBe(0);
    expect(r.counts.done).toBe(0);
    expect(w.repo.store.history.length).toBe(historyBefore);
    expect(w.repo.store.notes.size).toBe(notesBefore);
  });

  it("never overwrites a value changed in the app, but updates its own earlier values", async () => {
    await runProgressImport(w.repo, file(), { apply: true });
    const p = (await w.repo.projects.findByCode("C0381"))!;
    const steps = await w.repo.steps.listByProject(p.id);
    const po = steps.find((s) => s.milestoneKey === "customer-po-loi")!;
    // The user changes the PO value by hand in the app.
    await setStepValue(w.ctx(), { stepId: po.id, value: "revised-po", expectedRev: po.rev });

    const later = file();
    const spec = later.projects[0] as { steps: Record<string, { value?: unknown }> };
    spec.steps["customer-po-loi"] = { value: "Partial PO" };
    spec.steps["po-check-acknowledgement"] = { value: "Issues raised" };
    const r = await runProgressImport(w.repo, later, { apply: true });

    const after = await w.repo.steps.listByProject(p.id);
    expect(after.find((s) => s.milestoneKey === "customer-po-loi")!.value).toEqual({ choiceId: "revised-po" });
    expect(after.find((s) => s.milestoneKey === "po-check-acknowledgement")!.value).toEqual({ choiceId: "issues-raised" });
    expect(r.items.find((i) => i.what.startsWith("Customer PO"))?.outcome).toBe("skipped");
  });

  it("fills only empty details of an existing project", async () => {
    await createProject(w, { code: "C0381", name: "Hanoi (typed by hand)", details: { "site-country": "Hanoi" } });
    const r = await runProgressImport(w.repo, file(), { apply: true });
    const p = (await w.repo.projects.findByCode("C0381"))!;
    const fields = await w.repo.projectFields.list();
    expect(p.name).toBe("Hanoi (typed by hand)");
    expect(p.details?.[fields.find((f) => f.key === "site-country")!.id]).toEqual({ text: "Hanoi" });
    expect(p.details?.[fields.find((f) => f.key === "quantity")!.id]).toEqual({ number: 6 });
    expect(r.items.find((i) => i.what === "detail Site / country")?.outcome).toBe("skipped");
  });

  it("reports unknown milestones and choices as errors and still imports the rest", async () => {
    const bad = file();
    const spec = bad.projects[0] as { steps: Record<string, { value?: unknown }> };
    spec.steps["no-such-milestone"] = { value: "x" };
    spec.steps["proposal-offer"] = { value: "Maybe" };
    const r = await runProgressImport(w.repo, bad, { apply: true });
    expect(r.counts.error).toBe(2);
    expect(r.items.find((i) => i.what === "no-such-milestone")?.detail).toMatch(/No milestone/);
    expect(r.items.find((i) => i.what === "Proposal / offer")?.detail).toMatch(/Unknown choice "Maybe"/);
    const p = (await w.repo.projects.findByCode("C0381"))!;
    const steps = await w.repo.steps.listByProject(p.id);
    expect(steps.find((s) => s.milestoneKey === "customer-po-loi")!.value).toEqual({ choiceId: "full-po" });
  });

  it("refuses a file in the wrong format", async () => {
    const r = await runProgressImport(w.repo, { format: "something-else", projects: [] }, { apply: true });
    expect(r.counts.error).toBe(1);
  });
});

describe("progress import helpers", () => {
  it("matches choices by id or by label, ignoring case and spacing", () => {
    const choices = [
      { id: "full-po", label: "Full PO" },
      { id: "old", label: "Old", archived: true },
    ];
    expect(resolveChoice(choices, "full-po")).toBe("full-po");
    expect(resolveChoice(choices, "  full   po ")).toBe("full-po");
    expect(resolveChoice(choices, "old")).toBe("old");
    expect(resolveChoice(choices, "Old ")).toBe(null);
    expect(resolveChoice(choices, 3)).toBe(null);
  });

  it("gives the same opId for the same write and a different one for a different value", () => {
    expect(importOpId("value", "C0381", "bom", "requested")).toBe(importOpId("value", "C0381", "bom", "requested"));
    expect(importOpId("value", "C0381", "bom", "requested")).not.toBe(importOpId("value", "C0381", "bom", "released"));
    expect(importOpId("x")).toMatch(/^imp-[0-9a-f]{40}$/);
  });

  it("may write empty steps and steps it wrote itself, nothing else", () => {
    const base = { id: "s", name: "BOM", fieldType: "DROPDOWN" as const, choices: [], value: null, notApplicable: false, flag: null, rev: 0, stepKey: "k", projectId: "p", order: 1, position: { x: 0, y: 0 }, archived: false };
    expect(importMayWrite(base as never)).toBe(true);
    expect(importMayWrite({ ...base, value: { choiceId: "requested" }, lastOp: "user-op" } as never)).toBe(false);
    expect(importMayWrite({ ...base, value: { choiceId: "requested" }, lastOp: importOpId("v") } as never)).toBe(true);
    expect(importMayWrite({ ...base, notApplicable: true } as never)).toBe(false);
  });
});
