import { describe, expect, it } from "vitest";
import { planTemplateImport, type ImportPlan } from "@/domain/importPlan";
import { seedTemplateFile } from "@/domain/seed";
import { buildProjectSnapshot, remapFlow } from "@/domain/snapshot";
import { planSync } from "@/domain/syncPlan";
import { exportTemplateFile, parseTemplateFile, type TemplateFile } from "@/domain/templateFile";
import type { FlowEdge, Milestone, ProjectField, Template } from "@/domain/types";

const NOW = "2026-10-25T02:00:00.000Z";
const LATER = "2026-10-26T02:00:00.000Z";

function counter(prefix: string) {
  let n = 0;
  return () => `${prefix}${++n}`;
}

type Library = { template: Template; projectFields: ProjectField[] };
const EMPTY: Library = { template: { milestones: [], flow: { nodes: {}, edges: [] }, revision: 0 }, projectFields: [] };

function applyPatch<T extends object>(obj: T, patch: Partial<T>): T {
  const out = { ...obj } as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete out[k];
    else out[k] = v;
  }
  return out as T;
}

/** What the service layer does with a plan: create (ids 'id-<key>' / 'pf-<key>'), patch, archive, remap. */
function materialize(current: Library, plan: ImportPlan, at = NOW): Library {
  const idMap = Object.fromEntries(plan.milestoneCreates.map((c) => [c.tempId, `id-${c.data.key}`]));
  const milestones: Milestone[] = current.template.milestones.map((m) => {
    const update = plan.milestoneUpdates.find((u) => u.id === m.id);
    let next = update ? applyPatch(m, update.patch) : m;
    if (plan.milestoneArchives.includes(m.id)) next = { ...next, archived: true, archivedAt: at };
    return next;
  });
  for (const c of plan.milestoneCreates) {
    milestones.push({ ...c.data, id: idMap[c.tempId], createdAt: at, updatedAt: at });
  }
  const projectFields: ProjectField[] = current.projectFields.map((f) => {
    const update = plan.projectFieldUpdates.find((u) => u.id === f.id);
    return update ? applyPatch(f, update.patch) : f;
  });
  for (const c of plan.projectFieldCreates) projectFields.push({ ...c, id: `pf-${c.key}` });
  return {
    template: { milestones, flow: remapFlow(plan.flow, idMap), revision: current.template.revision + 1 },
    projectFields,
  };
}

const activePairs = (edges: FlowEdge[]) =>
  edges
    .filter((e) => !e.archivedAt)
    .map((e) => `${e.from}>${e.to}`)
    .sort();

const seeded = () => materialize(EMPTY, planTemplateImport(EMPTY, seedTemplateFile(), NOW, counter("e")));

const emptySummary = {
  added: [],
  updated: [],
  archived: [],
  choiceChanges: [],
  edgesAdded: 0,
  edgesRemoved: 0,
  projectFieldsAdded: [],
  projectFieldsUpdated: [],
};

