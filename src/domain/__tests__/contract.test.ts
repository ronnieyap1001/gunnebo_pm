/**
 * The domain contract other layers are written against. Each export is assigned to the signature from the contract,
 * so `npx tsc -p tsconfig.domain.json` fails when an export drifts (renamed, a parameter added or retyped, a return
 * shape changed). Interfaces are compared both ways.
 */
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import * as cells from "@/domain/cells";
import * as convert from "@/domain/convertValue";
import * as dates from "@/domain/dates";
import * as fieldTypes from "@/domain/fieldTypes";
import * as format from "@/domain/format";
import * as graph from "@/domain/graph";
import * as importPlan from "@/domain/importPlan";
import * as layout from "@/domain/layout";
import * as seed from "@/domain/seed";
import * as slug from "@/domain/slug";
import * as snapshot from "@/domain/snapshot";
import * as state from "@/domain/state";
import * as syncPlan from "@/domain/syncPlan";
import * as templateFile from "@/domain/templateFile";
import type {
  Cell,
  Choice,
  DayContext,
  EdgeArchiveReason,
  FieldConfig,
  FieldDef,
  FieldType,
  Flow,
  FlowEdge,
  Iso,
  Milestone,
  NodeFlag,
  Position,
  ProjectField,
  State,
  StateCode,
  Step,
  SystemFieldKey,
  Template,
  Value,
  Ymd,
} from "@/domain/types";

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const same = <A, B>(ok: Equals<A, B>) => ok;

// --- fieldTypes ---------------------------------------------------------------
const FIELD_TYPE_META: Record<FieldType, { label: string; hasChoices: boolean; choicesHaveState: boolean }> =
  fieldTypes.FIELD_TYPE_META;
const fieldTypeFromLabel: (label: string) => FieldType | undefined = fieldTypes.fieldTypeFromLabel;

// --- values -------------------------------------------------------------------
import * as values from "@/domain/values";
const valueSchema: (t: FieldType) => z.ZodType<Value> | null = values.valueSchema;
const normalizeValue: (
  def: FieldDef,
  raw: unknown,
) => { ok: true; value: Value | null } | { ok: false; error: string } = values.normalizeValue;
const isEmptyValue: (t: FieldType, v: Value | null) => boolean = values.isEmptyValue;

// --- dates --------------------------------------------------------------------
const todayIn: (timeZone: string, now: Date) => Ymd = dates.todayIn;
const isValidYmd: (s: string) => boolean = dates.isValidYmd;
const formatYmd: (ymd: Ymd) => string = dates.formatYmd;
const formatInstant: (iso: Iso, timeZone: string) => string = dates.formatInstant;
const formatRelative: (iso: Iso, now: Iso) => string = dates.formatRelative;
const parseDateInput: (text: string, today: Ymd) => Ymd | null = dates.parseDateInput;
const addDays: (ymd: Ymd, n: number) => Ymd = dates.addDays;
const daysBetween: (a: Ymd, b: Ymd) => number = dates.daysBetween;
const ymdFromInstant: (iso: Iso, timeZone: string) => Ymd = dates.ymdFromInstant;
const toYmdLocal: (d: Date) => Ymd = dates.toYmdLocal;
const fromYmdLocal: (ymd: Ymd) => Date = dates.fromYmdLocal;

// --- state --------------------------------------------------------------------
type ContractReason =
  | "NA_MARKED"
  | "FLAG"
  | "INVALID_VALUE"
  | "EMPTY"
  | "CHOICE"
  | "UNKNOWN_CHOICE"
  | "DATE_PLANNED"
  | "DATE_REACHED"
  | "DATE_PASSED_AUTO"
  | "RANGE_UPCOMING"
  | "RANGE_RUNNING"
  | "RANGE_ENDED"
  | "PERCENT"
  | "FILLED"
  | "FILES";
interface ContractStateNodeInput {
  value: Value | null;
  notApplicable: boolean;
  flag: NodeFlag | null;
  valueSetAt?: Iso;
  attachmentCount?: number;
}
const stateTypes = [
  same<state.StateReason, ContractReason>(true),
  same<state.StateNodeInput, ContractStateNodeInput>(true),
];
const deriveState: (
  def: FieldDef,
  node: ContractStateNodeInput,
  ctx: DayContext,
) => { state: State; reason: ContractReason } = state.deriveState;
const STATE_META: Record<
  State,
  { label: string; code: StateCode; notionColor: "gray" | "blue" | "yellow" | "red" | "green" | "default"; rank: number }
> = state.STATE_META;
const stateFromCode: (code: StateCode) => State = state.stateFromCode;
const isOpenState: (s: State) => boolean = state.isOpenState;
const isDateDrivenReason: (r: ContractReason) => boolean = state.isDateDrivenReason;
const describeReason: (r: ContractReason) => string = state.describeReason;

