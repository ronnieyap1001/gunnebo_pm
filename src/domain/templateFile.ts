/**
 * The template JSON file: format, validation (zod + semantic checks) and export.
 * Import planning (turning a file into changes) lives in importPlan.ts.
 */
import { z } from "zod";
import { FIELD_TYPE_META } from "./fieldTypes";
import { SLUG_PATTERN } from "./slug";
import {
  FIELD_TYPES,
  STATES,
  type Choice,
  type FieldConfig,
  type FieldType,
  type Iso,
  type Position,
  type ProjectField,
  type SystemFieldKey,
  type Template,
} from "./types";

export const TEMPLATE_FILE_FORMAT = "gunnebo-pm.template";

export const TEMPLATE_FILE_LIMITS = {
  milestones: 1000,
  choicesPerList: 100,
  stringLength: 500,
  edges: 10_000,
  projectFields: 200,
} as const;

export interface TemplateFileMilestone {
  key: string;
  name: string;
  description?: string;
  fieldType: FieldType;
  config?: FieldConfig;
  order: number;
  position?: Position;
  choices: Choice[];
}

export interface TemplateFileProjectField {
  key: string;
  systemKey?: SystemFieldKey;
  label: string;
  fieldType: FieldType;
  choices: Choice[];
  config?: FieldConfig;
  order: number;
  showInSummary: boolean;
}

export interface TemplateFile {
  format: "gunnebo-pm.template";
  version: 1;
  exportedAt?: Iso;
  templateRevision?: number;
  milestones: TemplateFileMilestone[];
  edges: { from: string; to: string }[];
  projectFields?: TemplateFileProjectField[];
}

export type ParseTemplateFileResult = { ok: true; file: TemplateFile } | { ok: false; errors: string[] };

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const MAX = TEMPLATE_FILE_LIMITS.stringLength;
const SYSTEM_KEYS = ["customer", "projectType"] as const satisfies readonly SystemFieldKey[];

const text = z.string().max(MAX);
const requiredText = z
  .string()
  .max(MAX)
  .refine((s) => s.trim().length > 0, { message: "must not be empty" });
const slug = z.string().regex(SLUG_PATTERN);

const choiceSchema = z.object({
  id: slug,
  label: requiredText,
  state: z.enum(STATES).optional(),
  archived: z.boolean().optional(),
});

const configSchema = z.object({ unit: text.optional() });
const positionSchema = z.object({ x: z.number(), y: z.number() });

const milestoneSchema = z.object({
  key: slug,
  name: requiredText,
  description: text.optional(),
  fieldType: z.enum(FIELD_TYPES),
  config: configSchema.optional(),
  order: z.number(),
  position: positionSchema.optional(),
  choices: z.array(choiceSchema).max(TEMPLATE_FILE_LIMITS.choicesPerList).default([]),
});

const edgeSchema = z.object({ from: z.string().max(MAX), to: z.string().max(MAX) });

const projectFieldSchema = z.object({
  key: slug,
  systemKey: z.enum(SYSTEM_KEYS).optional(),
  label: requiredText,
  fieldType: z.enum(FIELD_TYPES),
  choices: z.array(choiceSchema).max(TEMPLATE_FILE_LIMITS.choicesPerList).default([]),
  config: configSchema.optional(),
  order: z.number(),
  showInSummary: z.boolean().default(false),
});

const fileSchema = z.object({
  format: z.literal(TEMPLATE_FILE_FORMAT),
  version: z.literal(1),
  exportedAt: z.string().max(100).optional(),
  templateRevision: z.number().int().min(0).optional(),
  milestones: z.array(milestoneSchema).min(1).max(TEMPLATE_FILE_LIMITS.milestones),
  edges: z.array(edgeSchema).max(TEMPLATE_FILE_LIMITS.edges).default([]),
  projectFields: z.array(projectFieldSchema).max(TEMPLATE_FILE_LIMITS.projectFields).optional(),
});

// ---------------------------------------------------------------------------
// Plain-English errors
// ---------------------------------------------------------------------------

function formatPath(path: readonly PropertyKey[]): string {
  let out = "";
  for (const seg of path) {
    if (typeof seg === "number") out += `[${seg}]`;
    else out += out ? `.${String(seg)}` : String(seg);
  }
  return out || "The file";
}

function valueAt(root: unknown, path: readonly PropertyKey[]): unknown {
  let cur: unknown = root;
  for (const seg of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<PropertyKey, unknown>)[seg];
  }
  return cur;
}

const TYPE_NAMES: Record<string, string> = {
  string: "text",
  number: "a number",
  boolean: "true or false",
  array: "a list",
  object: "an object",
};

