import { describe, expect, it } from "vitest";
import { seedTemplateFile } from "@/domain/seed";
import {
  TEMPLATE_FILE_FORMAT,
  exportTemplateFile,
  parseTemplateFile,
  templateFileToJson,
  type TemplateFile,
} from "@/domain/templateFile";
import type { FlowEdge, Milestone, ProjectField, Template } from "@/domain/types";

function minimal(): TemplateFile {
  return {
    format: TEMPLATE_FILE_FORMAT,
    version: 1,
    milestones: [
      {
        key: "a",
        name: "A",
        fieldType: "DROPDOWN",
        order: 1,
        choices: [
          { id: "open", label: "Open", state: "IN_PROGRESS" },
          { id: "done", label: "Done", state: "DONE" },
        ],
      },
      { key: "b", name: "B", fieldType: "DATE", order: 2, choices: [] },
      { key: "c", name: "C", fieldType: "MULTIPLE", order: 3, choices: [{ id: "x", label: "X" }] },
    ],
    edges: [
      { from: "a", to: "b" },
      { from: "b", to: "c" },
    ],
  };
}

function errorsOf(input: unknown): string[] {
  const result = parseTemplateFile(input);
  expect(result.ok).toBe(false);
  return result.ok ? [] : result.errors;
}

describe("parseTemplateFile: valid files", () => {
  it("accepts the seed", () => {
    const result = parseTemplateFile(seedTemplateFile());
    expect(result.ok).toBe(true);
  });

  it("accepts a minimal file and fills defaults", () => {
    const input = minimal() as unknown as Record<string, unknown>;
    const ms = (input.milestones as Record<string, unknown>[]).map((m) => {
      const { choices, ...rest } = m;
      return rest.key === "b" ? rest : { ...rest, choices };
    });
    const result = parseTemplateFile({ ...input, milestones: ms, edges: undefined });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.file.milestones[1].choices).toEqual([]);
      expect(result.file.edges).toEqual([]);
    }
  });

  it("accepts a JSON string", () => {
    expect(parseTemplateFile(JSON.stringify(minimal())).ok).toBe(true);
  });

  it("accepts parallel branches that merge again", () => {
    const f = minimal();
    f.milestones.push({ key: "d", name: "D", fieldType: "TEXT", order: 4, choices: [] });
    f.edges = [
      { from: "a", to: "b" },
      { from: "a", to: "c" },
      { from: "b", to: "d" },
      { from: "c", to: "d" },
    ];
    expect(parseTemplateFile(f).ok).toBe(true);
  });

  it("ignores unknown extra properties", () => {
    const result = parseTemplateFile({ ...minimal(), comment: "hand edited" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.file).not.toHaveProperty("comment");
  });
});

