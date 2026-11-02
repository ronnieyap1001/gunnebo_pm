"use client";

/**
 * The project page's client store. `server` is the last data the server sent (page props or an action's reload);
 * `ops` are local changes laid over it: optimistic ones still in flight, and confirmed ones kept for a short while
 * so a reload that started before a write finished can't make the screen jump back. Rolling back a failed write is
 * simply dropping its op. `raw` = ops applied in order over `server`.
 *
 * A confirmed op that outlives KEEP_MS without a fresher snapshot arriving is folded into `server` (it is what the
 * server holds now), never just dropped: dropping it would show the older snapshot again (the old value and rev, so
 * the next write to that step would fail as a conflict).
 */
import { createStore, type StoreApi } from "zustand/vanilla";
import { formatValue } from "@/domain/format";
import type { FlowEdge, Position, Value } from "@/domain/types";
import { isEmptyValue } from "@/domain/values";
import type { AttachmentDTO, NoteDTO } from "@/server/queries";
import type { ProjectInfo, RawProject, RawStep, StepResult } from "./types";

export type Apply = (r: RawProject) => RawProject;

export interface Op {
  id: string;
  /** When the op was confirmed (ms); undefined while in flight. */
  doneAt?: number;
  apply: Apply;
}

/** How long a confirmed op is still laid over fresh server data. */
const KEEP_MS = 20_000;

export interface ProjectStoreState {
  server: RawProject;
  ops: Op[];
  raw: RawProject;
  setServer: (raw: RawProject) => void;
  /** Adds (or replaces) an in-flight op. */
  push: (id: string, apply: Apply) => void;
  /** Marks an op confirmed, optionally replacing what it applies with the server's answer. */
  settle: (id: string, apply?: Apply) => void;
  /** Rolls an op back. */
  drop: (id: string) => void;
}

export type ProjectStore = StoreApi<ProjectStoreState>;

function compute(server: RawProject, ops: Op[]): RawProject {
  let r = server;
  for (const op of ops) {
    try {
      r = op.apply(r);
    } catch {
      // A stale op must never break the screen.
    }
  }
  return r;
}

const expired = (o: Op, now: number) => o.doneAt !== undefined && now - o.doneAt >= KEEP_MS;

/** Folds confirmed ops older than KEEP_MS into the server data (in order) and keeps the rest laid on top. */
function fold(server: RawProject, ops: Op[], now: number): { server: RawProject; ops: Op[] } {
  let next = server;
  const kept: Op[] = [];
  for (const o of ops) {
    if (!expired(o, now)) {
      kept.push(o);
      continue;
    }
    try {
      next = o.apply(next);
    } catch {
      // A stale op must never break the screen.
    }
  }
  return { server: next, ops: kept };
}

export function createProjectStore(initial: RawProject): ProjectStore {
  return createStore<ProjectStoreState>()((set, get) => ({
    server: initial,
    ops: [],
    raw: initial,
    setServer: (server) => {
      // A slower read that started earlier (e.g. a page refresh racing an action's answer) must not win.
      if (server.readAt < get().server.readAt) return;
      // This read started after the long-confirmed writes landed, so it already holds them.
      const now = Date.now();
      const ops = get().ops.filter((o) => !expired(o, now));
      set({ server, ops, raw: compute(server, ops) });
    },
    push: (id, apply) => {
      const folded = fold(get().server, get().ops, Date.now());
      const ops = [...folded.ops.filter((o) => o.id !== id), { id, apply }];
      set({ server: folded.server, ops, raw: compute(folded.server, ops) });
    },
    settle: (id, apply) => {
      const ops = get().ops.map((o) => (o.id === id ? { id, apply: apply ?? o.apply, doneAt: Date.now() } : o));
      if (!ops.some((o) => o.id === id) && apply) ops.push({ id, apply, doneAt: Date.now() });
      set({ ops, raw: compute(get().server, ops) });
    },
    drop: (id) => {
      const ops = get().ops.filter((o) => o.id !== id);
      set({ ops, raw: compute(get().server, ops) });
    },
  }));
}

