"use client";

import { useEffect, useRef } from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, Copy, CornerDownRight } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { SidePanel } from "@/components/shell/side-panel";
import { StateBadge, StateIcon } from "@/components/state/state-badge";
import { ValueEditor } from "@/components/fields/value-editor";
import { useProject, type PanelSection } from "./context";
import { relative, useNow } from "./format";
import { Kbd } from "./kbd";
import { StepDefinition } from "./step-definition";
import { StepFiles } from "./step-files";
import { StepFlag } from "./step-flag";
import { StepHistory } from "./step-history";
import { StepNotes, type StepNotesHandle } from "./step-notes";
import type { StepView } from "./types";

function Section({ title, children, id, extra }: { title: string; children: React.ReactNode; id?: string; extra?: React.ReactNode }) {
  return (
    <section id={id} aria-labelledby={id ? `${id}-h` : undefined} className="space-y-2 border-b px-4 py-3 last:border-b-0">
      <div className="flex items-center gap-2">
        <h3 id={id ? `${id}-h` : undefined} className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          {title}
        </h3>
        {extra ? <div className="ml-auto flex items-center gap-1">{extra}</div> : null}
      </div>
      {children}
    </section>
  );
}

function OriginBadge({ step }: { step: StepView }) {
  const label = step.projectOnly ? "Project-only" : step.notInTemplate ? "Not in template" : "From template";
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center rounded-full border px-1.5 text-[11px] font-medium",
        step.projectOnly && "border-[var(--current-ring)]/40 text-[var(--current-ring)]",
        step.notInTemplate && "border-[var(--state-w-border)] bg-[var(--state-w-bg)] text-[var(--state-w-fg)]",
      )}
    >
      {label}
    </span>
  );
}

