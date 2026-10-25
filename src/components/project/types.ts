/**
 * Client-side shapes for the project page. Pure types (safe to import from Server Actions and Client Components).
 * The store keeps "raw" data (what the server stores); everything derived (state, display, order, current,
 * progress) is recomputed in the browser with the same domain functions the server uses.
 */
import type { StateReason } from "@/domain/state";
import type { Choice, FieldConfig, FieldType, FlowEdge, NodeFlag, Position, State, StateCode, Value } from "@/domain/types";
import type { AttachmentDTO, DetailDTO, NoteDTO, ProjectPageData } from "@/server/queries";

/** The stored part of a step (what a write changes). */
export interface RawStep {
  id: string;
  milestoneId: string | null;
  milestoneKey: string | null;
  name: string;
  description: string;
  fieldType: FieldType;
  choices: Choice[];
  config: FieldConfig;
  value: Value | null;
  notApplicable: boolean;
  flag: NodeFlag | null;
  order: number;
  rev: number;
  valueSetAt: string | null;
  stateChangedAt: string | null;
  lastChangedAt: string | null;
  projectOnly: boolean;
  notInTemplate: boolean;
  typeDiffers: boolean;
}

/** What a step write sends back (the step as stored after the write). */
export type StepResult = Pick<
  RawStep,
  | "id"
  | "name"
  | "description"
  | "fieldType"
  | "choices"
  | "config"
  | "value"
  | "notApplicable"
  | "flag"
  | "order"
  | "rev"
  | "valueSetAt"
  | "stateChangedAt"
  | "lastChangedAt"
>;

export interface StepWriteData {
  step: StepResult;
  changed: boolean;
  flagCleared: boolean;
  suggestClose: boolean;
  /** setStepFlag: the note that holds the reason. */
  noteId?: string;
}

export interface ProjectInfo {
  id: string;
  code: string;
  name: string;
  status: ProjectPageData["project"]["status"];
  statusLabel: string;
  setup: "CREATING" | "READY";
  archived: boolean;
  archivedAt: string | null;
  templateRevision: number;
  createdAt: string;
  updatedAt: string;
}

/** Everything the store holds. */
export interface RawProject {
  project: ProjectInfo;
  details: DetailDTO[];
  detailFields: ProjectPageData["detailFields"];
  steps: Record<string, RawStep>;
  positions: Record<string, Position>;
  edges: FlowEdge[];
  notes: NoteDTO[];
  attachments: AttachmentDTO[];
  archivedSteps: ProjectPageData["archivedSteps"];
  sync: ProjectPageData["sync"];
  suggestClose: boolean;
  version: string;
  today: string;
  /** Server time when this data was read: an older snapshot never replaces a newer one. */
  readAt: string;
}

/** Page data as an action or the page sends it, with the time the read started. */
export interface PageSnapshot {
  data: ProjectPageData;
  readAt: string;
}

/** A step with everything the screens show. */
export interface StepView extends RawStep {
  state: State;
  stateCode: StateCode;
  stateLabel: string;
  reason: StateReason;
  reasonText: string;
  fieldTypeLabel: string;
  seq: number;
  display: string;
  shortDisplay: string;
  isCurrent: boolean;
  noteCount: number;
  latestNote: NoteDTO | null;
  attachmentCount: number;
  predecessors: string[];
  successors: string[];
}

export interface ProgressView {
  done: number;
  applicable: number;
  pct: number;
  counts: Record<State, number>;
}

export interface ProjectView {
  steps: StepView[];
  byId: Map<string, StepView>;
  progress: ProgressView;
  currentIds: string[];
}

export type ProjectViewMode = "flow" | "list" | "history";