// --- format, convertValue, slug, cells ------------------------------------------
const formatValue: (
  def: FieldDef,
  value: Value | null,
  opts?: { attachmentCount?: number; short?: boolean; today?: Ymd },
) => string = format.formatValue;
const convertValue: (
  from: FieldType,
  to: FieldType,
  value: Value | null,
  toChoices?: Choice[],
) => { ok: true; value: Value | null } | { ok: false; reason: string } = convert.convertValue;
const slugify: (label: string, taken: Iterable<string>, maxLen?: number) => string = slug.slugify;
const buildCell: (step: Step, attachmentCount: number) => Cell = cells.buildCell;
const cellDef: (cell: Cell) => FieldDef = cells.cellDef;
const cellNode: (cell: Cell) => ContractStateNodeInput = cells.cellNode;
const cellState: (cell: Cell, ctx: DayContext) => { state: State; reason: ContractReason } = cells.cellState;
const cellDisplay: (cell: Cell, ctx?: DayContext) => string = cells.cellDisplay;

// --- templateFile, seed ---------------------------------------------------------
interface CTemplateFileMilestone {
  key: string;
  name: string;
  description?: string;
  fieldType: FieldType;
  config?: FieldConfig;
  order: number;
  position?: Position;
  choices: Choice[];
}
interface CTemplateFileProjectField {
  key: string;
  systemKey?: SystemFieldKey;
  label: string;
  fieldType: FieldType;
  choices: Choice[];
  config?: FieldConfig;
  order: number;
  showInSummary: boolean;
}
interface CTemplateFile {
  format: "gunnebo-pm.template";
  version: 1;
  exportedAt?: Iso;
  templateRevision?: number;
  milestones: CTemplateFileMilestone[];
  edges: { from: string; to: string }[];
  projectFields?: CTemplateFileProjectField[];
}
const templateTypes = [
  same<templateFile.TemplateFileMilestone, CTemplateFileMilestone>(true),
  same<templateFile.TemplateFileProjectField, CTemplateFileProjectField>(true),
  same<templateFile.TemplateFile, CTemplateFile>(true),
];
const TEMPLATE_FILE_FORMAT: "gunnebo-pm.template" = templateFile.TEMPLATE_FILE_FORMAT;
const parseTemplateFile: (json: unknown) => { ok: true; file: CTemplateFile } | { ok: false; errors: string[] } =
  templateFile.parseTemplateFile;
const exportTemplateFile: (template: Template, projectFields: ProjectField[], exportedAt: Iso) => CTemplateFile =
  templateFile.exportTemplateFile;
const seedTemplateFile: () => CTemplateFile = seed.seedTemplateFile;

// --- graph --------------------------------------------------------------------
type CEdgeResult =
  | { ok: true; flow: Flow; edge: FlowEdge }
  | { ok: false; reason: "SELF" | "DUPLICATE" | "CYCLE" | "MISSING_NODE" };
const graphTypes = [same<graph.EdgeResult, CEdgeResult>(true)];
const activeEdges: (flow: Flow) => FlowEdge[] = graph.activeEdges;
const wouldCreateCycle: (edges: FlowEdge[], from: string, to: string) => boolean = graph.wouldCreateCycle;
const predecessorsOf: (edges: FlowEdge[], id: string) => string[] = graph.predecessorsOf;
const successorsOf: (edges: FlowEdge[], id: string) => string[] = graph.successorsOf;
const flowOrder: (nodes: { id: string; order: number; name: string }[], edges: FlowEdge[]) => string[] = graph.flowOrder;
const currentNodeIds: (nodeIds: string[], states: Record<string, State>, edges: FlowEdge[]) => string[] =
  graph.currentNodeIds;
const computeProgress: (states: State[]) => {
  done: number;
  applicable: number;
  pct: number;
  counts: Record<State, number>;
} = graph.computeProgress;
const addEdge: (flow: Flow, from: string, to: string, now: Iso, idFactory: () => string) => CEdgeResult = graph.addEdge;
const archiveEdge: (flow: Flow, edgeId: string, now: Iso, reason: EdgeArchiveReason) => Flow = graph.archiveEdge;
const archiveNodeInFlow: (
  flow: Flow,
  nodeId: string,
  opts: { batchId: string; now: Iso; reconnect: boolean; idFactory: () => string },
) => { flow: Flow; archivedEdgeIds: string[]; bridgeEdgeIds: string[] } = graph.archiveNodeInFlow;
const restoreBatchInFlow: (
  flow: Flow,
  batchId: string,
  activeNodeIds: Set<string>,
  now: Iso,
) => { flow: Flow; restoredEdgeIds: string[]; skippedEdgeIds: string[]; removedBridgeIds: string[] } =
  graph.restoreBatchInFlow;
const insertAfterInFlow: (
  flow: Flow,
  afterId: string,
  newId: string,
  position: Position,
  now: Iso,
  idFactory: () => string,
) => Flow = graph.insertAfterInFlow;

// --- layout, snapshot -------------------------------------------------------------
const NODE_WIDTH: 184 = layout.NODE_WIDTH;
const NODE_HEIGHT: 56 = layout.NODE_HEIGHT;
const autoLayout: (
  nodeIds: string[],
  edges: FlowEdge[],
  opts?: { wrap?: boolean; viewportWidth?: number; ranksep?: number; nodesep?: number },
) => Record<string, Position> = layout.autoLayout;
interface CStepDraft extends Omit<Step, "id" | "projectId" | "createdAt" | "updatedAt"> {
  tempId: string;
}
const snapshotTypes = [same<snapshot.StepDraft, CStepDraft>(true)];
const buildProjectSnapshot: (template: Template, now: Iso) => { steps: CStepDraft[]; flow: Flow } =
  snapshot.buildProjectSnapshot;