export function StepPanel({
  stepId,
  focusValue,
  section,
  sectionNonce,
  onClose,
  onPrev,
  onNext,
  onInsertAfter,
}: {
  stepId: string;
  /** Move the keyboard into the value editor (not when stepping through milestones with J/K). */
  focusValue: boolean;
  section: PanelSection;
  sectionNonce: number;
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
  /** Opens "+ Project step" with this step as "Insert after". */
  onInsertAfter: (stepId: string) => void;
}) {
  const { view, raw, api, readOnly, timeZone, openStep } = useProject();
  const s = view.byId.get(stepId);
  const now = useNow();
  const notesRef = useRef<StepNotesHandle>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!section) return;
    const el = bodyRef.current?.querySelector(`#step-${section}`);
    el?.scrollIntoView({ block: "start", behavior: "smooth" });
    if (section === "notes") setTimeout(() => notesRef.current?.focus(), 50);
  }, [section, sectionNonce, stepId]);

  if (!s) return null;
  const def = { fieldType: s.fieldType, choices: s.choices, config: s.config };
  const preds = s.predecessors.map((id) => view.byId.get(id)).filter((x): x is StepView => Boolean(x));
  const index = view.steps.findIndex((x) => x.id === s.id);

  const warnings: string[] = [];
  if (s.reason === "INVALID_VALUE") warnings.push("The stored value doesn't fit this field type, so it shows as not started. Set it again.");
  if (s.reason === "UNKNOWN_CHOICE") warnings.push("The chosen option no longer exists. Pick another one.");
  if (s.typeDiffers) warnings.push("The template now uses another field type. It applies at the next Sync once this value is cleared.");
  if (s.notInTemplate) warnings.push("This milestone was removed from the template. Mark it not applicable if it isn't needed.");

  return (
    <SidePanel
      open
      onClose={onClose}
      title={
        <span className="flex items-start gap-1.5">
          <StateIcon state={s.state} className="mt-0.5 size-4" />
          <span className="min-w-0 break-words">{s.name}</span>
        </span>
      }
      subtitle={
        <span className="mt-1 flex flex-col gap-1.5">
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="tabular-nums">#{s.seq}</span>
            <OriginBadge step={s} />
            <StateBadge state={s.state} />
            {s.isCurrent ? (
              <span className="inline-flex h-5 items-center gap-1 rounded-full border border-[var(--current-ring)]/50 px-1.5 text-[11px] font-medium text-[var(--current-ring)]">
                Current
              </span>
            ) : null}
          </span>
          {preds.length ? (
            <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
              <span>Comes after:</span>
              {preds.map((p, i) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => openStep(p.id)}
                  className="inline-flex max-w-full items-center gap-1 rounded px-0.5 text-foreground/90 hover:bg-muted hover:underline"
                  title={`${p.name} (${p.stateLabel})`}
                >
                  <span className="truncate">{p.name}</span>
                  <StateIcon state={p.state} className="size-3" />
                  <span className="sr-only">{p.stateLabel}</span>
                  {i < preds.length - 1 ? <span aria-hidden>,</span> : null}
                </button>
              ))}
            </span>
          ) : (
            <span>Start of the flow (nothing comes before it)</span>
          )}
        </span>
      }
      headerExtra={
        <div className="flex items-center">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" onClick={onPrev} disabled={index <= 0} aria-label="Previous milestone (K)">
                <ChevronUp aria-hidden />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              Previous <Kbd>K</Kbd>
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" onClick={onNext} disabled={index >= view.steps.length - 1} aria-label="Next milestone (J)">
                <ChevronDown aria-hidden />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              Next <Kbd>J</Kbd>
            </TooltipContent>
          </Tooltip>
        </div>
      }
      footer={
        <div className="flex items-center gap-1.5">
          <span>{s.lastChangedAt ? `Last changed ${relative(s.lastChangedAt, now, timeZone) || "…"}` : "Not changed yet"}</span>
          <span aria-hidden>·</span>
          <button
            type="button"
            className="inline-flex min-w-0 items-center gap-1 rounded px-0.5 font-mono hover:bg-muted hover:text-foreground"
            onClick={() => {
              navigator.clipboard
                ?.writeText(s.id)
                .then(() => toast.success("Step ID copied", { description: "Automations can use it to find this milestone." }))
                .catch(() => toast.error("Couldn't copy. Select the ID and copy it by hand."));
            }}
            title={`Step ID ${s.id}: click to copy`}
            aria-label="Copy the step ID"
          >
            ID {s.id.slice(0, 8)}… <Copy className="size-3" aria-hidden />
          </button>
        </div>
      }
    >
      <div ref={bodyRef} key={s.id} className="relative">
        <Section title="Value" id="step-value">
          {s.fieldType === "FILE" ? (
            <p className="text-xs text-muted-foreground">Add files or links below. One or more marks this milestone done.</p>
          ) : (
            <ValueEditor
              def={def}
              value={s.value}
              today={raw.today}
              onCommit={(v) => void api.setValue(s.id, v)}
              label={s.name}
              disabled={readOnly}
              autoFocus={focusValue && !section}
              emptyChoicesHint={s.projectOnly ? "No choices yet. Add them under Definition below." : undefined}
            />
          )}
          <p className="text-xs text-muted-foreground">
            {s.notApplicable ? "Marked not applicable: the value is kept but doesn't count." : s.flag ? "Flagged: the flag decides the colour until it is removed." : s.reasonText}
          </p>
          {s.reason === "DATE_PASSED_AUTO" && !readOnly ? (
            <div className="flex items-center gap-2 rounded-md border border-[var(--state-d-border)] bg-[var(--state-d-bg)] px-2.5 py-2 text-xs text-[var(--state-d-fg)] state-d">
              <span className="flex-1">This date passed by itself. Did it really happen?</span>
              <Button size="xs" variant="outline" onClick={() => void api.confirmDate(s.id)}>
                <CheckCircle2 aria-hidden /> Confirm it happened
              </Button>
            </div>
          ) : null}
          {warnings.map((w) => (
            <p key={w} className="flex items-start gap-1.5 text-xs text-[var(--state-w-fg)]">
              <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden /> {w}
            </p>
          ))}
        </Section>

        <Section title="Status">
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={s.notApplicable} onCheckedChange={(v) => void api.setNotApplicable(s.id, v)} disabled={readOnly} aria-keyshortcuts="x" />
            <span className="flex-1">Not applicable for this project</span>
            <Kbd>X</Kbd>
          </label>
          <div className="space-y-1">
            <div className="text-xs text-muted-foreground">Flag</div>
            <StepFlag step={s} />
          </div>
        </Section>

        <Section title={`Notes${s.noteCount ? ` (${s.noteCount})` : ""}`} id="step-notes">
          <StepNotes ref={notesRef} stepId={s.id} />
        </Section>

        <Section title={`Links & files${s.attachmentCount ? ` (${s.attachmentCount})` : ""}`} id="step-files">
          <StepFiles stepId={s.id} />
        </Section>

        <Section
          title="Definition"
          id="step-definition"
          extra={
            !readOnly ? (
              <Button size="xs" variant="ghost" onClick={() => onInsertAfter(s.id)} title="Add a project-only step right after this one">
                <CornerDownRight aria-hidden /> Insert step after
              </Button>
            ) : null
          }
        >
          <StepDefinition step={s} />
        </Section>

        <Section title="History" id="step-history">
          <StepHistory stepId={s.id} />
        </Section>
      </div>
    </SidePanel>
  );
}
