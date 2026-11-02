"use client";

import Link from "next/link";
import { useState } from "react";
import { ExternalLink } from "lucide-react";
import { convertValue } from "@/domain/convertValue";
import { FIELD_TYPE_META } from "@/domain/fieldTypes";
import { formatValue } from "@/domain/format";
import type { FieldType } from "@/domain/types";
import { DefinitionEditor, type DefPatch } from "@/components/library/definition-editor";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { StateDot } from "@/components/state/state-badge";
import { useProject } from "./context";
import type { StepView } from "./types";

/**
 * Project-only steps: the full definition editor (name, type, choices). Steps from the template: read-only, with a
 * link to the Library (template changes reach the project through Sync).
 */
export function StepDefinition({ step }: { step: StepView }) {
  const { api, readOnly, view } = useProject();
  const [askClear, setAskClear] = useState<DefPatch | null>(null);

  if (!step.projectOnly) {
    const active = step.choices.filter((c) => !c.archived);
    return (
      <div className="space-y-2 text-sm">
        <dl className="grid grid-cols-[6rem_1fr] gap-x-2 gap-y-1 text-xs">
          <dt className="text-muted-foreground">Field type</dt>
          <dd>{step.fieldTypeLabel}</dd>
          {step.config.unit ? (
            <>
              <dt className="text-muted-foreground">Unit</dt>
              <dd>{step.config.unit}</dd>
            </>
          ) : null}
          {step.description ? (
            <>
              <dt className="text-muted-foreground">Description</dt>
              <dd className="whitespace-pre-wrap">{step.description}</dd>
            </>
          ) : null}
          {step.milestoneKey ? (
            <>
              <dt className="text-muted-foreground">Key</dt>
              <dd className="font-mono text-[11px]">{step.milestoneKey}</dd>
            </>
          ) : null}
        </dl>
        {active.length ? (
          <ul className="flex flex-wrap gap-1">
            {active.map((c) => (
              <li key={c.id} className="inline-flex h-6 items-center gap-1 rounded-full border px-2 text-xs">
                {FIELD_TYPE_META[step.fieldType].choicesHaveState ? <StateDot state={c.state ?? "NOT_STARTED"} /> : null}
                {c.label}
              </li>
            ))}
          </ul>
        ) : null}
        <p className="text-xs text-muted-foreground">
          {step.notInTemplate
            ? "This milestone is no longer in the template. Restore it from the Archive to edit it there, or mark it not applicable here."
            : "Comes from the template: change its name, type or choices in the Library, then Sync this project."}
        </p>
        {!step.notInTemplate && step.milestoneId ? (
          <Link
            href={`/library?tab=milestones&m=${encodeURIComponent(step.milestoneId)}`}
            className="inline-flex items-center gap-1 text-xs font-medium text-foreground underline-offset-4 hover:underline"
          >
            Edit in Library <ExternalLink className="size-3" aria-hidden />
          </Link>
        ) : null}
      </div>
    );
  }

  const others = view.steps
    .filter((s) => s.id !== step.id && FIELD_TYPE_META[s.fieldType].hasChoices)
    .map((s) => ({ id: s.id, name: s.name, fieldType: s.fieldType, choices: s.choices }));

  function effect(to: FieldType): React.ReactNode {
    if (step.value === null) return "No value is set yet, so nothing is lost.";
    const r = convertValue(step.fieldType, to, step.value, step.choices);
    if (r.ok) {
      const shown = formatValue({ fieldType: to, choices: step.choices, config: step.config }, r.value);
      return `The current value "${step.display}" is kept as "${shown}".`;
    }
    return `The current value "${step.display}" can't be converted, so it will be cleared. It stays in History.`;
  }

  function save(patch: DefPatch, clearValue = false) {
    // The editor already showed "…can't be converted, so it will be cleared" and the user pressed Change type:
    // don't ask a second time.
    const lossyType =
      patch.fieldType !== undefined &&
      patch.fieldType !== step.fieldType &&
      step.value !== null &&
      !convertValue(step.fieldType, patch.fieldType, step.value, patch.choices ?? step.choices).ok;
    void api.updateDefinition(step.id, patch, { clearValue: clearValue || lossyType, onNeedsClear: () => setAskClear(patch) });
  }

  return (
    <>
      <DefinitionEditor
        key={step.id}
        def={{ name: step.name, description: step.description, fieldType: step.fieldType, choices: step.choices, config: step.config }}
        onSave={(p) => save(p)}
        others={others}
        withStates
        readOnly={readOnly}
        typeChangeEffect={effect}
        descriptionPlaceholder="Optional notes on what this step means"
      />
      <ConfirmDialog
        open={askClear !== null}
        onOpenChange={(o) => {
          if (!o) setAskClear(null);
        }}
        title="Clear the value?"
        description={
          <p>
            &ldquo;{step.display}&rdquo; can&apos;t be converted to the new field type. Changing the type clears the value; the old value stays in
            History.
          </p>
        }
        confirmLabel="Change type and clear"
        destructive
        onConfirm={() => {
          const p = askClear;
          setAskClear(null);
          if (p) save(p, true);
        }}
      />
    </>
  );
}
