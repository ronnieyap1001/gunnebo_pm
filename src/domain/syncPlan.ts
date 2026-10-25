/**
 * Sync from template (DESIGN.md 4.7 as amended by section 12). Pure and cheap, so screens can compute
 * "n template changes pending" on every read.
 *
 * Matching: a step goes with the milestone whose id equals its milestoneId. A new milestone may instead link an
 * active project-only step with the same (normalised) name and a compatible type.
 *
 * Never touched: values (except a lossless conversion when a type change or link is applied; a value that is invalid
 * for its own type is data, never "empty"), the N/A switch and flags (except a selected markNA), positions of existing
 * nodes, notes and attachments, project-only steps (except a selected link) and arrows drawn in the project (except
 * silently linking a same-pair arrow to its template arrow, and never for a project-only step whose link isn't applied).
 *
 * Safe defaults: the ticked items never cut the project's flow apart. A splice removal stays ticked only while the
 * template's path between its ends can be built, and removals around a step the template removed stay ticked only
 * while every step before it still reaches every step after it (otherwise they, and the reconnection, are unticked).
 *
 * Item ids are '<kind>:<key>:<hash>' where the hash covers the planned change. A declined item is stored in
 * Project.syncDismissed as { '<kind>:<key>': '<hash>' } (see dismissKeyOf); it comes back checked when the change
 * itself changes.
 */
import { convertValue, type ConvertResult } from "./convertValue";
import { FIELD_TYPE_META } from "./fieldTypes";
import {
  archiveEdge,
  findActivePair,
  flowOrder,
  isActiveEdge,
  isReachable,
  isUserRemoved,
  predecessorsOf,
  wouldCreateCycle,
} from "./graph";
import { NODE_HEIGHT, NODE_WIDTH } from "./layout";
import { copyChoices, draftFromMilestone, remapFlow, type StepDraft } from "./snapshot";
import { deriveState, STATE_META } from "./state";
import type {
  Choice,
  DayContext,
  FieldConfig,
  FieldDef,
  FieldType,
  Flow,
  FlowEdge,
  Iso,
  Milestone,
  Position,
  State,
  Step,
  Template,
  Value,
} from "./types";
import { isEmptyValue, isValidValue } from "./values";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type SyncItemKind =
  | "addNode"
  | "linkExisting"
  | "updateDefinition"
  | "updateChoices"
  | "changeType"
  | "markNA"
  | "addEdge"
  | "removeEdge";

export interface SyncItem {
  id: string;
  kind: SyncItemKind;
  defaultChecked: boolean;
  selectable: boolean;
  title: string;
  detail: string;
  milestoneId?: string;
  stepId?: string;
  /** Project node ids; a node added by this plan is referred to by its milestone id (the draft's tempId). */
  edge?: { from: string; to: string };
  stateChange?: { from: State; to: State };
}

export interface SyncPlan {
  items: SyncItem[];
  warnings: string[];
}

export interface SyncProjectInput {
  steps: Step[];
  flow: Flow;
  /** Project.syncDismissed: '<kind>:<key>' -> change hash (a full item id as key is accepted too). */
  dismissed: Record<string, string>;
  /** Active attachments per step id (FILE state). */
  attachmentCounts?: Record<string, number>;
}

export interface SyncApplyResult {
  /** New steps; tempId = milestone id, and the flow uses that key until the caller remaps it. */
  newSteps: StepDraft[];
  stepPatches: { stepId: string; patch: Partial<Step> }[];
  flow: Flow;
  appliedItemIds: string[];
  summary: string[];
}

// ---------------------------------------------------------------------------
// Small helpers (exported where other layers need the same rule)
// ---------------------------------------------------------------------------