describe("planTemplateImport: the seed into an empty library", () => {
  const file = seedTemplateFile();
  const plan = planTemplateImport(EMPTY, file, NOW, counter("e"));

  it("creates 64 milestones, 63 arrows and 7 project fields", () => {
    expect(plan.milestoneCreates).toHaveLength(64);
    expect(plan.milestoneCreates[0]).toEqual({
      tempId: "key:enquiry-rfq-received",
      data: {
        key: "enquiry-rfq-received",
        name: "Enquiry / RFQ received",
        description: "",
        fieldType: "DATE",
        choices: [],
        config: {},
        order: 1,
        archived: false,
      },
    });
    expect(plan.milestoneUpdates).toEqual([]);
    expect(plan.milestoneArchives).toEqual([]);
    expect(plan.flow.edges).toHaveLength(63);
    expect(plan.flow.edges[0]).toEqual({
      id: "e1",
      from: "key:enquiry-rfq-received",
      to: "key:pm-assigned",
      createdAt: NOW,
    });
    expect(plan.summary).toMatchObject({ edgesAdded: 63, edgesRemoved: 0, archived: [], updated: [] });
    expect(plan.summary.added).toHaveLength(64);
    expect(plan.projectFieldCreates.map((f) => [f.key, f.fieldType, f.showInSummary, f.systemKey])).toEqual([
      ["customer", "DROPDOWN", true, "customer"],
      ["end-user", "TEXT", true, undefined],
      ["site-country", "TEXT", true, undefined],
      ["product", "DROPDOWN", true, undefined],
      ["quantity", "NUMBER", true, undefined],
      ["project-type", "DROPDOWN", true, "projectType"],
      ["notes", "LONG_TEXT", false, undefined],
    ]);
    expect(plan.summary.projectFieldsAdded).toHaveLength(7);
  });

  it("lays the chain out with the wrapped auto-layout (no positions in the seed)", () => {
    const ids = file.milestones.map((m) => `key:${m.key}`);
    ids.forEach((id, i) => {
      expect(plan.flow.nodes[id]).toEqual({ x: (i % 12) * 224, y: Math.floor(i / 12) * 136 });
    });
  });

  it("gives a template whose fresh project copies 64 steps and 63 arrows with nothing to sync", () => {
    const { template } = seeded();
    const { steps, flow } = buildProjectSnapshot(template, NOW);
    expect(steps).toHaveLength(64);
    expect(flow.edges).toHaveLength(63);
    expect(flow.edges.every((e) => e.templateEdgeId && e.id === `te:${e.templateEdgeId}`)).toBe(true);
    const project = {
      steps: steps.map(({ tempId, ...s }) => ({ ...s, id: `s-${tempId}`, projectId: "p", createdAt: NOW, updatedAt: NOW })),
      flow: remapFlow(flow, Object.fromEntries(steps.map((s) => [s.tempId, `s-${s.tempId}`]))),
      dismissed: {},
    };
    expect(planSync(template, project, { today: "2026-10-25", timeZone: "Asia/Singapore" })).toEqual({
      items: [],
      warnings: [],
    });
  });
});

describe("planTemplateImport: re-importing", () => {
  it("is a no-op for the same file", () => {
    const lib = seeded();
    const plan = planTemplateImport(lib, seedTemplateFile(), LATER, counter("x"));
    expect(plan.summary).toEqual(emptySummary);
    expect(plan.milestoneCreates).toEqual([]);
    expect(plan.milestoneUpdates).toEqual([]);
    expect(plan.milestoneArchives).toEqual([]);
    expect(plan.projectFieldCreates).toEqual([]);
    expect(plan.projectFieldUpdates).toEqual([]);
    expect(plan.flow.edges).toEqual(lib.template.flow.edges);
  });

  it("round-trips export -> parse -> import with ids, keys and positions preserved", () => {
    const lib = seeded();
    const moved = {
      ...lib,
      template: {
        ...lib.template,
        flow: { ...lib.template.flow, nodes: { ...lib.template.flow.nodes, "id-pm-assigned": { x: 5, y: 999 } } },
      },
    };
    const parsed = parseTemplateFile(JSON.parse(JSON.stringify(exportTemplateFile(moved.template, moved.projectFields, NOW))));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const plan = planTemplateImport(moved, parsed.file, LATER, counter("x"));
    expect(plan.summary).toEqual(emptySummary);
    expect(plan.flow).toEqual(moved.template.flow);
    const after = materialize(moved, plan);
    expect(after.template.milestones.map((m) => [m.id, m.key])).toEqual(moved.template.milestones.map((m) => [m.id, m.key]));
  });
});

