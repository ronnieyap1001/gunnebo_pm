"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import type { Choice, ProjectField, ProjectStatus, Value, Ymd } from "@/domain/types";
import { enqueue, newOpId } from "@/lib/write-queue";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { addProjectFieldChoiceAction, startCreateProjectAction } from "@/app/(app)/projects/actions";
import { callAction, isRetryable } from "@/components/shell/action-call";
import { DetailInput, parseNumberText, URL_PATTERN, type DraftText } from "./detail-inputs";
import { onRadioKeyDown } from "./radio-keys";
import { PROJECT_STATUS_OPTIONS } from "./status-pill";

/** Same rule as the service: 2–20 letters, digits or dashes, starting with a letter or digit. */
const CODE_PATTERN = /^[A-Z0-9][A-Z0-9-]{1,19}$/;
const CODE_FORMAT_MESSAGE =
  "A project code is 2–20 letters, digits or dashes and starts with a letter or digit, for example C0822 or C0822-SP1.";

export interface TakenCode {
  name: string;
  archived: boolean;
}

export interface StartedJob {
  opId: string;
  projectId: string;
  code: string;
  total: number;
}

function normalizeCode(raw: string): string {
  return raw.trim().toUpperCase();
}

function takenMessage(code: string, t: TakenCode): string {
  return t.archived ? `${code} is used by an archived project. Restore it from the Archive.` : `${code} is already used by "${t.name}".`;
}

/** Choice fields where "Add 'X'" is offered (everything except the fixed Project type list). */
function allowsAdd(f: ProjectField): boolean {
  return (f.fieldType === "DROPDOWN" || f.fieldType === "MULTIPLE") && f.systemKey !== "projectType";
}

/**
 * New project: Code, Name, Status, then every active project field in order. "Create project" starts the creation
 * job (startCreateProject); the caller then runs continueCreateProject with the progress dialog.
 */
