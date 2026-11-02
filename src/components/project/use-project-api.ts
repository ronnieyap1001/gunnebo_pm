"use client";

/**
 * Every write the project page can make. One opId per user action (newOpId in the browser), all writes of the
 * project in one queue, optimistic changes laid over the server data and dropped again when the write fails.
 * Failed writes are retried with the SAME opId (automatically for BUSY / network, by the Retry button otherwise).
 */
import { toast } from "sonner";
import { deriveState } from "@/domain/state";
import type { FieldType, FlowEdge, NodeFlag, Position, Value } from "@/domain/types";
import type { ActionResult } from "@/lib/action-result";
import { newOpId } from "@/lib/write-queue";
import type { AttachmentDTO, NoteDTO } from "@/server/queries";
import {
  addDetailChoiceAction,
  addEdgeAction,
  addLinkAction,
  addNoteAction,
  addProjectStepAction,
  archiveAttachmentAction,
  archiveEdgeAction,
  archiveNoteAction,
  archiveProjectAction,
  archiveProjectStepAction,
  bulkNotApplicableAction,
  confirmStepDateAction,
  editNoteAction,
  layoutAction,
  loadProjectAction,
  moveNodesAction,
  restoreAttachmentAction,
  restoreNoteAction,
  restoreProjectAction,
  restoreProjectBatchAction,
  setStepFlagAction,
  setStepNotApplicableAction,
  setStepValueAction,
  updateProjectAction,
  updateStepDefinitionAction,
} from "@/app/(app)/projects/[id]/actions";
import { toRaw } from "./derive";
import {
  addEdge,
  confirmStep,
  patchDetails,
  patchProject,
  patchStep,
  removeAttachment,
  removeEdges,
  removeNote,
  removeStep,
  setPositions,
  upsertAttachment,
  upsertNote,
  type Apply,
  type ProjectStore,
} from "./store";
import type { PageSnapshot, RawStep, StepWriteData } from "./types";
import { queued, read, reportFailure, type Failure } from "./write";

export const MAX_UPLOAD_BYTES = 4_000_000;
export const UNSUPPORTED_EXTENSIONS = [".msg", ".eml", ".exe", ".bat", ".cmd", ".com", ".scr"];
const BULK_CHUNK = 16;
const UNDO_MS = 8000;

interface RunSpec<T> {
  optimistic?: Apply;
  call: (opId: string) => Promise<ActionResult<T>>;
  /** Default: confirm the optimistic op as it is. */
  onOk?: (data: T, opId: string) => void;
  /** Return true when the failure is fully handled (no default toast). */
  onFail?: (f: Failure) => boolean | void;
}

export interface ApiDeps {
  projectId: string;
  store: ProjectStore;
  displayName: string;
  onSuggestClose: () => void;
  navigate: (href: string) => void;
}

const nowIso = () => new Date().toISOString();
/** Long names (files, steps) shortened for toasts. */
const short = (name: string, max = 48) => (Array.from(name).length > max ? `${Array.from(name).slice(0, max - 1).join("")}…` : name);
const combine =
  (...fns: Apply[]): Apply =>
  (r) =>
    fns.reduce((acc, f) => f(acc), r);