function describeIssue(issue: z.core.$ZodIssue, root: unknown): string {
  const p = formatPath(issue.path);
  const value = valueAt(root, issue.path);
  switch (issue.code) {
    case "invalid_type":
      if (value === undefined) return `${p} is required`;
      return `${p} must be ${TYPE_NAMES[issue.expected] ?? issue.expected}`;
    case "invalid_value": {
      const options = issue.values.map((v) => JSON.stringify(v));
      return options.length === 1 ? `${p} must be ${options[0]}` : `${p} must be one of ${options.join(", ")}`;
    }
    case "too_big":
      if (issue.origin === "string") return `${p} is too long (maximum ${String(issue.maximum)} characters)`;
      if (issue.origin === "array") return `${p} has too many items (maximum ${String(issue.maximum)})`;
      return `${p} must be at most ${String(issue.maximum)}`;
    case "too_small":
      if (issue.origin === "string") return `${p} must not be empty`;
      if (issue.origin === "array") {
        return Number(issue.minimum) === 1
          ? `${p} must have at least one item`
          : `${p} must have at least ${String(issue.minimum)} items`;
      }
      return `${p} must be at least ${String(issue.minimum)}`;
    case "invalid_format":
      if (issue.format === "regex") {
        return `${p} ${JSON.stringify(value)} must be 1–64 characters of lowercase letters, digits, "-" or "_", starting with a letter or digit`;
      }
      return `${p} has the wrong format`;
    case "custom":
      return `${p} ${issue.message}`;
    default:
      return `${p}: ${issue.message}`;
  }
}

// ---------------------------------------------------------------------------
// Semantic checks
// ---------------------------------------------------------------------------

function checkChoices(choices: Choice[], path: string, requireState: boolean, errors: string[]): void {
  const seen = new Map<string, number>();
  choices.forEach((c, i) => {
    const first = seen.get(c.id);
    if (first !== undefined) {
      errors.push(`${path}.choices[${i}].id "${c.id}" is used more than once (also ${path}.choices[${first}])`);
    } else {
      seen.set(c.id, i);
    }
    if (requireState && !c.state) {
      errors.push(`${path}.choices[${i}].state is required for Dropdown choices ("${c.label}")`);
    }
  });
}

/** Keys of nodes that sit on (or between) loops, or [] when the graph is acyclic. */
function loopKeys(keys: string[], edges: { from: string; to: string }[]): string[] {
  const remaining = new Set(keys);
  // Kahn's algorithm forwards (peel nodes with no incoming arrows), then backwards (no outgoing arrows).
  // Whatever is left sits on a loop or between loops.
  for (const forward of [true, false]) {
    const indegree = new Map<string, number>();
    const next = new Map<string, string[]>();
    for (const k of remaining) {
      indegree.set(k, 0);
      next.set(k, []);
    }
    for (const e of edges) {
      if (!remaining.has(e.from) || !remaining.has(e.to)) continue;
      const [a, b] = forward ? [e.from, e.to] : [e.to, e.from];
      next.get(a)!.push(b);
      indegree.set(b, indegree.get(b)! + 1);
    }
    const queue = [...remaining].filter((k) => indegree.get(k) === 0);
    while (queue.length > 0) {
      const k = queue.pop()!;
      remaining.delete(k);
      for (const b of next.get(k)!) {
        const d = indegree.get(b)! - 1;
        indegree.set(b, d);
        if (d === 0) queue.push(b);
      }
    }
  }
  return keys.filter((k) => remaining.has(k));
}

function semanticErrors(file: TemplateFile): string[] {
  const errors: string[] = [];

  const keyIndex = new Map<string, number>();
  file.milestones.forEach((m, i) => {
    const first = keyIndex.get(m.key);
    if (first !== undefined) errors.push(`milestones[${i}].key "${m.key}" is used more than once (also milestones[${first}])`);
    else keyIndex.set(m.key, i);
    checkChoices(m.choices, `milestones[${i}]`, m.fieldType === "DROPDOWN", errors);
  });

  const pairs = new Map<string, number>();
  const validEdges: { from: string; to: string }[] = [];
  file.edges.forEach((e, i) => {
    let ok = true;
    if (!keyIndex.has(e.from)) {
      errors.push(`edges[${i}].from "${e.from}" is not a milestone key in this file`);
      ok = false;
    }
    if (!keyIndex.has(e.to)) {
      errors.push(`edges[${i}].to "${e.to}" is not a milestone key in this file`);
      ok = false;
    }
    if (e.from === e.to) {
      errors.push(`edges[${i}] goes from "${e.from}" to itself`);
      ok = false;
    }
    const pair = `${e.from}\u0000${e.to}`;
    const first = pairs.get(pair);
    if (first !== undefined) {
      errors.push(`edges[${i}] repeats edges[${first}] ("${e.from}" → "${e.to}")`);
      ok = false;
    } else {
      pairs.set(pair, i);
    }
    if (ok) validEdges.push(e);
  });

  const loop = loopKeys([...keyIndex.keys()], validEdges);
  if (loop.length > 0) {
    const shown = loop.slice(0, 10).map((k) => `"${k}"`).join(", ");
    errors.push(`edges form a loop through ${shown}${loop.length > 10 ? ` and ${loop.length - 10} more` : ""}`);
  }

  if (file.projectFields) {
    const fieldKeys = new Map<string, number>();
    const systemKeys = new Map<string, number>();
    file.projectFields.forEach((f, i) => {
      const path = `projectFields[${i}]`;
      const first = fieldKeys.get(f.key);
      if (first !== undefined) errors.push(`${path}.key "${f.key}" is used more than once (also projectFields[${first}])`);
      else fieldKeys.set(f.key, i);
      if (f.systemKey) {
        const firstSystem = systemKeys.get(f.systemKey);
        if (firstSystem !== undefined) {
          errors.push(`${path}.systemKey "${f.systemKey}" is used more than once (also projectFields[${firstSystem}])`);
        } else {
          systemKeys.set(f.systemKey, i);
        }
        if (!FIELD_TYPE_META[f.fieldType].hasChoices) {
          errors.push(`${path}.fieldType must be Dropdown or Multiple for the "${f.systemKey}" field`);
        }
      }
      if (f.fieldType === "FILE") errors.push(`${path}.fieldType File is not available for project fields`);
      checkChoices(f.choices, path, false, errors);
    });
  }

  return errors;
}