describe("parseTemplateFile: invalid files with plain-English errors", () => {
  it.each<[string, (f: TemplateFile) => unknown, RegExp]>([
    ["not JSON", () => "{nope", /not valid JSON/],
    ["not an object", () => [1, 2], /not a Gunnebo PM template/],
    ["wrong format", (f) => ({ ...f, format: "something-else" }), /"format" must be "gunnebo-pm.template"/],
    ["wrong version", (f) => ({ ...f, version: 2 }), /^version must be 1$/],
    ["no milestones", (f) => ({ ...f, milestones: [], edges: [] }), /^milestones must have at least one item$/],
    [
      "bad key",
      (f) => ({ ...f, milestones: [{ ...f.milestones[0], key: "Bad Key" }, ...f.milestones.slice(1)] }),
      /^milestones\[0\]\.key "Bad Key" must be 1–64 characters/,
    ],
    [
      "bad choice id",
      (f) => {
        f.milestones[0].choices[1].id = "-done";
        return f;
      },
      /^milestones\[0\]\.choices\[1\]\.id "-done" must be/,
    ],
    [
      "bad state",
      (f) => {
        (f.milestones[0].choices[0] as { state: string }).state = "FINISHED";
        return f;
      },
      /^milestones\[0\]\.choices\[0\]\.state must be one of "NOT_STARTED", "IN_PROGRESS"/,
    ],
    [
      "bad field type",
      (f) => {
        (f.milestones[1] as { fieldType: string }).fieldType = "Date";
        return f;
      },
      /^milestones\[1\]\.fieldType must be one of/,
    ],
    [
      "missing name",
      (f) => {
        delete (f.milestones[2] as Partial<TemplateFile["milestones"][number]>).name;
        return f;
      },
      /^milestones\[2\]\.name is required$/,
    ],
    [
      "blank name",
      (f) => {
        f.milestones[2].name = "   ";
        return f;
      },
      /^milestones\[2\]\.name must not be empty$/,
    ],
    [
      "order not a number",
      (f) => {
        (f.milestones[0] as { order: unknown }).order = "1";
        return f;
      },
      /^milestones\[0\]\.order must be a number$/,
    ],
    [
      "duplicate key",
      (f) => {
        f.milestones[2].key = "a";
        f.edges = [{ from: "a", to: "b" }];
        return f;
      },
      /^milestones\[2\]\.key "a" is used more than once \(also milestones\[0\]\)$/,
    ],
    [
      "duplicate choice id",
      (f) => {
        f.milestones[0].choices[1].id = "open";
        return f;
      },
      /^milestones\[0\]\.choices\[1\]\.id "open" is used more than once/,
    ],
    [
      "dropdown choice without state",
      (f) => {
        delete f.milestones[0].choices[1].state;
        return f;
      },
      /^milestones\[0\]\.choices\[1\]\.state is required for Dropdown choices \("Done"\)$/,
    ],
    ["dangling edge", (f) => ({ ...f, edges: [...f.edges, { from: "c", to: "zz" }] }), /^edges\[2\]\.to "zz" is not a milestone key/],
    ["dangling edge source", (f) => ({ ...f, edges: [{ from: "q", to: "a" }] }), /^edges\[0\]\.from "q" is not a milestone key/],
    ["self loop", (f) => ({ ...f, edges: [{ from: "a", to: "a" }] }), /^edges\[0\] goes from "a" to itself$/],
    ["duplicate edge", (f) => ({ ...f, edges: [...f.edges, { from: "a", to: "b" }] }), /^edges\[2\] repeats edges\[0\] \("a" → "b"\)$/],
    ["cycle", (f) => ({ ...f, edges: [...f.edges, { from: "c", to: "a" }] }), /^edges form a loop through "a", "b", "c"$/],
    ["edge missing to", (f) => ({ ...f, edges: [{ from: "a" }] }), /^edges\[0\]\.to is required$/],
    [
      "too many choices",
      (f) => {
        f.milestones[2].choices = Array.from({ length: 101 }, (_, i) => ({ id: `c${i}`, label: `C${i}` }));
        return f;
      },
      /^milestones\[2\]\.choices has too many items \(maximum 100\)$/,
    ],
    [
      "too many milestones",
      (f) => ({
        ...f,
        milestones: Array.from({ length: 1001 }, (_, i) => ({ key: `m${i}`, name: `M${i}`, fieldType: "TEXT", order: i, choices: [] })),
        edges: [],
      }),
      /^milestones has too many items \(maximum 1000\)$/,
    ],
    [
      "string too long",
      (f) => {
        f.milestones[0].description = "d".repeat(501);
        return f;
      },
      /^milestones\[0\]\.description is too long \(maximum 500 characters\)$/,
    ],
    [
      "label too long",
      (f) => {
        f.milestones[2].choices[0].label = "l".repeat(501);
        return f;
      },
      /^milestones\[2\]\.choices\[0\]\.label is too long/,
    ],
    [
      "project field duplicate key",
      (f) => ({
        ...f,
        projectFields: [
          { key: "customer", label: "Customer", fieldType: "DROPDOWN", choices: [], order: 1, showInSummary: true },
          { key: "customer", label: "Client", fieldType: "TEXT", choices: [], order: 2, showInSummary: true },
        ],
      }),
      /^projectFields\[1\]\.key "customer" is used more than once/,
    ],
    [
      "project field bad system key",
      (f) => ({
        ...f,
        projectFields: [{ key: "x", systemKey: "status", label: "X", fieldType: "DROPDOWN", choices: [], order: 1, showInSummary: true }],
      }),
      /^projectFields\[0\]\.systemKey must be one of "customer", "projectType"$/,
    ],
    [
      "system field without choices",
      (f) => ({
        ...f,
        projectFields: [{ key: "customer", systemKey: "customer", label: "Customer", fieldType: "TEXT", choices: [], order: 1, showInSummary: true }],
      }),
      /^projectFields\[0\]\.fieldType must be Dropdown or Multiple for the "customer" field$/,
    ],
    [
      "project field of type File",
      (f) => ({
        ...f,
        projectFields: [{ key: "doc", label: "Doc", fieldType: "FILE", choices: [], order: 1, showInSummary: false }],
      }),
      /^projectFields\[0\]\.fieldType File is not available for project fields$/,
    ],
  ])("%s", (_label, mutate, message) => {
    const errors = errorsOf(mutate(minimal()));
    expect(errors.some((e) => message.test(e)), errors.join("\n")).toBe(true);
  });

  it("reports several problems at once", () => {
    const f = minimal();
    f.milestones[0].choices[0].state = undefined;
    f.edges.push({ from: "a", to: "nowhere" }, { from: "b", to: "b" });
    expect(errorsOf(f)).toHaveLength(3);
  });

  it("loop errors name only the milestones on the loop", () => {
    const f = minimal();
    f.milestones.push({ key: "d", name: "D", fieldType: "TEXT", order: 4, choices: [] });
    f.edges = [
      { from: "a", to: "b" },
      { from: "b", to: "c" },
      { from: "c", to: "b" },
      { from: "c", to: "d" },
    ];
    expect(errorsOf(f)).toEqual(['edges form a loop through "b", "c"']);
  });

  it("MULTIPLE choices and project-field choices do not need a state", () => {
    const f = minimal();
    f.projectFields = [{ key: "product", label: "Product", fieldType: "DROPDOWN", choices: [{ id: "afl", label: "AFL" }], order: 1, showInSummary: true }];
    expect(parseTemplateFile(f).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

const T0 = "2026-10-01T00:00:00.000Z";

function milestone(id: string, key: string, order: number, extra: Partial<Milestone> = {}): Milestone {
  return {
    id,
    key,
    name: key.toUpperCase(),
    description: "",
    fieldType: "TEXT",
    choices: [],
    config: {},
    order,
    archived: false,
    createdAt: T0,
    updatedAt: T0,
    ...extra,
  };
}

const edge = (id: string, from: string, to: string, extra: Partial<FlowEdge> = {}): FlowEdge => ({ id, from, to, createdAt: T0, ...extra });

function sampleTemplate(): { template: Template; fields: ProjectField[] } {
  const template: Template = {
    revision: 7,
    milestones: [
      milestone("id-b", "b", 2, {
        fieldType: "DROPDOWN",
        description: "Second step",
        choices: [
          { id: "open", label: "Open", state: "IN_PROGRESS" },
          { id: "retired", label: "Retired", state: "DONE", archived: true },
        ],
      }),
      milestone("id-a", "a", 1, { fieldType: "NUMBER", config: { unit: "pcs" } }),
      milestone("id-gone", "gone", 3, { archived: true, archivedAt: T0 }),
      milestone("id-c", "c", 2.5),
    ],
    flow: {
      nodes: { "id-a": { x: 0, y: 0 }, "id-b": { x: 240, y: 0 }, "id-gone": { x: 480, y: 0 } },
      edges: [
        edge("e1", "id-a", "id-b"),
        edge("e2", "id-b", "id-gone"),
        edge("e3", "id-a", "id-c", { archivedAt: T0, archivedReason: "USER" }),
        edge("e4", "id-b", "id-c"),
        edge("e5", "id-a", "id-b"), // stray duplicate row
      ],
    },
  };
  const fields: ProjectField[] = [
    {
      id: "pf-2",
      key: "customer",
      systemKey: "customer",
      label: "Customer",
      fieldType: "DROPDOWN",
      choices: [
        { id: "sita", label: "SITA" },
        { id: "old-co", label: "Old Co", archived: true },
      ],
      config: {},
      order: 1,
      showInSummary: true,
      archived: false,
    },
    { id: "pf-3", key: "notes", label: "Notes", fieldType: "LONG_TEXT", choices: [], config: {}, order: 7, showInSummary: false, archived: false },
    { id: "pf-4", key: "legacy", label: "Legacy", fieldType: "TEXT", choices: [], config: {}, order: 3, showInSummary: false, archived: true },
  ];
  return { template, fields };
}

describe("exportTemplateFile", () => {
  const { template, fields } = sampleTemplate();
  const file = exportTemplateFile(template, fields, "2026-10-25T02:00:00.000Z");

  it("writes the header", () => {
    expect(file.format).toBe("gunnebo-pm.template");
    expect(file.version).toBe(1);
    expect(file.exportedAt).toBe("2026-10-25T02:00:00.000Z");
    expect(file.templateRevision).toBe(7);
  });

  it("leaves out archived milestones and sorts by order", () => {
    expect(file.milestones.map((m) => m.key)).toEqual(["a", "b", "c"]);
  });

  it("keeps archived choices, descriptions, config and positions", () => {
    const b = file.milestones.find((m) => m.key === "b")!;
    expect(b.choices).toEqual([
      { id: "open", label: "Open", state: "IN_PROGRESS" },
      { id: "retired", label: "Retired", state: "DONE", archived: true },
    ]);
    expect(b.description).toBe("Second step");
    expect(b.position).toEqual({ x: 240, y: 0 });
    expect(file.milestones[0].config).toEqual({ unit: "pcs" });
    expect(file.milestones[2]).not.toHaveProperty("position");
    expect(file.milestones[2]).not.toHaveProperty("config");
  });

  it("exports only active arrows between exported milestones, once per pair, as keys", () => {
    expect(file.edges).toEqual([
      { from: "a", to: "b" },
      { from: "b", to: "c" },
    ]);
  });

  it("leaves out archived project fields and keeps archived choices", () => {
    expect(file.projectFields!.map((f) => f.key)).toEqual(["customer", "notes"]);
    expect(file.projectFields![0]).toEqual({
      key: "customer",
      systemKey: "customer",
      label: "Customer",
      fieldType: "DROPDOWN",
      choices: [
        { id: "sita", label: "SITA" },
        { id: "old-co", label: "Old Co", archived: true },
      ],
      order: 1,
      showInSummary: true,
    });
  });

  it("round-trips through parseTemplateFile (and JSON) unchanged", () => {
    const result = parseTemplateFile(JSON.parse(templateFileToJson(file)));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.file).toEqual(file);
  });

  it("export -> import of the seed preserves keys, names, choice ids and edges", () => {
    const seed = seedTemplateFile();
    const asTemplate: Template = {
      revision: 1,
      milestones: seed.milestones.map((m, i) =>
        milestone(`id-${i}`, m.key, m.order, { name: m.name, fieldType: m.fieldType, choices: m.choices, config: m.config ?? {} }),
      ),
      flow: {
        nodes: {},
        edges: seed.edges.map((e, i) => edge(`e-${i}`, `id-${seed.milestones.findIndex((m) => m.key === e.from)}`, `id-${seed.milestones.findIndex((m) => m.key === e.to)}`)),
      },
    };
    const pfs: ProjectField[] = seed.projectFields!.map((f, i) => ({ ...f, id: `pf-${i}`, config: f.config ?? {}, archived: false }));
    const exported = exportTemplateFile(asTemplate, pfs, "2026-10-25T00:00:00.000Z");
    const parsed = parseTemplateFile(exported);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.file.milestones).toEqual(seed.milestones);
    expect(parsed.file.edges).toEqual(seed.edges);
    expect(parsed.file.projectFields).toEqual(seed.projectFields);
  });
});