/** Canonical JSON: object keys sorted, undefined members dropped. */
export function stableStringify(v: unknown): string {
  if (v === undefined || v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map((x) => stableStringify(x)).join(",")}]`;
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

/** Short deterministic hash (FNV-1a 32-bit, base 36) of a planned change. */
export function changeHash(v: unknown): string {
  const s = stableStringify(v);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36).padStart(7, "0");
}

/** '<kind>:<key>' part of an item id: the key under which a declined item is stored in Project.syncDismissed. */
export function dismissKeyOf(itemId: string): string {
  const i = itemId.lastIndexOf(":");
  return i < 0 ? itemId : itemId.slice(0, i);
}

/** The change-hash part of an item id. */
export function changeHashOf(itemId: string): string {
  const i = itemId.lastIndexOf(":");
  return i < 0 ? "" : itemId.slice(i + 1);
}

/** Name normalisation for linking a project-only step to a new milestone. */
export function normalizeStepName(name: string): string {
  return String(name ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function normChoice(c: Choice): Choice {
  const out: Choice = { id: c.id, label: c.label };
  if (c.state !== undefined) out.state = c.state;
  if (c.archived) out.archived = true;
  return out;
}

/**
 * Merge a project's (or library's) choice list with the template's (or file's), by id: the template's choices in
 * template order with the template's label, state and archived flag, then every other existing choice appended
 * with archived: true. Choices are never removed, so a value on a retired choice keeps its label and tag.
 */
export function mergeChoicesById(source: Choice[], existing: Choice[]): Choice[] {
  const out = (source ?? []).map(normChoice);
  const ids = new Set(out.map((c) => c.id));
  for (const c of existing ?? []) {
    if (ids.has(c.id)) continue;
    ids.add(c.id);
    out.push({ ...normChoice(c), archived: true });
  }
  return out;
}

export function choicesEqual(a: Choice[], b: Choice[]): boolean {
  return stableStringify((a ?? []).map(normChoice)) === stableStringify((b ?? []).map(normChoice));
}

function configEqual(a: FieldConfig | undefined, b: FieldConfig | undefined): boolean {
  return stableStringify(a ?? {}) === stableStringify(b ?? {});
}

function valueEqual(a: Value | null | undefined, b: Value | null | undefined): boolean {
  return stableStringify(a ?? null) === stableStringify(b ?? null);
}

const hasChoices = (t: FieldType) => FIELD_TYPE_META[t]?.hasChoices ?? false;

/** True when the step's value is genuinely empty (a value that is invalid for its type is NOT empty: it is data). */
function isEmptyStepValue(t: FieldType, v: Value | null | undefined): boolean {
  if (v === null || v === undefined) return true;
  return isValidValue(t, v) && isEmptyValue(t, v);
}

/**
 * Lossless conversion for sync, which must never clear a value. An empty value converts to null. A value that is not
 * valid for its current type (e.g. written under an earlier type) is kept unchanged when the new type accepts it as
 * is, and otherwise blocks the change.
 */
function convertForSync(from: FieldType, to: FieldType, value: Value | null, toChoices?: Choice[]): ConvertResult {
  if (value === null || value === undefined) return { ok: true, value: null };
  if (from !== "FILE" && from !== to && !isValidValue(from, value)) {
    const ids =
      to === "DROPDOWN"
        ? [(value as { choiceId?: string }).choiceId]
        : to === "MULTIPLE"
          ? ((value as { choiceIds?: string[] }).choiceIds ?? [])
          : [];
    const idsKnown = !toChoices || ids.every((id) => toChoices.some((c) => c.id === id));
    if (to !== "FILE" && isValidValue(to, value) && !isEmptyValue(to, value) && idsKnown) return { ok: true, value };
    return { ok: false, reason: `The current value is not a valid ${typeLabel(from)} value.` };
  }
  return convertValue(from, to, value, toChoices);
}
const typeLabel = (t: FieldType) => FIELD_TYPE_META[t]?.label ?? t;
const stateLabel = (s: State | undefined) => (s ? STATE_META[s].label : "no state");

/** Plain-English list of what changed between two choice lists, e.g. 'Renamed "A" → "B"; retired "C".' */
export function describeChoiceChanges(before: Choice[], after: Choice[]): string {
  const old = new Map(before.map((c) => [c.id, c]));
  const parts: string[] = [];
  for (const c of after) {
    const o = old.get(c.id);
    if (!o) {
      parts.push(`added "${c.label}"`);
      continue;
    }
    if (o.label !== c.label) parts.push(`renamed "${o.label}" → "${c.label}"`);
    if (o.state !== c.state) parts.push(`retagged "${c.label}" ${stateLabel(o.state)} → ${stateLabel(c.state)}`);
    if (!o.archived && c.archived) parts.push(`retired "${c.label}"`);
    if (o.archived && !c.archived) parts.push(`brought back "${c.label}"`);
  }
  if (parts.length === 0) parts.push("choices reordered");
  const text = parts.join("; ");
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

function describeConfigChange(before: FieldConfig | undefined, after: FieldConfig | undefined): string {
  const a = before?.unit ?? "";
  const b = after?.unit ?? "";
  if (a !== b) return a && b ? `Unit: "${a}" → "${b}"` : b ? `Unit: now "${b}"` : `Unit "${a}" removed`;
  return "Settings updated";
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

type Action =
  | { kind: "addNode"; milestone: Milestone }
  | { kind: "linkExisting"; milestone: Milestone; step: Step; patch: Partial<Step> }
  | { kind: "updateDefinition"; step: Step; patch: Partial<Step> }
  | { kind: "updateChoices"; step: Step; patch: Partial<Step> }
  | { kind: "changeType"; step: Step; patch: Partial<Step> | null }
  | { kind: "markNA"; step: Step }
  | { kind: "addEdge"; templateEdgeId: string; from: string; to: string; restoreId?: string }
  /** spliceVia: the arrow is replaced by a template path through these new milestones (added or linked by this plan). */
  | { kind: "removeEdge"; edgeId: string; spliceVia?: string[] };

interface BuiltPlan extends SyncPlan {
  actions: Map<string, Action>;
  silentPatches: Map<string, Partial<Step>>;
  silentLinks: { edgeId: string; templateEdgeId: string }[];
  mapping: Map<string, string>;
  templateEdges: FlowEdge[];
  activeStepIds: Set<string>;
}

const pairKey = (a: string, b: string) => `${a}\u0000${b}`;

function buildPlan(template: Template, project: SyncProjectInput, ctx: DayContext): BuiltPlan {
  const dismissed = project.dismissed ?? {};
  const counts = project.attachmentCounts ?? {};
  const actions = new Map<string, Action>();
  const warnings: string[] = [];
  const silentPatches = new Map<string, Partial<Step>>();
  const silentLinks: { edgeId: string; templateEdgeId: string }[] = [];

  const nodeItems: SyncItem[] = [];
  const defItems: SyncItem[] = [];
  const addEdgeItems: SyncItem[] = [];
  const removeEdgeItems: SyncItem[] = [];
  const markItems: SyncItem[] = [];

  const makeItem = (
    kind: SyncItemKind,
    key: string,
    hashInput: unknown,
    fields: Omit<SyncItem, "id" | "kind">,
    action: Action,
  ): SyncItem => {
    const hash = changeHash(hashInput);
    const base = `${kind}:${key}`;
    const id = `${base}:${hash}`;
    const isDismissed = dismissed[base] === hash || Object.prototype.hasOwnProperty.call(dismissed, id);
    const item: SyncItem = { id, kind, ...fields };
    item.defaultChecked = fields.defaultChecked && fields.selectable && !isDismissed;
    if (!item.stateChange) delete item.stateChange;
    actions.set(id, action);
    return item;
  };

  // --- Template side -------------------------------------------------------
  const msById = new Map(template.milestones.map((m) => [m.id, m]));
  const activeMs = template.milestones.filter((m) => !m.archived);
  const activeMsIds = new Set(activeMs.map((m) => m.id));
  const templateEdgeActive = (e: FlowEdge | undefined) =>
    !!e && isActiveEdge(e) && e.from !== e.to && activeMsIds.has(e.from) && activeMsIds.has(e.to);
  const templateEdges: FlowEdge[] = [];
  {
    const seen = new Set<string>();
    for (const e of template.flow.edges) {
      if (!templateEdgeActive(e) || seen.has(pairKey(e.from, e.to))) continue;
      seen.add(pairKey(e.from, e.to));
      templateEdges.push(e);
    }
  }
  const tEdgeById = new Map(template.flow.edges.map((e) => [e.id, e]));
  const tOrder = flowOrder(
    activeMs.map((m) => ({ id: m.id, order: m.order, name: m.name })),
    templateEdges,
  );
  const tIndex = new Map(tOrder.map((id, i) => [id, i]));

  // --- Project side --------------------------------------------------------
  const steps = project.steps
    .filter((s) => !s.archived)
    .sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const stepById = new Map(steps.map((s) => [s.id, s]));
  const stepByMilestone = new Map<string, Step>();
  for (const s of steps) if (s.milestoneId && !stepByMilestone.has(s.milestoneId)) stepByMilestone.set(s.milestoneId, s);
  const removedStepIds = new Set(steps.filter((s) => s.milestoneId && !activeMsIds.has(s.milestoneId)).map((s) => s.id));
  const pEdges = project.flow.edges;
  const pActive = pEdges.filter(isActiveEdge);

  const stateOf = (def: FieldDef, s: Step, value: Value | null = s.value): State =>
    deriveState(
      def,
      {
        value,
        notApplicable: s.notApplicable,
        flag: s.flag,
        valueSetAt: s.valueSetAt,
        attachmentCount: counts[s.id] ?? 0,
      },
      ctx,
    ).state;
  const change = (from: State, to: State) => (from !== to ? { from, to } : undefined);

  const mapping = new Map<string, string>(); // milestone id -> project node id (step id, or milestone id for a new node)
  const newMs = new Set<string>(); // milestones added or linked by this plan
  const newMsChecked = new Set<string>(); // ... whose item is checked by default
  const linkedSteps = new Set<string>();
  const nodeName = (nodeId: string) => stepById.get(nodeId)?.name ?? msById.get(nodeId)?.name ?? nodeId;

  /** The definition a step would get when linked to milestone m, or null when the value can't be kept. */
  const adoptPatch = (m: Milestone, s: Step): Partial<Step> | null => {
    const choices = hasChoices(m.fieldType) ? mergeChoicesById(m.choices, s.choices) : copyChoices(s.choices ?? []);
    let value: Value | null = s.value;
    if (s.fieldType !== m.fieldType) {
      const r = convertForSync(s.fieldType, m.fieldType, s.value, hasChoices(m.fieldType) ? choices : undefined);
      if (!r.ok) return null;
      value = r.value;
    }
    const patch: Partial<Step> = {
      milestoneId: m.id,
      milestoneKey: m.key,
      name: m.name,
      description: m.description ?? "",
      config: { ...(m.config ?? {}) },
      order: m.order,
      fieldType: m.fieldType,
      choices,
    };
    if (!valueEqual(value, s.value)) patch.value = value;
    return patch;
  };

  const planDefinition = (m: Milestone, n: Step) => {
    const silent: Partial<Step> = {};
    if (n.order !== m.order) silent.order = m.order;
    if (!configEqual(n.config, m.config)) silent.config = { ...(m.config ?? {}) };
    if (n.milestoneKey !== m.key) silent.milestoneKey = m.key;
    if (Object.keys(silent).length) silentPatches.set(n.id, silent);

    const nameDiff = n.name !== m.name;
    const descDiff = (n.description ?? "") !== (m.description ?? "");
    const cfgDiff = !configEqual(n.config, m.config);
    if (nameDiff || descDiff || cfgDiff) {
      const parts: string[] = [];
      if (nameDiff) parts.push(`Name: "${n.name}" → "${m.name}"`);
      if (descDiff) parts.push("Description updated");
      if (cfgDiff) parts.push(describeConfigChange(n.config, m.config));
      const target = { name: m.name, description: m.description ?? "", config: m.config ?? {} };
      defItems.push(
        makeItem(
          "updateDefinition",
          m.id,
          target,
          {
            defaultChecked: true,
            selectable: true,
            title: `Update "${n.name}"`,
            detail: `${parts.join("; ")}.`,
            milestoneId: m.id,
            stepId: n.id,
          },
          { kind: "updateDefinition", step: n, patch: { ...target, config: { ...target.config } } },
        ),
      );
    }

    const oldDef: FieldDef = { fieldType: n.fieldType, choices: n.choices ?? [], config: n.config ?? {} };
    if (n.fieldType === m.fieldType) {
      if (!hasChoices(m.fieldType)) return;
      const merged = mergeChoicesById(m.choices, n.choices);
      if (choicesEqual(merged, n.choices)) return;
      defItems.push(
        makeItem(
          "updateChoices",
          m.id,
          merged,
          {
            defaultChecked: true,
            selectable: true,
            title: `Update choices of "${n.name}"`,
            detail: describeChoiceChanges(n.choices ?? [], merged),
            milestoneId: m.id,
            stepId: n.id,
            stateChange: change(stateOf(oldDef, n), stateOf({ ...oldDef, choices: merged }, n)),
          },
          { kind: "updateChoices", step: n, patch: { choices: merged } },
        ),
      );
      return;
    }

    // Field type differs.
    const choices = hasChoices(m.fieldType) ? mergeChoicesById(m.choices, n.choices) : (n.choices ?? []);
    const empty = isEmptyStepValue(n.fieldType, n.value);
    const conv = convertForSync(n.fieldType, m.fieldType, n.value, hasChoices(m.fieldType) ? choices : undefined);
    const a = typeLabel(n.fieldType);
    const b = typeLabel(m.fieldType);
    if (conv.ok) {
      const patch: Partial<Step> = { fieldType: m.fieldType };
      if (!choicesEqual(choices, n.choices ?? [])) patch.choices = choices;
      if (!valueEqual(conv.value, n.value)) patch.value = conv.value;
      const newDef: FieldDef = { fieldType: m.fieldType, choices, config: n.config ?? {} };
      // The choice list rides along with the type change, so it is part of the change a decline refers to.
      const hashInput = patch.choices
        ? { from: n.fieldType, to: m.fieldType, choices }
        : { from: n.fieldType, to: m.fieldType };
      defItems.push(
        makeItem(
          "changeType",
          m.id,
          hashInput,
          {
            defaultChecked: true,
            selectable: true,
            title: `Change "${n.name}" to ${b}`,
            detail: empty
              ? `The template changed the field type from ${a} to ${b}. The step has no value yet.`
              : `The template changed the field type from ${a} to ${b}. The current value is kept.`,
            milestoneId: m.id,
            stepId: n.id,
            stateChange: change(stateOf(oldDef, n), stateOf(newDef, n, conv.value)),
          },
          { kind: "changeType", step: n, patch },
        ),
      );
    } else {
      defItems.push(
        makeItem(
          "changeType",
          m.id,
          { from: n.fieldType, to: m.fieldType },
          {
            defaultChecked: false,
            selectable: false,
            title: `"${n.name}" type differs from the template`,
            detail:
              `The template now uses ${b}, but the current value can't be converted: ${conv.reason} ` +
              `The step keeps ${a} and its value. The change is offered again once the value is empty.`,
            milestoneId: m.id,
            stepId: n.id,
          },
          { kind: "changeType", step: n, patch: null },
        ),
      );
      warnings.push(
        `"${n.name}" keeps its ${a} type because its value can't be converted to ${b}. Clear the value to adopt the template's type.`,
      );
      // While the type change waits, the template's choice edits still reach a step whose type has choices.
      if (hasChoices(n.fieldType) && !choicesEqual(choices, n.choices ?? [])) {
        defItems.push(
          makeItem(
            "updateChoices",
            m.id,
            choices,
            {
              defaultChecked: true,
              selectable: true,
              title: `Update choices of "${n.name}"`,
              detail: describeChoiceChanges(n.choices ?? [], choices),
              milestoneId: m.id,
              stepId: n.id,
              stateChange: change(stateOf(oldDef, n), stateOf({ ...oldDef, choices }, n)),
            },
            { kind: "updateChoices", step: n, patch: { choices } },
          ),
        );
      }
    }
  };

  // --- 1. Nodes and definitions, in template flow order --------------------
  for (const mid of tOrder) {
    const m = msById.get(mid)!;
    const existing = stepByMilestone.get(mid);
    if (existing) {
      mapping.set(mid, existing.id);
      planDefinition(m, existing);
      continue;
    }
    const target = normalizeStepName(m.name);
    let link: { step: Step; patch: Partial<Step> } | undefined;
    for (const s of steps) {
      if (s.milestoneId || linkedSteps.has(s.id) || normalizeStepName(s.name) !== target) continue;
      const patch = adoptPatch(m, s);
      if (patch) {
        link = { step: s, patch };
        break;
      }
    }
    newMs.add(mid);
    if (link) {
      const s = link.step;
      linkedSteps.add(s.id);
      mapping.set(mid, s.id);
      const oldDef: FieldDef = { fieldType: s.fieldType, choices: s.choices ?? [], config: s.config ?? {} };
      const newDef: FieldDef = {
        fieldType: link.patch.fieldType ?? s.fieldType,
        choices: link.patch.choices ?? s.choices ?? [],
        config: link.patch.config ?? s.config ?? {},
      };
      const newValue = "value" in link.patch ? (link.patch.value ?? null) : s.value;
      const item = makeItem(
        "linkExisting",
        mid,
        { step: s.id, milestone: mid },
        {
          defaultChecked: true,
          selectable: true,
          title: `Link "${s.name}" to the template`,
          detail: `Your project-only step "${s.name}" matches the new milestone "${m.name}". It is linked instead of adding a second copy, and keeps its value, notes and history.`,
          milestoneId: mid,
          stepId: s.id,
          stateChange: change(stateOf(oldDef, s), stateOf(newDef, s, newValue)),
        },
        { kind: "linkExisting", milestone: m, step: s, patch: link.patch },
      );
      nodeItems.push(item);
      if (item.defaultChecked) newMsChecked.add(mid);
    } else {
      mapping.set(mid, mid);
      const item = makeItem(
        "addNode",
        mid,
        { name: m.name, fieldType: m.fieldType },
        {
          defaultChecked: true,
          selectable: true,
          title: `Add "${m.name}"`,
          detail: `New milestone in the template (${typeLabel(m.fieldType)}). It starts empty.`,
          milestoneId: mid,
        },
        { kind: "addNode", milestone: m },
      );
      nodeItems.push(item);
      if (item.defaultChecked) newMsChecked.add(mid);
    }
  }

  // --- 2. Steps whose milestone left the template --------------------------
  for (const s of steps) {
    if (!removedStepIds.has(s.id) || s.notApplicable) continue;
    const m = s.milestoneId ? msById.get(s.milestoneId) : undefined;
    const def: FieldDef = { fieldType: s.fieldType, choices: s.choices ?? [], config: s.config ?? {} };
    markItems.push(
      makeItem(
        "markNA",
        s.id,
        { milestone: s.milestoneId },
        {
          defaultChecked: false,
          selectable: true,
          title: `Mark "${s.name}" not applicable`,
          detail: `${m ? `"${m.name}" was archived in the template.` : "This milestone is no longer in the template."} The step and its value stay; marking it not applicable leaves it out of progress.`,
          milestoneId: s.milestoneId,
          stepId: s.id,
          stateChange: change(stateOf(def, s), "NOT_APPLICABLE"),
        },
        { kind: "markNA", step: s },
      ),
    );
  }

  // --- 3. Arrows -------------------------------------------------------------
  const tIdx = (id: string) => tIndex.get(id) ?? Number.MAX_SAFE_INTEGER;
  const sortedTemplateEdges = [...templateEdges].sort((x, y) => tIdx(x.from) - tIdx(y.from) || tIdx(x.to) - tIdx(y.to));
  const mappedTemplatePairs = new Set<string>();
  for (const e of sortedTemplateEdges) {
    const pa = mapping.get(e.from);
    const pb = mapping.get(e.to);
    if (pa && pb) mappedTemplatePairs.add(pairKey(pa, pb));
  }

  /** Template path a -> ... -> b (at least one step in between) through milestones in `via` only. */
  const templatePathVia = (a: string, b: string, via: Set<string>): string[] | null => {
    const parent = new Map<string, string>();
    const queue: string[] = [];
    for (const s of nextOf(templateEdges, a)) {
      if (via.has(s) && !parent.has(s)) {
        parent.set(s, a);
        queue.push(s);
      }
    }
    while (queue.length) {
      const n = queue.shift() as string;
      for (const s of nextOf(templateEdges, n)) {
        if (s === b) {
          const path: string[] = [];
          for (let p: string | undefined = n; p && p !== a; p = parent.get(p)) path.unshift(p);
          return path;
        }
        if (via.has(s) && !parent.has(s)) {
          parent.set(s, n);
          queue.push(s);
        }
      }
    }
    return null;
  };

  /** A removed step r with an active project path pa -> r ... -> pb through removed steps only. */
  const bypassedStep = (pa: string, pb: string): string | null => {
    const succ = (id: string) => pActive.filter((e) => e.from === id).map((e) => e.to);
    const start = succ(pa).filter((id) => removedStepIds.has(id));
    const firstOf = new Map<string, string>(start.map((id) => [id, id]));
    const queue = [...start];
    while (queue.length) {
      const r = queue.shift() as string;
      for (const s of succ(r)) {
        if (s === pb) return firstOf.get(r)!;
        if (removedStepIds.has(s) && !firstOf.has(s)) {
          firstOf.set(s, firstOf.get(r)!);
          queue.push(s);
        }
      }
    }
    return null;
  };

  const removals: { item: SyncItem; edgeId: string; from: string; to: string; endOnly: boolean; splice: boolean }[] = [];
  const additions: { item: SyncItem; from: string; to: string; bypass: boolean }[] = [];

  // 3a. Removals: active project arrows copied from a template arrow that is no longer active.
  for (const p of pActive) {
    if (!p.templateEdgeId) continue;
    if (templateEdgeActive(tEdgeById.get(p.templateEdgeId))) continue;
    if (mappedTemplatePairs.has(pairKey(p.from, p.to))) continue; // still in the template as another arrow
    const sa = stepById.get(p.from);
    const sb = stepById.get(p.to);
    const ma = sa?.milestoneId;
    const mb = sb?.milestoneId;
    const linkedPair = !!ma && !!mb && mapping.get(ma) === p.from && mapping.get(mb) === p.to;
    const checkedSplice = linkedPair ? templatePathVia(ma!, mb!, newMsChecked) : null;
    const anySplice = checkedSplice ?? (linkedPair ? templatePathVia(ma!, mb!, newMs) : null);
    const removedEnd = [p.from, p.to].find((id) => removedStepIds.has(id));
    let detail: string;
    if (anySplice) detail = `The template inserted ${anySplice.map((id) => `"${msById.get(id)?.name ?? id}"`).join(" and ")} between them.`;
    else if (removedEnd) detail = `"${nodeName(removedEnd)}" was removed from the template.`;
    else detail = "The template removed this arrow.";
    const item = makeItem(
      "removeEdge",
      p.id,
      { edge: p.id, templateEdgeId: p.templateEdgeId },
      {
        defaultChecked: !!checkedSplice || !!removedEnd,
        selectable: true,
        title: `Remove arrow "${nodeName(p.from)}" → "${nodeName(p.to)}"`,
        detail: `${detail} The arrow is archived, not deleted.`,
        edge: { from: p.from, to: p.to },
      },
      anySplice ? { kind: "removeEdge", edgeId: p.id, spliceVia: anySplice } : { kind: "removeEdge", edgeId: p.id },
    );
    removeEdgeItems.push(item);
    removals.push({
      item,
      edgeId: p.id,
      from: p.from,
      to: p.to,
      endOnly: !checkedSplice && !!removedEnd,
      splice: !!checkedSplice,
    });
  }

  // 3b. Additions, checked for loops against the projected graph.
  const removalIds = new Set(removeEdgeItems.map((i) => (actions.get(i.id) as { edgeId: string }).edgeId));
  const checkedRemovalIds = new Set(
    removeEdgeItems.filter((i) => i.defaultChecked).map((i) => (actions.get(i.id) as { edgeId: string }).edgeId),
  );
  const projectedAll: FlowEdge[] = pActive.filter((e) => !removalIds.has(e.id));
  const projectedDefault: FlowEdge[] = pActive.filter((e) => !checkedRemovalIds.has(e.id));

  for (const e of sortedTemplateEdges) {
    const pa = mapping.get(e.from);
    const pb = mapping.get(e.to);
    if (!pa || !pb || pa === pb) continue;

    const activePair = findActivePair(pActive, pa, pb);
    if (activePair) {
      // Same arrow already in the project: link it silently when it isn't linked to a live template arrow.
      if (activePair.templateEdgeId !== e.id) {
        const linkedToLive = templateEdgeActive(
          activePair.templateEdgeId ? tEdgeById.get(activePair.templateEdgeId) : undefined,
        );
        const taken = pActive.some((x) => x !== activePair && x.templateEdgeId === e.id);
        if (!linkedToLive && !taken) silentLinks.push({ edgeId: activePair.id, templateEdgeId: e.id });
      }
      continue;
    }

    const samePair = pEdges.filter((x) => !isActiveEdge(x) && x.from === pa && x.to === pb);
    if (samePair.some(isUserRemoved)) continue; // removed by you: never re-added
    const restore =
      samePair.find((x) => x.templateEdgeId === e.id) ?? samePair.find((x) => x.templateEdgeId) ?? samePair[0];

    const a = nodeName(pa);
    const b = nodeName(pb);
    if (wouldCreateCycle(projectedAll, pa, pb)) {
      warnings.push(`Arrow "${a}" → "${b}" skipped: it would create a loop.`);
      continue;
    }

    const newEnd = [e.from, e.to].find((id) => newMs.has(id));
    const endsReady = [e.from, e.to].every((id) => !newMs.has(id) || newMsChecked.has(id));
    const bypass = newEnd ? null : bypassedStep(pa, pb);
    let checked = (!!newEnd || !!bypass) && endsReady;
    let detail: string;
    if (newEnd) detail = `Connects the new milestone "${msById.get(newEnd)?.name ?? newEnd}".`;
    else if (bypass) detail = `Reconnects around "${nodeName(bypass)}", which the template removed.`;
    else if (restore) detail = "The template has this arrow again. Your project may be routed differently on purpose.";
    else detail = "The template re-routed this arrow. Your project may be routed differently on purpose.";
    if (checked && wouldCreateCycle(projectedDefault, pa, pb)) {
      checked = false;
      detail += " It is only possible together with an arrow removal in this list.";
    }

    const item = makeItem(
      "addEdge",
      e.id,
      { from: e.from, to: e.to },
      {
        defaultChecked: checked,
        selectable: true,
        title: `Add arrow "${a}" → "${b}"`,
        detail,
        edge: { from: pa, to: pb },
      },
      { kind: "addEdge", templateEdgeId: e.id, from: pa, to: pb, restoreId: restore?.id },
    );
    addEdgeItems.push(item);
    additions.push({ item, from: pa, to: pb, bypass: !!bypass });
    const virtual: FlowEdge = { id: `plan:${e.id}`, from: pa, to: pb, createdAt: "" };
    projectedAll.push(virtual);
    if (item.defaultChecked) projectedDefault.push(virtual);
  }

  // 3c. The default selection must not cut the flow apart around a step the template removed: every node that led
  // into it (through removed steps only) must still reach every node it led to. Otherwise its arrow removals (and the
  // reconnection around it) are left unticked, for the user to decide. Unticking only ever adds arrows back, so loops
  // are re-checked and the pass repeats until nothing changes.
  const regionEnds = (r: string, forward: boolean): string[] => {
    const out: string[] = [];
    const seen = new Set<string>([r]);
    const queue = [r];
    while (queue.length) {
      const n = queue.shift() as string;
      for (const e of pActive) {
        const [here, next] = forward ? [e.from, e.to] : [e.to, e.from];
        if (here !== n || seen.has(next)) continue;
        seen.add(next);
        if (removedStepIds.has(next)) queue.push(next);
        else out.push(next);
      }
    }
    return out;
  };
  for (let changed = true; changed; ) {
    changed = false;
    const g: FlowEdge[] = pActive.filter((e) => !removals.some((x) => x.item.defaultChecked && x.edgeId === e.id));
    for (const a of additions) {
      if (!a.item.defaultChecked) continue;
      if (wouldCreateCycle(g, a.from, a.to)) {
        a.item.defaultChecked = false;
        a.item.detail += " It is only possible together with an arrow removal in this list.";
        continue;
      }
      g.push({ id: `plan:${a.item.id}`, from: a.from, to: a.to, createdAt: "" });
    }
    // A splice removal is ticked only while the template's path between its ends can actually be built here.
    for (const x of removals) {
      if (!x.splice || !x.item.defaultChecked || isReachable(g, x.from, x.to)) continue;
      x.item.defaultChecked = false;
      x.item.detail +=
        ` Not ticked: the template's path between "${nodeName(x.from)}" and "${nodeName(x.to)}" can't be built in` +
        " this project, so removing it would cut them apart.";
      changed = true;
    }
    for (const r of removedStepIds) {
      const touching = removals.filter((x) => x.endOnly && x.item.defaultChecked && (x.from === r || x.to === r));
      if (touching.length === 0) continue;
      const ins = regionEnds(r, false);
      const outs = regionEnds(r, true);
      let cut: [string, string] | undefined;
      for (const u of ins) {
        const w = outs.find((o) => !isReachable(g, u, o));
        if (w) {
          cut = [u, w];
          break;
        }
      }
      if (!cut) continue;
      const note = ` Not ticked: removing it would cut "${nodeName(cut[0])}" off from "${nodeName(cut[1])}".`;
      for (const x of touching) {
        x.item.defaultChecked = false;
        x.item.detail += note;
      }
      for (const a of additions) {
        if (a.bypass && a.item.defaultChecked && ins.includes(a.from) && outs.includes(a.to)) {
          a.item.defaultChecked = false;
          a.item.detail += ` Not ticked because the arrows of "${nodeName(r)}" stay.`;
        }
      }
      changed = true;
    }
  }

  return {
    items: [...nodeItems, ...defItems, ...addEdgeItems, ...removeEdgeItems, ...markItems],
    warnings,
    actions,
    silentPatches,
    silentLinks,
    mapping,
    templateEdges,
    activeStepIds: new Set(steps.map((s) => s.id)),
  };
}

