"use client";

import { forwardRef, useImperativeHandle, useRef, useState } from "react";
import { Loader2, Pencil, Trash2 } from "lucide-react";
import type { NoteDTO } from "@/server/queries";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useProject } from "./context";
import { actorLabel } from "./history-row";
import { relative, useNow } from "./format";

export interface StepNotesHandle {
  focus: () => void;
}

const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** Notes on a step: add (Cmd/Ctrl+Enter), newest first, edit and delete (both logged; text stays in History). */
export const StepNotes = forwardRef<StepNotesHandle, { stepId: string }>(function StepNotes({ stepId }, ref) {
  const { raw, api, readOnly, displayName, timeZone } = useProject();
  const notes = raw.notes.filter((n) => n.stepId === stepId && !n.archived);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const now = useNow();
  useImperativeHandle(ref, () => ({ focus: () => input.current?.focus() }), []);

  async function add() {
    const body = draft.trim();
    if (!body || saving) return;
    setSaving(true);
    setDraft("");
    const kept = await api.addNote(stepId, body);
    setSaving(false);
    // Not saved and not kept on the page (an expired session keeps it listed until Retry): give the text back.
    if (!kept) setDraft((d) => d || body);
  }

  return (
    <div className="space-y-2">
      {!readOnly ? (
        <div className="space-y-1.5">
          <Textarea
            ref={input}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void add();
              }
            }}
            placeholder="Add a note…"
            aria-label="New note"
            rows={2}
            className="field-sizing-content min-h-14 text-sm"
          />
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-muted-foreground">{isMac() ? "⌘" : "Ctrl"}+Enter to add</span>
            <Button size="sm" variant="secondary" onClick={() => void add()} disabled={!draft.trim() || saving}>
              {saving ? <Loader2 className="animate-spin" aria-hidden /> : null}
              Add note
            </Button>
          </div>
        </div>
      ) : null}
      {notes.length === 0 ? (
        <p className="text-xs text-muted-foreground">No notes yet.</p>
      ) : (
        <ul className="space-y-2">
          {notes.map((n) => (
            <NoteItem key={n.id} note={n} now={now} timeZone={timeZone} displayName={displayName} readOnly={readOnly} />
          ))}
        </ul>
      )}
    </div>
  );
});

function NoteItem({
  note,
  now,
  timeZone,
  displayName,
  readOnly,
}: {
  note: NoteDTO;
  now: string | null;
  timeZone: string;
  displayName: string;
  readOnly: boolean;
}) {
  const { api } = useProject();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(note.body);
  const pending = note.id.startsWith("tmp-");

  async function save() {
    const body = text.trim();
    if (!body) return;
    setEditing(false);
    if (body !== note.body) {
      const ok = await api.editNote(note, body);
      if (!ok) {
        setText(body);
        setEditing(true);
      }
    }
  }

  return (
    <li className="group rounded-md border bg-card px-2.5 py-2 text-sm">
      {editing ? (
        <div className="space-y-1.5">
          <Textarea
            value={text}
            autoFocus
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void save();
              }
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                setText(note.body);
                setEditing(false);
              }
            }}
            aria-label="Edit note"
            className="field-sizing-content min-h-14 text-sm"
          />
          <div className="flex justify-end gap-1">
            <Button
              size="xs"
              variant="ghost"
              onClick={() => {
                setText(note.body);
                setEditing(false);
              }}
            >
              Cancel
            </Button>
            <Button size="xs" onClick={() => void save()} disabled={!text.trim()}>
              Save
            </Button>
          </div>
        </div>
      ) : (
        <>
          <p className="whitespace-pre-wrap break-words">{note.body}</p>
          <div className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground">
            <span>
              {actorLabel(note.author, displayName)}
              {now ? ` · ${relative(note.createdAt, now, timeZone)}` : ""}
              {note.editedAt ? " · edited" : ""}
            </span>
            {pending ? <Loader2 className="size-3 animate-spin" aria-label="Saving" /> : null}
            {!readOnly && !pending ? (
              <span className="ml-auto flex gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label="Edit note"
                  onClick={() => {
                    setText(note.body);
                    setEditing(true);
                  }}
                >
                  <Pencil aria-hidden />
                </Button>
                <Button size="icon-xs" variant="ghost" aria-label="Delete note" onClick={() => void api.archiveNote(note)}>
                  <Trash2 aria-hidden />
                </Button>
              </span>
            ) : null}
          </div>
        </>
      )}
    </li>
  );
}
