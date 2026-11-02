import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { seedTemplateFile } from "@/domain/seed";
import { SLUG_PATTERN, slugify } from "@/domain/slug";
import { parseTemplateFile } from "@/domain/templateFile";
import type { FieldType } from "@/domain/types";

/** The seed list of BRIEF.md: [number, name, spec]. */
function briefSeed(): [number, string, string][] {
  const brief = readFileSync(path.resolve(__dirname, "../../../docs/BRIEF.md"), "utf8");
  const section = brief.slice(brief.indexOf("## SEED"), brief.indexOf("Supported field types"));
  const rows: [number, string, string][] = [];
  for (const line of section.split("\n")) {
    const m = /^(\d+)\. (.+?) — (.+)$/.exec(line.trim());
    if (m) rows.push([Number(m[1]), m[2], m[3]]);
  }
  return rows;
}

function briefType(spec: string): FieldType {
  if (spec === "Date") return "DATE";
  if (spec === "Text") return "TEXT";
  if (spec === "Number (%)") return "PERCENT";
  if (spec.startsWith("Date range")) return "DATE_RANGE";
  if (spec.startsWith("Dropdown:")) return "DROPDOWN";
  if (spec.startsWith("Multiple:")) return "MULTIPLE";
  throw new Error(`Unknown type in brief: ${spec}`);
}