describe("planTemplateImport: replacing the template", () => {
  function edited(): TemplateFile {
    const file = seedTemplateFile();
    const ms = file.milestones;
    const po = ms.find((m) => m.key === "customer-po-loi")!;
    po.name = "Customer PO";
    po.choices = po.choices
      .filter((c) => c.id !== "revised-po")
      .map((c) => (c.id === "awaiting" ? { ...c, label: "Awaiting PO" } : c));
    ms.find((m) => m.key === "lessons-learned")!.fieldType = "LONG_TEXT";
    // Insert "Credit check" between #1 and #2; drop #64.
    ms.splice(1, 0, { key: "credit-check", name: "Credit check", fieldType: "CHECKBOX", order: 1.5, choices: [] });
    ms.pop();
    const first = ms[0].key;
    const second = ms[2].key;
    file.edges = file.edges.filter((e) => !(e.from === first && e.to === second) && e.to !== "project-closed");
    file.edges.push({ from: first, to: "credit-check" }, { from: "credit-check", to: second });
    return file;
  }

  it("upserts by key, archives what is missing and replaces the arrows", () => {
    const lib = seeded();
    const file = edited();
    const plan = planTemplateImport(lib, file, LATER, counter("x"));

    expect(plan.summary.added).toEqual(["Credit check"]);
    expect(plan.milestoneCreates.map((c) => c.tempId)).toEqual(["key:credit-check"]);
    expect(plan.summary.archived).toEqual(["Project closed"]);
    expect(plan.milestoneArchives).toEqual(["id-project-closed"]);
    expect(plan.summary.updated).toEqual(["Customer PO", "Lessons learned"]);
    expect(plan.milestoneUpdates).toEqual([
      {
        id: "id-customer-po-loi",
        patch: {
          name: "Customer PO",
          choices: [
            { id: "awaiting", label: "Awaiting PO", state: "WAITING" },
            { id: "loi-received", label: "LOI received", state: "IN_PROGRESS" },
            { id: "partial-po", label: "Partial PO", state: "IN_PROGRESS" },
            { id: "full-po", label: "Full PO", state: "DONE" },
            { id: "revised-po", label: "Revised PO", state: "DONE", archived: true },
          ],
        },
      },
      { id: "id-lessons-learned", patch: { fieldType: "LONG_TEXT" } },
    ]);
    expect(plan.summary.choiceChanges).toEqual(['Customer PO: Renamed "Awaiting" → "Awaiting PO"; retired "Revised PO".']);

    // Arrows: 1 -> 2 and 63 -> 64 archived (IMPORT), two new ones, the other 61 keep their ids.
    expect(plan.summary).toMatchObject({ edgesAdded: 2, edgesRemoved: 2 });
    const byPair = (from: string, to: string) => plan.flow.edges.filter((e) => e.from === from && e.to === to);
    expect(byPair("id-enquiry-rfq-received", "id-pm-assigned")[0]).toMatchObject({
      id: "e1",
      archivedAt: LATER,
      archivedReason: "IMPORT",
    });
    expect(byPair("id-enquiry-rfq-received", "key:credit-check")[0]).toEqual({
      id: "x1",
      from: "id-enquiry-rfq-received",
      to: "key:credit-check",
      createdAt: LATER,
    });
    expect(plan.flow.edges.filter((e) => !e.archivedAt)).toHaveLength(63);
    const kept = lib.template.flow.edges.filter((e) => plan.flow.edges.some((p) => p.id === e.id && !p.archivedAt));
    expect(kept).toHaveLength(61);

    // The archived milestone keeps its position; the new one is placed by the wrapped layout.
    expect(plan.flow.nodes["id-project-closed"]).toEqual(lib.template.flow.nodes["id-project-closed"]);
    expect(plan.flow.nodes["key:credit-check"]).toEqual({ x: 224, y: 0 });
  });

  it("restores an archived milestone and an archived arrow found in the file", () => {
    const lib = seeded();
    const once = materialize(lib, planTemplateImport(lib, edited(), LATER, counter("x")), LATER);
    const plan = planTemplateImport(once, seedTemplateFile(), LATER, counter("y"));
    expect(plan.summary.updated).toContain("Project closed (restored)");
    expect(plan.milestoneUpdates.find((u) => u.id === "id-project-closed")!.patch).toEqual({
      archived: false,
      archivedAt: undefined,
      archiveBatch: undefined,
    });
    expect(plan.milestoneArchives).toEqual(["id-credit-check"]);
    // The same pairs reuse their old edge ids, so project links survive.
    const after = materialize(once, plan);
    expect(activePairs(after.template.flow.edges)).toEqual(activePairs(lib.template.flow.edges));
    expect(after.template.flow.edges.filter((e) => !e.archivedAt).map((e) => e.id).sort()).toEqual(
      lib.template.flow.edges.map((e) => e.id).sort(),
    );
    // The file's choices win: the retired choice is active again (same id) and the label is back.
    const po = after.template.milestones.find((m) => m.key === "customer-po-loi")!;
    expect(po.choices.find((c) => c.id === "awaiting")!.label).toBe("Awaiting");
    expect(po.choices.find((c) => c.id === "revised-po")!.archived).toBeUndefined();
    expect(plan.summary.choiceChanges).toEqual([
      'Customer PO / LOI: Renamed "Awaiting PO" → "Awaiting"; brought back "Revised PO".',
    ]);
  });

  it("uses positions from the file, keeping or defaulting the ones it lacks", () => {
    const lib = seeded();
    const file = seedTemplateFile();
    file.milestones.forEach((m, i) => (m.position = { x: i, y: 7 }));
    const all = planTemplateImport(lib, file, LATER, counter("x"));
    expect(all.flow.nodes["id-pm-assigned"]).toEqual({ x: 1, y: 7 });

    delete file.milestones[1].position;
    file.milestones.push({ key: "extra", name: "Extra", fieldType: "TEXT", order: 65, choices: [] });
    const mixed = planTemplateImport(lib, file, LATER, counter("x"));
    expect(mixed.flow.nodes["id-pm-assigned"]).toEqual(lib.template.flow.nodes["id-pm-assigned"]);
    expect(mixed.flow.nodes["key:extra"]).toEqual({ x: 0, y: 7 + 56 + 80 });
  });
});