/** Successors in an edge list that is already active-only (template BFS above). */
function nextOf(edges: FlowEdge[], id: string): string[] {
  const out: string[] = [];
  for (const e of edges) if (e.from === id && !out.includes(e.to)) out.push(e.to);
  return out;
}

export function planSync(template: Template, project: SyncProjectInput, ctx: DayContext): SyncPlan {
  const { items, warnings } = buildPlan(template, project, ctx);
  return { items, warnings };
}

// ---------------------------------------------------------------------------
// Applying
// ---------------------------------------------------------------------------

/**
 * Re-plan from the given state and apply the selected items: nodes, then definitions / choices / types, then arrow
 * removals, then arrow additions (loops re-checked one by one), then N/A marks. Order, config and milestone key of
 * template-derived steps are always refreshed silently. A selected id that is not (or no longer selectable) in the
 * fresh plan aborts with STALE_PLAN. A selected splice removal whose new step was not added is skipped ("Kept arrow").
 */
export function applySync(
  template: Template,
  project: SyncProjectInput,
  selectedIds: string[],
  ctx: DayContext,
  now: Iso,
  idFactory: () => string,
): { ok: true; result: SyncApplyResult } | { ok: false; reason: "STALE_PLAN"; missingIds: string[] } {
  const plan = buildPlan(template, project, ctx);
  const byId = new Map(plan.items.map((i) => [i.id, i]));
  const missingIds = [...new Set(selectedIds)].filter((id) => !byId.get(id)?.selectable);
  if (missingIds.length) return { ok: false, reason: "STALE_PLAN", missingIds };

  const selected = new Set(selectedIds);
  const chosen = plan.items.filter((i) => selected.has(i.id));
  const of = <K extends SyncItemKind>(...kinds: K[]) => chosen.filter((i) => (kinds as SyncItemKind[]).includes(i.kind));

  const patches = new Map<string, Partial<Step>>();
  const addPatch = (stepId: string, patch: Partial<Step>) =>
    patches.set(stepId, { ...(patches.get(stepId) ?? {}), ...patch });
  for (const [stepId, patch] of plan.silentPatches) addPatch(stepId, patch);

  let flow: Flow = { nodes: { ...project.flow.nodes }, edges: [...project.flow.edges] };
  const newSteps: StepDraft[] = [];
  const appliedItemIds: string[] = [];
  const summary: string[] = [];
  // A project-only step offered as a link only takes template arrows when the link itself is applied.
  const unlinked = new Set(
    plan.items
      .filter((i) => i.kind === "linkExisting" && !selected.has(i.id) && i.stepId)
      .map((i) => i.stepId as string),
  );
  const existingNode = (id: string) =>
    (plan.activeStepIds.has(id) && !unlinked.has(id)) || newSteps.some((d) => d.tempId === id);
  const nameOf = (id: string) =>
    project.steps.find((s) => s.id === id)?.name ?? template.milestones.find((m) => m.id === id)?.name ?? id;

  // 1. Nodes.
  for (const item of of("addNode", "linkExisting")) {
    const action = plan.actions.get(item.id)!;
    if (action.kind === "addNode") {
      const m = action.milestone;
      flow.nodes[m.id] = placeNewNode(m.id, plan, template, flow, newSteps);
      newSteps.push(draftFromMilestone(m));
      summary.push(`Added "${m.name}".`);
    } else if (action.kind === "linkExisting") {
      addPatch(action.step.id, action.patch);
      summary.push(`Linked "${action.step.name}" to the template milestone "${action.milestone.name}".`);
    }
    appliedItemIds.push(item.id);
  }

  // 2. Definitions, choices, types.
  for (const item of of("updateDefinition", "updateChoices", "changeType")) {
    const action = plan.actions.get(item.id)!;
    if (action.kind === "updateDefinition" || action.kind === "updateChoices" || action.kind === "changeType") {
      if (!action.patch) continue;
      addPatch(action.step.id, action.patch);
      summary.push(
        action.kind === "updateDefinition"
          ? `Updated "${action.step.name}".`
          : action.kind === "updateChoices"
            ? `Updated the choices of "${action.step.name}".`
            : `Changed "${action.step.name}" to ${typeLabel(action.patch.fieldType ?? action.step.fieldType)}.`,
      );
      appliedItemIds.push(item.id);
    }
  }

  // 3. Arrow removals (first, so a re-route that depends on them is not refused as a loop).
  for (const item of of("removeEdge")) {
    const action = plan.actions.get(item.id)!;
    if (action.kind !== "removeEdge") continue;
    const e = flow.edges.find((x) => x.id === action.edgeId);
    // A splice removal replaces a -> b by the template's path through new steps: without those steps (not selected)
    // the old arrow stays, so a and b are not left disconnected.
    const notAdded = (action.spliceVia ?? []).find((mid) => !existingNode(plan.mapping.get(mid) ?? mid));
    if (e && notAdded) {
      summary.push(`Kept arrow "${nameOf(e.from)}" → "${nameOf(e.to)}": "${nameOf(notAdded)}" was not added.`);
      continue;
    }
    const before = flow;
    flow = archiveEdge(flow, action.edgeId, now, "SYNC");
    if (flow !== before && e) {
      summary.push(`Removed arrow "${nameOf(e.from)}" → "${nameOf(e.to)}".`);
      appliedItemIds.push(item.id);
    }
  }

  // 4. Arrow additions.
  for (const item of of("addEdge")) {
    const action = plan.actions.get(item.id)!;
    if (action.kind !== "addEdge") continue;
    const { from, to, templateEdgeId } = action;
    const label = `"${nameOf(from)}" → "${nameOf(to)}"`;
    if (!existingNode(from) || !existingNode(to)) {
      const missing = !existingNode(from) ? from : to;
      summary.push(`Skipped arrow ${label}: "${nameOf(missing)}" was not ${unlinked.has(missing) ? "linked" : "added"}.`);
      continue;
    }
    if (findActivePair(flow.edges, from, to)) {
      appliedItemIds.push(item.id);
      continue;
    }
    if (wouldCreateCycle(flow.edges, from, to)) {
      summary.push(`Skipped arrow ${label}: it would create a loop.`);
      continue;
    }
    const restore = action.restoreId
      ? flow.edges.find((x) => x.id === action.restoreId && !isActiveEdge(x) && x.from === from && x.to === to)
      : undefined;
    if (restore) {
      const restored: FlowEdge = { ...restore, templateEdgeId };
      delete restored.archivedAt;
      delete restored.archivedReason;
      delete restored.batchId;
      delete restored.createdByBatchId;
      flow = { nodes: flow.nodes, edges: flow.edges.map((x) => (x === restore ? restored : x)) };
    } else {
      flow = {
        nodes: flow.nodes,
        edges: [...flow.edges, { id: idFactory(), from, to, createdAt: now, templateEdgeId }],
      };
    }
    summary.push(`Added arrow ${label}.`);
    appliedItemIds.push(item.id);
  }

  // Silent links of same-pair arrows (never for a project-only step whose link was not applied).
  for (const link of plan.silentLinks) {
    const edge = flow.edges.find((x) => x.id === link.edgeId);
    if (!edge || !isActiveEdge(edge)) continue;
    if (unlinked.has(edge.from) || unlinked.has(edge.to)) continue;
    if (flow.edges.some((x) => x !== edge && isActiveEdge(x) && x.templateEdgeId === link.templateEdgeId)) continue;
    flow = {
      nodes: flow.nodes,
      edges: flow.edges.map((x) => (x === edge ? { ...x, templateEdgeId: link.templateEdgeId } : x)),
    };
  }

  // 5. N/A marks.
  for (const item of of("markNA")) {
    const action = plan.actions.get(item.id)!;
    if (action.kind !== "markNA") continue;
    addPatch(action.step.id, { notApplicable: true });
    summary.push(`Marked "${action.step.name}" not applicable.`);
    appliedItemIds.push(item.id);
  }

  const stepPatches = [...patches]
    .filter(([, patch]) => Object.keys(patch).length > 0)
    .map(([stepId, patch]) => ({ stepId, patch }));
  return { ok: true, result: { newSteps, stepPatches, flow, appliedItemIds, summary } };
}