describe("seedTemplateFile", () => {
  const seed = seedTemplateFile();
  const brief = briefSeed();

  it("is a valid template file", () => {
    expect(parseTemplateFile(seed).ok).toBe(true);
  });

  it("has all 64 milestones of the brief, in order, with order 1..64", () => {
    expect(brief).toHaveLength(64);
    expect(seed.milestones).toHaveLength(64);
    seed.milestones.forEach((m, i) => {
      const [n, name, spec] = brief[i];
      expect(m.order).toBe(n);
      expect(m.name).toBe(name);
      expect(m.fieldType, `#${n} ${name}`).toBe(briefType(spec));
    });
  });

  it("uses short, unique, hand-picked keys", () => {
    const keys = seed.milestones.map((m) => m.key);
    expect(new Set(keys).size).toBe(64);
    for (const key of keys) {
      expect(key).toMatch(SLUG_PATTERN);
      expect(key.length).toBeLessThanOrEqual(48);
    }
    expect(keys.slice(0, 8)).toEqual([
      "enquiry-rfq-received",
      "pm-assigned",
      "customer-requirements",
      "technical-qa",
      "factory-lead-time-costing",
      "proposal-offer",
      "pre-po-approval",
      "customer-po-loi",
    ]);
    expect(keys[63]).toBe("project-closed");
  });

  it("uses label slugs as choice ids, unique within each list", () => {
    for (const m of seed.milestones) {
      const taken: string[] = [];
      for (const c of m.choices) {
        const expected = slugify(c.label, taken);
        expect(c.id, `${m.key}: ${c.label}`).toBe(expected);
        expect(c.id).toMatch(SLUG_PATTERN);
        taken.push(c.id);
      }
    }
    const handover = seed.milestones[9];
    expect(handover.choices.map((c) => c.id)).toEqual(["not-held", "scheduled", "held-open-items", "closed"]);
    expect(seed.milestones[7].choices.map((c) => c.id)).toEqual(["awaiting", "loi-received", "partial-po", "full-po", "revised-po"]);
  });

  it("gives every Dropdown choice a state and no choice is archived", () => {
    for (const m of seed.milestones) {
      for (const c of m.choices) {
        if (m.fieldType === "DROPDOWN") expect(c.state, `${m.key}: ${c.label}`).toBeDefined();
        expect(c.archived).toBeUndefined();
      }
    }
  });

  it("#37 Shipping documents is MULTIPLE with 9 choices and no states", () => {
    const m = seed.milestones[36];
    expect(m.fieldType).toBe("MULTIPLE");
    expect(m.choices.map((c) => c.label)).toEqual([
      "Packing list",
      "Commercial invoice",
      "MSDS",
      "Battery cert (UN38.3)",
      "Certificate of Origin",
      "Form E",
      "CE DoC",
      "FAT report",
      "Packing photos",
    ]);
    expect(m.choices.every((c) => c.state === undefined)).toBe(true);
  });

  it("#49 is PERCENT, #60 is DATE_RANGE, #63 is TEXT", () => {
    expect(seed.milestones[48]).toMatchObject({ key: "installation-progress", fieldType: "PERCENT", choices: [] });
    expect(seed.milestones[59]).toMatchObject({ key: "warranty-period", fieldType: "DATE_RANGE", choices: [] });
    expect(seed.milestones[62]).toMatchObject({ key: "lessons-learned", fieldType: "TEXT", choices: [] });
  });

  it("#55-58 are separate copies of #54's choices", () => {
    const advance = seed.milestones[53];
    expect(advance.choices).toHaveLength(8);
    expect(advance.choices.map((c) => `${c.id}:${c.state}`)).toEqual([
      "not-applicable:NOT_APPLICABLE",
      "not-due:NOT_STARTED",
      "invoiceable:IN_PROGRESS",
      "raised:IN_PROGRESS",
      "sent:WAITING",
      "disputed:BLOCKED",
      "overdue:BLOCKED",
      "paid:DONE",
    ]);
    for (const i of [54, 55, 56, 57]) {
      const m = seed.milestones[i];
      expect(m.choices).toEqual(advance.choices);
      expect(m.choices).not.toBe(advance.choices);
      m.choices.forEach((c, j) => expect(c).not.toBe(advance.choices[j]));
    }
  });

  it("chains 1 -> 2 -> ... -> 64 with 63 edges and no positions", () => {
    expect(seed.edges).toHaveLength(63);
    seed.edges.forEach((e, i) => {
      expect(e).toEqual({ from: seed.milestones[i].key, to: seed.milestones[i + 1].key });
    });
    expect(seed.milestones.some((m) => m.position !== undefined)).toBe(false);
  });

  it("has the 7 project fields", () => {
    expect(seed.projectFields).toEqual([
      {
        key: "customer",
        systemKey: "customer",
        label: "Customer",
        fieldType: "DROPDOWN",
        choices: [
          { id: "sita", label: "SITA" },
          { id: "idemia", label: "IDEMIA" },
          { id: "nec", label: "NEC" },
          { id: "collins-aerospace", label: "Collins Aerospace" },
        ],
        order: 1,
        showInSummary: true,
      },
      { key: "end-user", label: "End user", fieldType: "TEXT", choices: [], order: 2, showInSummary: true },
      { key: "site-country", label: "Site / country", fieldType: "TEXT", choices: [], order: 3, showInSummary: true },
      {
        key: "product",
        label: "Product",
        fieldType: "DROPDOWN",
        choices: [
          { id: "afl", label: "AFL" },
          { id: "afl-compact", label: "AFL-Compact" },
          { id: "immsec", label: "ImmSec" },
          { id: "abcs", label: "ABCS" },
        ],
        order: 4,
        showInSummary: true,
      },
      { key: "quantity", label: "Quantity", fieldType: "NUMBER", choices: [], config: { unit: "pcs" }, order: 5, showInSummary: true },
      {
        key: "project-type",
        systemKey: "projectType",
        label: "Project type",
        fieldType: "DROPDOWN",
        choices: [
          { id: "project", label: "Project" },
          { id: "spare-order", label: "Spare order" },
          { id: "adhoc", label: "Adhoc" },
          { id: "warranty-replacement", label: "Warranty replacement" },
        ],
        order: 6,
        showInSummary: true,
      },
      { key: "notes", label: "Notes", fieldType: "LONG_TEXT", choices: [], order: 7, showInSummary: false },
    ]);
  });

  it("returns a fresh copy on every call", () => {
    const a = seedTemplateFile();
    a.milestones[0].name = "Changed";
    a.milestones[2].choices[0].label = "Changed";
    a.edges.pop();
    const b = seedTemplateFile();
    expect(b.milestones[0].name).toBe("Enquiry / RFQ received");
    expect(b.milestones[2].choices[0].label).toBe("Not received");
    expect(b.edges).toHaveLength(63);
  });
});