describe("planTemplateImport: project fields", () => {
  it("merges choices by id, never archives missing fields and never retypes an existing field", () => {
    const lib = seeded();
    const fields = lib.projectFields.map((f) => {
      if (f.key === "customer") return { ...f, label: "Client", choices: [...f.choices, { id: "acme", label: "ACME" }] };
      if (f.key === "product") return { ...f, fieldType: "MULTIPLE" as const };
      if (f.key === "notes") return { ...f, archived: true, archivedAt: NOW };
      return f;
    });
    fields.push({
      id: "pf-po-number",
      key: "po-number",
      label: "PO number",
      fieldType: "TEXT",
      choices: [],
      config: {},
      order: 8,
      showInSummary: false,
      archived: false,
    });
    const plan = planTemplateImport({ ...lib, projectFields: fields }, seedTemplateFile(), LATER, counter("x"));
    expect(plan.projectFieldCreates).toEqual([]);
    expect(plan.projectFieldUpdates).toEqual([
      {
        id: "pf-customer",
        patch: {
          label: "Customer",
          choices: [
            { id: "sita", label: "SITA" },
            { id: "idemia", label: "IDEMIA" },
            { id: "nec", label: "NEC" },
            { id: "collins-aerospace", label: "Collins Aerospace" },
            { id: "acme", label: "ACME", archived: true },
          ],
        },
      },
      { id: "pf-notes", patch: { archived: false, archivedAt: undefined } },
    ]);
    expect(plan.summary.projectFieldsUpdated).toEqual([
      "Customer",
      "Product (field type kept as Multiple; the file has Dropdown)",
      "Notes",
    ]);
    // A project whose Customer is ACME still resolves its label.
    const after = materialize({ ...lib, projectFields: fields }, plan);
    expect(after.projectFields.find((f) => f.key === "customer")!.choices.find((c) => c.id === "acme")!.label).toBe("ACME");
    expect(after.projectFields.find((f) => f.key === "po-number")).toBeDefined();
    expect(after.projectFields.find((f) => f.key === "product")!.fieldType).toBe("MULTIPLE");
  });
});