/** Position for a node added by sync: right of and below a mapped template predecessor, moved down until free. */
function placeNewNode(milestoneId: string, plan: BuiltPlan, template: Template, flow: Flow, added: StepDraft[]): Position {
  const visible = [...plan.activeStepIds, ...added.map((d) => d.tempId)]
    .map((id) => flow.nodes[id])
    .filter((p): p is Position => !!p);
  let pos: Position | undefined;
  for (const p of predecessorsOf(plan.templateEdges, milestoneId)) {
    const nodeId = plan.mapping.get(p);
    const at = nodeId ? flow.nodes[nodeId] : undefined;
    const placed = nodeId && (plan.activeStepIds.has(nodeId) || added.some((d) => d.tempId === nodeId));
    if (at && placed) {
      pos = { x: at.x + 240, y: at.y + 120 };
      break;
    }
  }
  if (!pos) {
    const tp = template.flow.nodes[milestoneId];
    if (tp) pos = { x: tp.x, y: tp.y };
    else pos = { x: 0, y: visible.length ? Math.max(...visible.map((v) => v.y)) + NODE_HEIGHT + 80 : 0 };
  }
  const overlaps = (c: Position) =>
    visible.some((q) => Math.abs(q.x - c.x) < NODE_WIDTH && Math.abs(q.y - c.y) < NODE_HEIGHT);
  while (overlaps(pos)) pos = { x: pos.x, y: pos.y + 80 };
  return pos;
}

/**
 * Merge an apply result into the project state (what the service layer persists): new steps get the ids in
 * `newStepIds` (tempId -> step id), patches are applied and the flow is remapped.
 */
export function mergeSyncResult(
  project: SyncProjectInput,
  result: SyncApplyResult,
  opts: { newStepIds: Record<string, string>; projectId: string; now: Iso },
): SyncProjectInput {
  const patchById = new Map(result.stepPatches.map((p) => [p.stepId, p.patch]));
  const steps: Step[] = project.steps.map((s) => (patchById.has(s.id) ? { ...s, ...patchById.get(s.id)! } : s));
  for (const d of result.newSteps) {
    const { tempId, ...rest } = d;
    steps.push({
      ...rest,
      id: opts.newStepIds[tempId] ?? tempId,
      projectId: opts.projectId,
      createdAt: opts.now,
      updatedAt: opts.now,
    });
  }
  return { ...project, steps, flow: remapFlow(result.flow, opts.newStepIds) };
}