/**
 * Validates a template file (already JSON-parsed; a JSON string is also accepted).
 * Returns every problem found, in plain English with paths, e.g. 'milestones[12].choices[3].state must be one of …'.
 */
export function parseTemplateFile(json: unknown): ParseTemplateFileResult {
  let input = json;
  if (typeof input === "string") {
    try {
      input = JSON.parse(input);
    } catch {
      return { ok: false, errors: ["The file is not valid JSON."] };
    }
  }
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, errors: ["The file is not a Gunnebo PM template (expected a JSON object)."] };
  }
  const format = (input as Record<string, unknown>).format;
  if (format !== TEMPLATE_FILE_FORMAT) {
    return {
      ok: false,
      errors: [`The file is not a Gunnebo PM template: "format" must be "${TEMPLATE_FILE_FORMAT}".`],
    };
  }

  const parsed = fileSchema.safeParse(input);
  if (!parsed.success) {
    const messages = parsed.error.issues.map((issue) => describeIssue(issue, input));
    return { ok: false, errors: [...new Set(messages)] };
  }

  const file = parsed.data as TemplateFile;
  const errors = semanticErrors(file);
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, file };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

function copyChoice(c: Choice): Choice {
  const out: Choice = { id: c.id, label: c.label };
  if (c.state) out.state = c.state;
  if (c.archived) out.archived = true;
  return out;
}

function copyConfig(config: FieldConfig | undefined): FieldConfig | undefined {
  const unit = config?.unit?.trim();
  return unit ? { unit } : undefined;
}

const byOrder = <T extends { order: number }>(a: T, b: T) => a.order - b.order;

/**
 * The template as a file. Includes archived choices; leaves out archived milestones, archived arrows, arrows to
 * archived milestones and archived project fields.
 */
export function exportTemplateFile(template: Template, projectFields: ProjectField[], exportedAt: Iso): TemplateFile {
  const active = template.milestones
    .filter((m) => !m.archived)
    .sort((a, b) => byOrder(a, b) || a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
  const keyById = new Map(active.map((m) => [m.id, m.key]));

  const milestones = active.map((m) => {
    const out: TemplateFileMilestone = {
      key: m.key,
      name: m.name,
      fieldType: m.fieldType,
      order: m.order,
      choices: (m.choices ?? []).map(copyChoice),
    };
    if (m.description) out.description = m.description;
    const config = copyConfig(m.config);
    if (config) out.config = config;
    const pos = template.flow?.nodes?.[m.id];
    if (pos) out.position = { x: pos.x, y: pos.y };
    return out;
  });

  const seen = new Set<string>();
  const edges: { from: string; to: string }[] = [];
  for (const e of template.flow?.edges ?? []) {
    if (e.archivedAt) continue;
    const from = keyById.get(e.from);
    const to = keyById.get(e.to);
    if (!from || !to || from === to) continue;
    const pair = `${from}\u0000${to}`;
    if (seen.has(pair)) continue;
    seen.add(pair);
    edges.push({ from, to });
  }

  const fields = projectFields
    .filter((f) => !f.archived)
    .sort((a, b) => byOrder(a, b) || a.key.localeCompare(b.key))
    .map((f) => {
      const out: TemplateFileProjectField = {
        key: f.key,
        label: f.label,
        fieldType: f.fieldType,
        choices: (f.choices ?? []).map(copyChoice),
        order: f.order,
        showInSummary: f.showInSummary,
      };
      if (f.systemKey) out.systemKey = f.systemKey;
      const config = copyConfig(f.config);
      if (config) out.config = config;
      return out;
    });

  return {
    format: TEMPLATE_FILE_FORMAT,
    version: 1,
    exportedAt,
    templateRevision: template.revision,
    milestones,
    edges,
    projectFields: fields,
  };
}

/** Pretty JSON for downloads. */
export function templateFileToJson(file: TemplateFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}
