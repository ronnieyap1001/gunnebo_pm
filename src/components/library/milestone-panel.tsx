"use client";

import Link from "next/link";
import { Archive, ChevronDown, ChevronUp, Workflow } from "lucide-react";
import type { FieldType } from "@/domain/types";
import type { MilestoneRow } from "@/server/queries";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { SidePanel } from "@/components/shell/side-panel";
import { DefinitionEditor, type DefPatch, type OtherDef } from "./definition-editor";
import { FieldTypeIcon } from "./field-type-icon";
import { Kbd } from "./table-parts";
import { TypeChangeEffect } from "./type-change";

export function MilestonePanel({
  row,
  rowsById,
  others,
  onClose,
  validateName,
  onSave,
  onApplyChoicesTo,
  onArchive,
  onSelect,
  onStep,
  canStep,
}: {
  row: MilestoneRow | null;
  rowsById: Map<string, MilestoneRow>;
  others: OtherDef[];
  onClose: () => void;
  validateName: (row: MilestoneRow, name: string) => string | null;
  onSave: (row: MilestoneRow, patch: DefPatch) => void;
  onApplyChoicesTo: (row: MilestoneRow, targetIds: string[]) => void;
  onArchive: (row: MilestoneRow) => void;
  onSelect: (id: string) => void;
  onStep: (delta: number) => void;
  canStep: { prev: boolean; next: boolean };
}) {
  if (!row) return null;
  const usedLine = row.usedIn > 0 ? `Used in ${row.usedIn} project${row.usedIn === 1 ? "" : "s"}` : "Not used in any project yet";

  return (
    <SidePanel
      open
      onClose={onClose}
      title={
        <span className="flex items-start gap-2">
          {row.seq !== null ? <span className="mt-px shrink-0 text-xs font-normal text-muted-foreground tabular-nums">#{row.seq}</span> : null}
          <span className="min-w-0">{row.name}</span>
        </span>
      }
      subtitle={
        <span className="inline-flex items-center gap-1.5">
          <FieldTypeIcon type={row.fieldType} className="size-3" />
          {row.fieldTypeLabel} · {usedLine}
        </span>
      }
      headerExtra={
        <div className="flex items-center">
          <StepButton label="Previous milestone" keyHint="K" disabled={!canStep.prev} onClick={() => onStep(-1)}>
            <ChevronUp className="size-4" />
          </StepButton>
          <StepButton label="Next milestone" keyHint="J" disabled={!canStep.next} onClick={() => onStep(1)}>
            <ChevronDown className="size-4" />
          </StepButton>
        </div>
      }
      footer={<span>Changes apply to new projects. Existing projects update when you Sync them.</span>}
    >
      <div className="space-y-6 p-4">
        <DefinitionEditor
          key={row.id}
          def={{
            name: row.name,
            description: row.description,
            fieldType: row.fieldType,
            choices: row.choices,
            config: row.config,
            key: row.key,
          }}
          onSave={(patch) => onSave(row, patch)}
          validateName={(name) => validateName(row, name)}
          others={others}
          onApplyChoicesTo={(ids) => onApplyChoicesTo(row, ids)}
          typeChangeEffect={(to: FieldType) => (
            <TypeChangeEffect
              from={row.fieldType}
              to={to}
              kind="milestone"
              usedIn={row.usedIn}
              choiceCount={row.choices.filter((c) => !c.archived).length}
            />
          )}
        />

        <section className="space-y-2" aria-label="Position in the template flow">
          <div className="text-xs font-medium">In the template flow</div>
          <FlowLinks label="Comes after" ids={row.predecessors} rowsById={rowsById} onSelect={onSelect} />
          <FlowLinks label="Leads to" ids={row.successors} rowsById={rowsById} onSelect={onSelect} />
        </section>

        <div className="flex flex-wrap gap-2 border-t pt-4">
          <Button asChild variant="outline" size="sm">
            <Link href={`/template?m=${encodeURIComponent(row.id)}`}>
              <Workflow className="size-3.5" aria-hidden /> Show in Template Flow
            </Link>
          </Button>
          <Button variant="destructive" size="sm" onClick={() => onArchive(row)}>
            <Archive className="size-3.5" aria-hidden /> Archive
          </Button>
        </div>
      </div>
    </SidePanel>
  );
}

function StepButton({
  label,
  keyHint,
  disabled,
  onClick,
  children,
}: {
  label: string;
  keyHint: string;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" className="size-7" aria-label={`${label} (${keyHint})`} disabled={disabled} onClick={onClick}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {label} <Kbd className="border-background/30 bg-background/20 text-background">{keyHint}</Kbd>
      </TooltipContent>
    </Tooltip>
  );
}

function FlowLinks({
  label,
  ids,
  rowsById,
  onSelect,
}: {
  label: string;
  ids: string[];
  rowsById: Map<string, MilestoneRow>;
  onSelect: (id: string) => void;
}) {
  const items = ids.map((id) => rowsById.get(id)).filter((r): r is MilestoneRow => Boolean(r));
  return (
    <div className="flex items-start gap-2 text-xs">
      <span className="w-20 shrink-0 pt-0.5 text-muted-foreground">{label}</span>
      {items.length === 0 ? (
        <span className="pt-0.5 text-muted-foreground italic">Nothing (no arrow)</span>
      ) : (
        <div className="flex min-w-0 flex-wrap gap-1">
          {items.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => onSelect(m.id)}
              className="max-w-full truncate rounded-md border bg-background px-1.5 py-0.5 text-left hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
              title={`Open ${m.name}`}
            >
              {m.seq !== null ? <span className="mr-1 text-muted-foreground tabular-nums">#{m.seq}</span> : null}
              {m.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