// ---------------------------------------------------------------------------
// Appliers (idempotent: applying one twice, or over data that already has it, changes nothing)
// ---------------------------------------------------------------------------

/** Optimistic step change (no rev yet). */
export function patchStep(stepId: string, patch: Partial<RawStep>): Apply {
  return (r) => {
    const s = r.steps[stepId];
    if (!s) return r;
    return { ...r, steps: { ...r.steps, [stepId]: { ...s, ...patch } } };
  };
}

/** The server's answer for a step: applied only while the data underneath is older (lower rev). */
export function confirmStep(result: StepResult): Apply {
  return (r) => {
    const s = r.steps[result.id];
    if (!s || s.rev > result.rev) return r;
    return { ...r, steps: { ...r.steps, [result.id]: { ...s, ...result } } };
  };
}

export function removeStep(stepId: string): Apply {
  return (r) => {
    if (!r.steps[stepId]) return r;
    const steps = { ...r.steps };
    delete steps[stepId];
    return { ...r, steps, edges: r.edges.filter((e) => e.from !== stepId && e.to !== stepId) };
  };
}

export function setPositions(positions: Record<string, Position>): Apply {
  return (r) => ({ ...r, positions: { ...r.positions, ...positions } });
}

export function addEdge(edge: FlowEdge): Apply {
  return (r) => {
    if (r.edges.some((e) => e.id === edge.id || (!e.archivedAt && e.from === edge.from && e.to === edge.to))) return r;
    return { ...r, edges: [...r.edges, edge] };
  };
}

export function removeEdges(ids: string[]): Apply {
  const set = new Set(ids);
  return (r) => (r.edges.some((e) => set.has(e.id)) ? { ...r, edges: r.edges.filter((e) => !set.has(e.id)) } : r);
}

export function upsertNote(note: NoteDTO, replaceId?: string): Apply {
  return (r) => {
    const others = r.notes.filter((n) => n.id !== note.id && n.id !== replaceId);
    if (note.archived) return others.length === r.notes.length ? r : { ...r, notes: others };
    const existing = r.notes.find((n) => n.id === note.id);
    if (existing && existing.body === note.body && existing.editedAt === note.editedAt) return r;
    return { ...r, notes: [note, ...others].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0)) };
  };
}

export function removeNote(noteId: string): Apply {
  return (r) => (r.notes.some((n) => n.id === noteId) ? { ...r, notes: r.notes.filter((n) => n.id !== noteId) } : r);
}

export function upsertAttachment(a: AttachmentDTO, replaceId?: string): Apply {
  return (r) => {
    const others = r.attachments.filter((x) => x.id !== a.id && x.id !== replaceId);
    if (a.archived) return others.length === r.attachments.length ? r : { ...r, attachments: others };
    if (r.attachments.some((x) => x.id === a.id) && !replaceId) return r;
    return { ...r, attachments: [a, ...others] };
  };
}

export function removeAttachment(id: string): Apply {
  return (r) => (r.attachments.some((a) => a.id === id) ? { ...r, attachments: r.attachments.filter((a) => a.id !== id) } : r);
}

export function patchProject(patch: Partial<ProjectInfo>): Apply {
  return (r) => ({ ...r, project: { ...r.project, ...patch } });
}

/** Optimistic project-field values (Edit details), so the next pick builds on this one and the header follows at once. */
export function patchDetails(values: Record<string, unknown>): Apply {
  return (r) => ({
    ...r,
    details: r.details.map((d) => {
      if (!Object.prototype.hasOwnProperty.call(values, d.fieldId)) return d;
      const value = (values[d.fieldId] ?? null) as Value | null;
      const ids = value && typeof value === "object" ? ("choiceId" in value ? [value.choiceId] : "choiceIds" in value ? value.choiceIds : []) : [];
      // A choice added a moment ago is not in this copy of the field yet: keep the old text until the server answers.
      const known = ids.every((id) => d.choices.some((c) => c.id === id));
      const display = known ? formatValue({ fieldType: d.fieldType, choices: d.choices, config: d.config }, value, { short: false }) : d.display;
      return { ...d, value, display, empty: value === null || isEmptyValue(d.fieldType, value) };
    }),
  });
}