const remapFlow: (flow: Flow, idMap: Record<string, string>) => Flow = snapshot.remapFlow;

// --- syncPlan -----------------------------------------------------------------
type CSyncItemKind =
  | "addNode"
  | "linkExisting"
  | "updateDefinition"
  | "updateChoices"
  | "changeType"
  | "markNA"
  | "addEdge"
  | "removeEdge";
interface CSyncItem {
  id: string;
  kind: CSyncItemKind;
  defaultChecked: boolean;
  selectable: boolean;
  title: string;
  detail: string;
  milestoneId?: string;
  stepId?: string;
  edge?: { from: string; to: string };
  stateChange?: { from: State; to: State };
}
interface CSyncPlan {
  items: CSyncItem[];
  warnings: string[];
}
interface CSyncProjectInput {
  steps: Step[];
  flow: Flow;
  dismissed: Record<string, string>;
  attachmentCounts?: Record<string, number>;
}
interface CSyncApplyResult {
  newSteps: CStepDraft[];
  stepPatches: { stepId: string; patch: Partial<Step> }[];
  flow: Flow;
  appliedItemIds: string[];
  summary: string[];
}
const syncTypes = [
  same<syncPlan.SyncItemKind, CSyncItemKind>(true),
  same<syncPlan.SyncItem, CSyncItem>(true),
  same<syncPlan.SyncPlan, CSyncPlan>(true),
  same<syncPlan.SyncProjectInput, CSyncProjectInput>(true),
  same<syncPlan.SyncApplyResult, CSyncApplyResult>(true),
];
const planSync: (template: Template, project: CSyncProjectInput, ctx: DayContext) => CSyncPlan = syncPlan.planSync;
const applySync: (
  template: Template,
  project: CSyncProjectInput,
  selectedIds: string[],
  ctx: DayContext,
  now: Iso,
  idFactory: () => string,
) => { ok: true; result: CSyncApplyResult } | { ok: false; reason: "STALE_PLAN"; missingIds: string[] } = syncPlan.applySync;

// --- importPlan -----------------------------------------------------------------
interface CImportPlan {
  summary: {
    added: string[];
    updated: string[];
    archived: string[];
    choiceChanges: string[];
    edgesAdded: number;
    edgesRemoved: number;
    projectFieldsAdded: string[];
    projectFieldsUpdated: string[];
  };
  milestoneCreates: { tempId: string; data: Omit<Milestone, "id" | "createdAt" | "updatedAt"> }[];
  milestoneUpdates: { id: string; patch: Partial<Milestone> }[];
  milestoneArchives: string[];
  flow: Flow;
  projectFieldCreates: Omit<ProjectField, "id">[];
  projectFieldUpdates: { id: string; patch: Partial<ProjectField> }[];
}
const importTypes = [same<importPlan.ImportPlan, CImportPlan>(true)];
const planTemplateImport: (
  current: { template: Template; projectFields: ProjectField[] },
  file: CTemplateFile,
  now: Iso,
  idFactory: () => string,
) => CImportPlan = importPlan.planTemplateImport;

const exportsUnderTest = {
  FIELD_TYPE_META,
  fieldTypeFromLabel,
  valueSchema,
  normalizeValue,
  isEmptyValue,
  todayIn,
  isValidYmd,
  formatYmd,
  formatInstant,
  formatRelative,
  parseDateInput,
  addDays,
  daysBetween,
  ymdFromInstant,
  toYmdLocal,
  fromYmdLocal,
  deriveState,
  STATE_META,
  stateFromCode,
  isOpenState,
  isDateDrivenReason,
  describeReason,
  formatValue,
  convertValue,
  slugify,
  buildCell,
  cellDef,
  cellNode,
  cellState,
  cellDisplay,
  TEMPLATE_FILE_FORMAT,
  parseTemplateFile,
  exportTemplateFile,
  seedTemplateFile,
  activeEdges,
  wouldCreateCycle,
  predecessorsOf,
  successorsOf,
  flowOrder,
  currentNodeIds,
  computeProgress,
  addEdge,
  archiveEdge,
  archiveNodeInFlow,
  restoreBatchInFlow,
  insertAfterInFlow,
  NODE_WIDTH,
  NODE_HEIGHT,
  autoLayout,
  buildProjectSnapshot,
  remapFlow,
  planSync,
  applySync,
  planTemplateImport,
};

describe("domain contract", () => {
  it("exports every contract name (types are checked by tsc)", () => {
    for (const [name, value] of Object.entries(exportsUnderTest)) expect(value, name).toBeDefined();
    expect([...stateTypes, ...templateTypes, ...graphTypes, ...snapshotTypes, ...syncTypes, ...importTypes].every(Boolean)).toBe(true);
  });
});