export function createProjectApi({ projectId, store, displayName, onSuggestClose, navigate }: ApiDeps) {
  const state = () => store.getState();
  const step = (id: string): RawStep | undefined => state().raw.steps[id];

  function applyPage(page: PageSnapshot) {
    state().setServer(toRaw(page.data, page.readAt));
  }

  async function reload(): Promise<boolean> {
    const r = await read(() => loadProjectAction(projectId));
    if (r.ok) {
      applyPage(r.data);
      return true;
    }
    reportFailure(r);
    return false;
  }

  /** The step's rev when the write first runs (kept for retries of the same opId). */
  function revOnce(stepId: string): () => number {
    let rev: number | undefined;
    return () => (rev ??= step(stepId)?.rev ?? 0);
  }

  async function run<T>(spec: RunSpec<T>, opId: string = newOpId()): Promise<ActionResult<T>> {
    if (spec.optimistic) state().push(opId, spec.optimistic);
    const r = await queued(projectId, () => spec.call(opId));
    if (r.ok) {
      if (spec.onOk) spec.onOk(r.data, opId);
      else state().settle(opId);
      return r;
    }
    if (r.code === "SESSION") {
      // Keep the change on screen; Retry re-sends it with the same opId after signing in.
      reportFailure(r, () => void run(spec, opId), opId);
      return r;
    }
    state().drop(opId);
    if (r.code === "CONFLICT") {
      toast.error(r.error || "This milestone changed elsewhere; reloaded.");
      await reload();
      return r;
    }
    if (!spec.onFail?.(r)) reportFailure(r, () => void run(spec, opId));
    return r;
  }

  function stepOk(data: StepWriteData, opId: string) {
    state().settle(opId, confirmStep(data.step));
    if (data.flagCleared) toast.success("Flag cleared", { description: "The milestone is now done, so its Waiting / Blocked flag was removed." });
    if (data.suggestClose) onSuggestClose();
  }

  // ---------------------------------------------------------------------------
  // Step values
  // ---------------------------------------------------------------------------

  function setValue(stepId: string, value: Value | null) {
    const s = step(stepId);
    if (!s) return;
    const at = nowIso();
    const patch: Partial<RawStep> = { value, valueSetAt: at, lastChangedAt: at };
    if (s.flag) {
      const v = deriveState(
        { fieldType: s.fieldType, choices: s.choices, config: s.config },
        { value, notApplicable: false, flag: null, valueSetAt: at },
        { today: state().raw.today, timeZone: "UTC" },
      ).state;
      if (v === "DONE" || v === "NOT_APPLICABLE") patch.flag = null;
    }
    const rev = revOnce(stepId);
    return run<StepWriteData>({
      optimistic: patchStep(stepId, patch),
      call: (opId) => setStepValueAction(opId, { stepId, value, expectedRev: rev() }),
      onOk: stepOk,
    });
  }

  function setNotApplicable(stepId: string, notApplicable: boolean) {
    const rev = revOnce(stepId);
    return run<StepWriteData>({
      optimistic: patchStep(stepId, { notApplicable, lastChangedAt: nowIso() }),
      call: (opId) => setStepNotApplicableAction(opId, { stepId, notApplicable, expectedRev: rev() }),
      onOk: stepOk,
    });
  }

  function setFlag(stepId: string, flag: NodeFlag | null, reason?: string) {
    const rev = revOnce(stepId);
    const body = flag && reason?.trim() ? `${flag === "BLOCKED" ? "Blocked" : "Waiting"}: ${reason.trim()}` : "";
    return run<StepWriteData>({
      optimistic: patchStep(stepId, { flag, lastChangedAt: nowIso() }),
      call: (opId) => setStepFlagAction(opId, { stepId, flag, reason: reason?.trim() || undefined, expectedRev: rev() }),
      onOk: (data, opId) => {
        const note: NoteDTO | null =
          data.noteId && body
            ? { id: data.noteId, stepId, body, author: displayName, createdAt: nowIso(), editedAt: null, archived: false }
            : null;
        state().settle(opId, note ? combine(confirmStep(data.step), upsertNote(note)) : confirmStep(data.step));
        if (data.changed) toast.success(flag ? `Flagged ${flag === "BLOCKED" ? "Blocked" : "Waiting"}` : "Flag removed");
      },
    });
  }

  function confirmDate(stepId: string) {
    const rev = revOnce(stepId);
    return run<StepWriteData>({
      optimistic: patchStep(stepId, { valueSetAt: nowIso(), lastChangedAt: nowIso() }),
      call: (opId) => confirmStepDateAction(opId, { stepId, expectedRev: rev() }),
      onOk: (data, opId) => {
        stepOk(data, opId);
        toast.success("Confirmed", { description: "The clock mark is gone; History notes that it happened." });
      },
    });
  }

  /** Marks (or clears) N/A on many steps: chunks of 16, one opId per chunk, then a reload for the new revs. */
  async function bulkNotApplicable(stepIds: string[], notApplicable: boolean, onProgress?: (done: number, total: number) => void) {
    const ids = [...new Set(stepIds)];
    let done = 0;
    let changed = 0;
    // `toReport`: a failure this loop still has to show; an expired session or a conflict is shown by run() itself.
    let toReport: Failure | null = null;
    let stopped: Failure | null = null;
    onProgress?.(0, ids.length);
    for (let i = 0; i < ids.length; i += BULK_CHUNK) {
      const chunk = ids.slice(i, i + BULK_CHUNK);
      const optimistic = combine(...chunk.map((id) => patchStep(id, { notApplicable })));
      const r = await run<{ changedIds: string[] }>({
        optimistic,
        call: (opId) => bulkNotApplicableAction(opId, { projectId, stepIds: chunk, notApplicable }),
        onFail: (f) => {
          toReport = f;
          return true;
        },
      });
      if (!r.ok) {
        stopped = r;
        break;
      }
      changed += r.data.changedIds.length;
      done += chunk.length;
      onProgress?.(done, ids.length);
    }
    const failure = stopped as Failure | null;
    // Fresh revs for the changed steps (not while signed out: that would only fail again).
    if (failure?.code !== "SESSION") await reload();
    const report = toReport as Failure | null;
    if (report) reportFailure(report);
    return { changed, done, total: ids.length, ok: !failure };
  }

  // ---------------------------------------------------------------------------
  // Notes
  // ---------------------------------------------------------------------------

  /** True when the note is saved, or kept on the page waiting for Retry after signing in again. */
  async function addNote(stepId: string | null, body: string): Promise<boolean> {
    const opId = newOpId();
    const placeholderNote: NoteDTO = {
      id: `tmp-${opId}`,
      stepId,
      body: body.trim(),
      author: displayName,
      createdAt: nowIso(),
      editedAt: null,
      archived: false,
    };
    const r = await run<NoteDTO>(
      {
        optimistic: upsertNote(placeholderNote),
        call: (id) => addNoteAction(id, { projectId, stepId: stepId ?? undefined, body }),
        onOk: (note, id) => state().settle(id, upsertNote(note, `tmp-${id}`)),
      },
      opId,
    );
    return r.ok || r.code === "SESSION";
  }

  async function editNote(note: NoteDTO, body: string): Promise<boolean> {
    const r = await run<NoteDTO>({
      optimistic: upsertNote({ ...note, body: body.trim(), editedAt: nowIso() }),
      call: (opId) => editNoteAction(opId, { projectId, noteId: note.id, body }),
      onOk: (n, opId) => state().settle(opId, upsertNote(n)),
    });
    return r.ok;
  }

  function restoreNote(note: NoteDTO) {
    return run<NoteDTO>({
      optimistic: upsertNote({ ...note, archived: false }),
      call: (opId) => restoreNoteAction(opId, { projectId, noteId: note.id }),
      onOk: (n, opId) => {
        state().settle(opId, upsertNote(n));
        toast.success("Note restored");
      },
    });
  }

  function archiveNote(note: NoteDTO) {
    return run<NoteDTO>({
      optimistic: removeNote(note.id),
      call: (opId) => archiveNoteAction(opId, { projectId, noteId: note.id }),
      onOk: (_n, opId) => {
        state().settle(opId, removeNote(note.id));
        toast("Note deleted", {
          description: "The text stays in History.",
          duration: UNDO_MS,
          action: { label: "Undo", onClick: () => void restoreNote(note) },
        });
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Links and files
  // ---------------------------------------------------------------------------

  function placeholder(opId: string, stepId: string | null, kind: "FILE" | "LINK", name: string, url: string | null, size: number | null): AttachmentDTO {
    return { id: `tmp-${opId}`, stepId, kind, name, url, size, contentType: null, createdAt: nowIso(), archived: false };
  }

  async function addLink(stepId: string | null, url: string, name?: string): Promise<boolean> {
    const opId = newOpId();
    let host = url;
    try {
      host = new URL(url).hostname.replace(/^www\./, "");
    } catch {
      /* the server explains invalid addresses */
    }
    const r = await run<AttachmentDTO>(
      {
        optimistic: upsertAttachment(placeholder(opId, stepId, "LINK", name?.trim() || host, url, null)),
        call: (id) => addLinkAction(id, { projectId, stepId: stepId ?? undefined, url, name: name?.trim() || undefined }),
        onOk: (a, id) => state().settle(id, upsertAttachment(a, `tmp-${id}`)),
      },
      opId,
    );
    return r.ok;
  }

  /** Checks a file in the browser first: size (4 MB) and types Notion refuses. Returns an error message or null. */
  function checkFile(file: File): string | null {
    if (file.size <= 0) return `"${file.name}" is empty.`;
    if (file.size > MAX_UPLOAD_BYTES) {
      return `"${file.name}" is ${(file.size / 1_000_000).toFixed(1)} MB. Files can be at most 4 MB; for bigger files add a SharePoint or OneDrive link.`;
    }
    const dot = file.name.lastIndexOf(".");
    const ext = dot >= 0 ? file.name.slice(dot).toLowerCase() : "";
    if (UNSUPPORTED_EXTENSIONS.includes(ext)) {
      return `Notion does not accept ${ext} files. Put "${file.name}" in a .zip file, or save it in SharePoint or OneDrive and add the link.`;
    }
    return null;
  }

  async function uploadFile(stepId: string | null, file: File): Promise<boolean> {
    const problem = checkFile(file);
    if (problem) {
      toast.error(problem);
      return false;
    }
    const opId = newOpId();
    const r = await run<AttachmentDTO>(
      {
        optimistic: upsertAttachment(placeholder(opId, stepId, "FILE", file.name, null, file.size)),
        call: async (id) => {
          const form = new FormData();
          form.set("file", file);
          form.set("projectId", projectId);
          if (stepId) form.set("stepId", stepId);
          form.set("opId", id);
          const res = await fetch("/api/files", { method: "POST", body: form, credentials: "same-origin" });
          let body: { ok?: boolean; error?: string; code?: string; attachment?: AttachmentDTO } = {};
          try {
            body = await res.json();
          } catch {
            /* handled below */
          }
          if (res.status === 401) return { ok: false, error: "Session expired. Sign in again", code: "SESSION" };
          if (body.ok && body.attachment) return { ok: true, data: body.attachment };
          return {
            ok: false,
            error: body.error ?? (res.status === 413 ? "Files can be at most 4 MB." : "The upload failed. Try again."),
            code: body.code ?? (res.status >= 500 ? "BUSY" : "VALIDATION"),
          };
        },
        onOk: (a, id) => {
          state().settle(id, upsertAttachment(a, `tmp-${id}`));
          toast.success("File uploaded", { description: short(a.name, 60) });
        },
      },
      opId,
    );
    return r.ok;
  }

  function restoreAttachment(a: AttachmentDTO) {
    return run<AttachmentDTO>({
      optimistic: upsertAttachment(a),
      call: (opId) => restoreAttachmentAction(opId, a.id),
      onOk: (x, opId) => {
        state().settle(opId, upsertAttachment(x));
        toast.success(`Restored "${short(x.name)}"`);
      },
    });
  }

  function archiveAttachment(a: AttachmentDTO) {
    return run<AttachmentDTO>({
      optimistic: removeAttachment(a.id),
      call: (opId) => archiveAttachmentAction(opId, a.id),
      onOk: (_x, opId) => {
        state().settle(opId, removeAttachment(a.id));
        toast(`Removed "${short(a.name)}"`, { duration: UNDO_MS, action: { label: "Undo", onClick: () => void restoreAttachment(a) } });
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Project-only steps
  // ---------------------------------------------------------------------------

  async function addStep(input: {
    name: string;
    fieldType: FieldType;
    description?: string;
    choices?: { label: string; state?: string }[];
    afterStepId?: string;
    position?: Position;
  }): Promise<string | null> {
    const r = await run<{ stepId: string; page: PageSnapshot }>({
      call: (opId) => addProjectStepAction(opId, { projectId, ...input }),
      onOk: (d, opId) => {
        state().settle(opId, (x) => x);
        applyPage(d.page);
        toast.success(`Added "${short(input.name.trim())}"`, { description: "A project-only step: the template is not changed." });
      },
    });
    return r.ok ? r.data.stepId : null;
  }

  function updateDefinition(
    stepId: string,
    patch: Partial<Pick<RawStep, "name" | "description" | "fieldType" | "choices" | "config">>,
    opts: { clearValue?: boolean; onNeedsClear?: () => void } = {},
  ) {
    const rev = revOnce(stepId);
    const optimistic: Partial<RawStep> = { ...patch };
    if (opts.clearValue) optimistic.value = null;
    return run<StepWriteData>({
      optimistic: patchStep(stepId, optimistic),
      call: (opId) => updateStepDefinitionAction(opId, { stepId, patch, expectedRev: rev(), clearValue: opts.clearValue }),
      onOk: stepOk,
      onFail: (f) => {
        if (f.details?.needsClear && opts.onNeedsClear) {
          opts.onNeedsClear();
          return true;
        }
        return false;
      },
    });
  }

  async function restoreBatch(batchId: string, name: string) {
    const r = await run<{ restoredIds: string[]; skippedEdgeIds: string[]; page: PageSnapshot }>({
      call: (opId) => restoreProjectBatchAction(opId, { projectId, batchId }),
      onOk: (d, opId) => {
        state().settle(opId, (x) => x);
        applyPage(d.page);
        const skipped = d.skippedEdgeIds.length;
        toast.success(`Restored "${short(name)}"`, {
          description: skipped ? `${skipped} arrow${skipped === 1 ? "" : "s"} could not come back (they would make a loop).` : undefined,
        });
      },
    });
    return r.ok;
  }

  async function archiveStep(stepId: string, onMarkNa?: () => void): Promise<boolean> {
    const s = step(stepId);
    if (!s) return false;
    if (!s.projectOnly) {
      toast(`"${short(s.name)}" comes from the template`, {
        description: "Template milestones can't be deleted in a project. Mark it Not applicable instead?",
        duration: UNDO_MS,
        action: s.notApplicable ? undefined : { label: "Mark N/A", onClick: () => (onMarkNa ? onMarkNa() : void setNotApplicable(stepId, true)) },
      });
      return false;
    }
    const r = await run<{ batchId: string; page: PageSnapshot }>({
      optimistic: removeStep(stepId),
      call: (opId) => archiveProjectStepAction(opId, { projectId, stepId }),
      onOk: (d, opId) => {
        state().settle(opId, (x) => x);
        applyPage(d.page);
        toast(`Archived "${short(s.name)}"`, {
          description: "Its neighbours were reconnected.",
          duration: UNDO_MS,
          action: { label: "Undo", onClick: () => void restoreBatch(d.batchId, s.name) },
        });
      },
    });
    return r.ok;
  }

  // ---------------------------------------------------------------------------
  // Flow: positions, arrows, layout
  // ---------------------------------------------------------------------------

  function moveNodes(positions: Record<string, Position>) {
    return run<undefined>({
      optimistic: setPositions(positions),
      call: (opId) => moveNodesAction(opId, { projectId, positions }),
    });
  }

  function connect(from: string, to: string) {
    const opId = newOpId();
    const tmp: FlowEdge = { id: `tmp-${opId}`, from, to, createdAt: nowIso() };
    return run<FlowEdge>(
      {
        optimistic: addEdge(tmp),
        call: (id) => addEdgeAction(id, { projectId, from, to }),
        onOk: (edge, id) => state().settle(id, combine(removeEdges([`tmp-${id}`]), addEdge(edge))),
      },
      opId,
    );
  }

  function disconnect(edgeId: string) {
    const e = state().raw.edges.find((x) => x.id === edgeId);
    if (!e || edgeId.startsWith("tmp-")) return;
    const names = (id: string) => step(id)?.name ?? "?";
    return run<undefined>({
      optimistic: removeEdges([edgeId]),
      call: (opId) => archiveEdgeAction(opId, { projectId, edgeId }),
      onOk: (_d, opId) => {
        state().settle(opId, removeEdges([edgeId]));
        toast(`Arrow removed`, {
          description: `${names(e.from)} → ${names(e.to)}`,
          duration: UNDO_MS,
          action: { label: "Undo", onClick: () => void connect(e.from, e.to) },
        });
      },
    });
  }

  async function layout(viewportWidth: number): Promise<boolean> {
    const before = { ...state().raw.positions };
    const id = toast.loading("Arranging the chart…");
    const r = await run<Record<string, Position>>({
      call: (opId) => layoutAction(opId, { projectId, viewportWidth }),
      onOk: (nodes, opId) => {
        state().settle(opId, setPositions(nodes));
        toast.success("Chart arranged", {
          id,
          duration: UNDO_MS,
          action: {
            label: "Undo",
            onClick: () => {
              const ids = Object.keys(nodes);
              const back: Record<string, Position> = {};
              for (const k of ids) if (before[k]) back[k] = before[k];
              void moveNodes(back);
            },
          },
        });
      },
      onFail: (f) => {
        toast.error(f.error, { id });
        return true;
      },
    });
    return r.ok;
  }

  // ---------------------------------------------------------------------------
  // Project
  // ---------------------------------------------------------------------------

  /** Returns the result so forms can show the error next to the field. */
  function updateProject(patch: { code?: string; name?: string; status?: string; details?: Record<string, unknown> }, opts: { quiet?: boolean } = {}) {
    const parts: Apply[] = [];
    if (patch.name !== undefined || patch.status !== undefined) {
      parts.push(
        patchProject({
          ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
          ...(patch.status !== undefined
            ? { status: patch.status as "ACTIVE", statusLabel: patch.status === "ON_HOLD" ? "On hold" : patch.status === "CLOSED" ? "Closed" : "Active" }
            : {}),
        }),
      );
    }
    if (patch.details) parts.push(patchDetails(patch.details));
    const optimistic: Apply | undefined = parts.length ? combine(...parts) : undefined;
    return run<{ changes: unknown[]; page: PageSnapshot }>({
      optimistic,
      call: (opId) => updateProjectAction(opId, { projectId, ...patch }),
      onOk: (d, opId) => {
        state().settle(opId, (x) => x);
        applyPage(d.page);
      },
      onFail: () => opts.quiet === true,
    });
  }

  function addDetailChoice(fieldId: string, label: string) {
    return run<{ choiceId: string }>({ call: (opId) => addDetailChoiceAction(opId, { fieldId, label }) });
  }

  async function restoreProject(code: string, goBack: boolean) {
    const r = await run<{ code: string }>({ call: (opId) => restoreProjectAction(opId, projectId) });
    if (r.ok) {
      toast.success(`Restored ${code}`);
      if (goBack) navigate(`/projects/${projectId}`);
      else await reload();
    }
    return r.ok;
  }

  async function archiveProject(): Promise<boolean> {
    const code = state().raw.project.code;
    const r = await run<{ code: string }>({ call: (opId) => archiveProjectAction(opId, projectId) });
    if (r.ok) {
      toast(`Archived ${code}`, {
        description: "It is hidden everywhere; restore it from the Archive at any time.",
        duration: UNDO_MS,
        action: { label: "Undo", onClick: () => void restoreProject(code, true) },
      });
      navigate("/projects");
    }
    return r.ok;
  }

  return {
    reload,
    applyPage,
    setValue,
    setNotApplicable,
    setFlag,
    confirmDate,
    bulkNotApplicable,
    addNote,
    editNote,
    archiveNote,
    addLink,
    uploadFile,
    checkFile,
    archiveAttachment,
    addStep,
    updateDefinition,
    archiveStep,
    moveNodes,
    connect,
    disconnect,
    layout,
    updateProject,
    addDetailChoice,
    archiveProject,
    restoreProject,
  };
}

export type ProjectApi = ReturnType<typeof createProjectApi>;