export function NewProjectDialog({
  open,
  onOpenChange,
  fields,
  takenCodes,
  milestoneCount,
  today,
  onStarted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  fields: ProjectField[];
  takenCodes: Record<string, TakenCode>;
  milestoneCount: number;
  today: Ymd;
  onStarted: (job: StartedJob) => void;
}) {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [status, setStatus] = useState<ProjectStatus>("ACTIVE");
  const [values, setValues] = useState<Record<string, Value | null>>({});
  const [texts, setTexts] = useState<DraftText>({});
  const [addedChoices, setAddedChoices] = useState<Record<string, Choice[]>>({});
  const [codeTouched, setCodeTouched] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [serverCodeError, setServerCodeError] = useState<string | null>(null);
  /** Shown inside the form: toasts can't be clicked while this modal dialog is open. */
  const [formError, setFormError] = useState<{ message: string; code?: string; retry?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  /** Set at once (state updates later), so a second Enter or click can't send a second request. */
  const inFlight = useRef(false);
  const opIdRef = useRef<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    // Fresh form each time the dialog opens.
    setCode("");
    setName("");
    setStatus("ACTIVE");
    setValues({});
    setTexts({});
    setCodeTouched(false);
    setSubmitted(false);
    setServerCodeError(null);
    setFormError(null);
    setBusy(false);
    opIdRef.current = null;
  }, [open]);

  const normalized = normalizeCode(code);
  const taken = normalized ? takenCodes[normalized] : undefined;
  const codeError = !normalized
    ? submitted
      ? "Enter a project code, for example C0822."
      : null
    : taken
      ? takenMessage(normalized, taken)
      : (codeTouched || submitted) && !CODE_PATTERN.test(normalized)
        ? CODE_FORMAT_MESSAGE
        : serverCodeError;
  const nameError = submitted && !name.trim() ? "Enter a name for the project." : null;

  const fieldErrors = useMemo(() => {
    const out: Record<string, string> = {};
    for (const f of fields) {
      const t = texts[f.id];
      if (t === undefined || !t.trim()) continue;
      if (f.fieldType === "NUMBER" || f.fieldType === "PERCENT") {
        const n = parseNumberText(t);
        if (n !== undefined && !Number.isFinite(n)) out[f.id] = "Enter a number, for example 24.";
        else if (f.fieldType === "PERCENT" && n !== undefined && (n < 0 || n > 100)) out[f.id] = "Enter 0 to 100.";
      }
      if (f.fieldType === "LINK" && !URL_PATTERN.test(t.trim())) out[f.id] = "Enter a web address starting with https://";
    }
    return out;
  }, [fields, texts]);

  function changed() {
    // A changed form is a new user action (new opId); an unchanged retry re-sends the same one.
    opIdRef.current = null;
    setFormError(null);
  }

  function setValue(fieldId: string, v: Value | null) {
    changed();
    setValues((prev) => ({ ...prev, [fieldId]: v }));
  }

  const choicesOf = (f: ProjectField): Choice[] => {
    const local = addedChoices[f.id];
    if (!local) return f.choices ?? [];
    // Props refresh after the tag update; keep whichever list knows more choices.
    return local.length >= (f.choices ?? []).length ? local : (f.choices ?? []);
  };

  async function addChoice(field: ProjectField, label: string): Promise<string | null> {
    const opId = newOpId();
    // Same queue as the Library's project-field edits: one field write in flight at a time, retried with this opId.
    const r = await enqueue("project-fields", () => callAction(() => addProjectFieldChoiceAction(opId, field.id, label)));
    if (!r.ok) {
      setFormError({ message: `Couldn't add "${label}" to ${field.label}. ${r.error}`, code: r.code });
      return null;
    }
    setAddedChoices((prev) => ({ ...prev, [field.id]: r.data.choices }));
    toast.success(`Added "${label}" to ${field.label}`);
    return r.data.choiceId;
  }

  async function submit(e?: React.FormEvent) {
    e?.preventDefault();
    if (busy || inFlight.current) return;
    setSubmitted(true);
    setCodeTouched(true);
    const c = normalizeCode(code);
    const n = name.trim();
    if (!c || !CODE_PATTERN.test(c) || takenCodes[c]) {
      codeRef.current?.focus();
      return;
    }
    if (!n) {
      nameRef.current?.focus();
      return;
    }
    if (Object.keys(fieldErrors).length) {
      const first = fields.find((f) => fieldErrors[f.id]);
      if (first) document.getElementById(`np-field-${first.id}`)?.focus();
      return;
    }
    // A date typed in a form the app can't read ("Not a date…") would otherwise be dropped without a word.
    const unreadable = formRef.current?.querySelector<HTMLElement>("[aria-invalid='true']");
    if (unreadable) {
      unreadable.focus();
      return;
    }
    const details: Record<string, Value> = {};
    for (const f of fields) {
      const v = values[f.id];
      if (v === null || v === undefined) continue;
      if ((f.fieldType === "TEXT" || f.fieldType === "LONG_TEXT") && "text" in v) {
        const t = v.text.trim();
        if (t) details[f.id] = { text: t };
        continue;
      }
      details[f.id] = v;
    }

    const opId = opIdRef.current ?? newOpId();
    opIdRef.current = opId;
    inFlight.current = true;
    setBusy(true);
    setFormError(null);
    setServerCodeError(null);
    const r = await callAction(() => startCreateProjectAction(opId, { code: c, name: n, status, details }));
    inFlight.current = false;
    if (r.ok) {
      // Stays "Creating…" while the dialog closes and the progress dialog takes over.
      onStarted({ opId, projectId: r.data.projectId, code: c, total: r.data.total });
      return;
    }
    setBusy(false);
    if (r.code === "CODE_TAKEN") {
      setServerCodeError(r.error);
      opIdRef.current = null;
      codeRef.current?.focus();
      return;
    }
    setFormError({
      message: `The project was not created. ${r.error}`,
      code: r.code,
      retry: r.code === "SESSION" || isRetryable(r),
    });
  }

  return (
    <Dialog open={open} onOpenChange={(o) => (!busy ? onOpenChange(o) : undefined)}>
      <DialogContent className="flex max-h-[min(90svh,860px)] flex-col gap-0 p-0 sm:max-w-2xl">
        <DialogHeader className="border-b px-5 pt-4 pb-3">
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>Code and name are required. Everything else can be filled in later.</DialogDescription>
        </DialogHeader>
        <form id="new-project-form" ref={formRef} onSubmit={submit} noValidate className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <div className="grid grid-cols-1 gap-x-4 gap-y-3.5 sm:grid-cols-2">
            <FormRow label="Code" htmlFor="np-code" required error={codeError} hint={!codeError ? "e.g. C0822 or C0822-SP1" : undefined}>
              <Input
                id="np-code"
                ref={codeRef}
                autoFocus
                autoComplete="off"
                spellCheck={false}
                value={code}
                onChange={(e) => {
                  changed();
                  setServerCodeError(null);
                  setCode(e.target.value.toUpperCase());
                }}
                onBlur={() => setCodeTouched(true)}
                aria-invalid={codeError ? true : undefined}
                aria-describedby="np-code-msg"
                aria-required
                className="h-8 font-mono uppercase"
                maxLength={20}
              />
            </FormRow>
            <FormRow label="Name" htmlFor="np-name" required error={nameError}>
              <Input
                id="np-name"
                ref={nameRef}
                autoComplete="off"
                value={name}
                onChange={(e) => {
                  changed();
                  setName(e.target.value);
                }}
                aria-invalid={nameError ? true : undefined}
                aria-describedby="np-name-msg"
                aria-required
                placeholder="e.g. Heathrow T5 eGates"
                className="h-8"
              />
            </FormRow>
            <FormRow label="Status" htmlFor="np-status" className="sm:col-span-2">
              <div id="np-status" role="radiogroup" aria-label="Status" className="inline-flex w-fit rounded-lg border p-0.5">
                {PROJECT_STATUS_OPTIONS.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    role="radio"
                    aria-checked={status === s.id}
                    tabIndex={status === s.id ? 0 : -1}
                    onClick={() => {
                      changed();
                      setStatus(s.id);
                    }}
                    onKeyDown={(e) =>
                      onRadioKeyDown(
                        e,
                        PROJECT_STATUS_OPTIONS.map((o) => o.id),
                        status,
                        (id) => {
                          changed();
                          setStatus(id);
                        },
                      )
                    }
                    className={cn(
                      "h-7 rounded-md px-3 text-sm transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
                      status === s.id
                        ? "bg-accent font-medium text-accent-foreground shadow-xs"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </FormRow>

            {fields.map((f) => {
              const wide = f.fieldType === "LONG_TEXT" || f.fieldType === "DATE_RANGE" || f.fieldType === "MULTIPLE";
              const id = `np-field-${f.id}`;
              return (
                <FormRow key={f.id} label={f.label} htmlFor={id} error={fieldErrors[f.id]} className={wide ? "sm:col-span-2" : undefined}>
                  <DetailInput
                    field={f}
                    inputId={id}
                    choices={choicesOf(f)}
                    value={values[f.id] ?? null}
                    onChange={(v) => setValue(f.id, v)}
                    text={texts[f.id]}
                    onText={(t) => setTexts((prev) => ({ ...prev, [f.id]: t }))}
                    error={fieldErrors[f.id]}
                    today={today}
                    onAddChoice={allowsAdd(f) ? (label) => addChoice(f, label) : undefined}
                    disabled={busy}
                  />
                </FormRow>
              );
            })}
          </div>
          {formError ? (
            <div
              role="alert"
              className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              <span className="min-w-0 flex-1">{formError.message}</span>
              {formError.code === "SESSION" ? (
                <a
                  href={`/login?next=${encodeURIComponent("/projects")}`}
                  target="_blank"
                  rel="noopener"
                  className="font-medium underline underline-offset-2"
                >
                  Sign in (opens a new tab)
                </a>
              ) : null}
              {formError.code === "STALE_DEPLOYMENT" ? (
                <Button type="button" size="xs" variant="outline" onClick={() => window.location.reload()}>
                  Reload
                </Button>
              ) : null}
              {formError.retry ? (
                <Button type="button" size="xs" variant="outline" onClick={() => void submit()} disabled={busy}>
                  Try again
                </Button>
              ) : null}
            </div>
          ) : null}
        </form>
        <DialogFooter className="mx-0 mb-0 items-center px-5 py-3 sm:justify-between">
          <p className="text-xs text-muted-foreground">Copies the {milestoneCount} milestones and their arrows from the Template Flow.</p>
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" form="new-project-form" disabled={busy}>
              {busy ? <Loader2 className="animate-spin" aria-hidden /> : null}
              {busy ? "Creating…" : "Create project"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FormRow({
  label,
  htmlFor,
  required,
  error,
  hint,
  className,
  children,
}: {
  label: string;
  htmlFor: string;
  required?: boolean;
  error?: string | null;
  hint?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <label htmlFor={htmlFor} className="text-xs font-medium text-foreground/80">
        {label}
        {required ? (
          <span className="text-destructive" aria-hidden>
            {" "}
            *
          </span>
        ) : null}
        {required ? <span className="sr-only"> (required)</span> : null}
      </label>
      {children}
      {error ? (
        <p id={`${htmlFor}-msg`} className="text-xs text-destructive">
          {error}
        </p>
      ) : hint ? (
        <p id={`${htmlFor}-msg`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
