"use client";

import Link from "next/link";
import { useState } from "react";
import { Archive, BookOpen, CornerDownRight } from "lucide-react";
import type { FieldType, FlowEdge } from "@/domain/types";
import type { MilestoneRow } from "@/server/queries";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { SidePanel } from "@/components/shell/side-panel";
import { DefinitionEditor, type DefPatch, type OtherDef } from "@/components/library/definition-editor";
import { FieldTypeIcon } from "@/components/library/field-type-icon";
import { TypeChangeEffect } from "@/components/library/type-change";
import { ArchiveConfirmBody } from "./archive-confirm";
import { ArrowPicker } from "./arrow-picker";

/** Marks the panel body that takes the focus when the panel is opened from the keyboard. */
export const PANEL_BODY_ATTR = "data-template-panel-body";

/** Side panel for one template milestone: its definition, its arrows, Insert after and Archive. */
export function TemplatePanel({
  row,
  rows,
  rowsById,
  edges,
  onClose,
  onSave,
  onApplyChoicesTo,
  onAddEdge,
  onRemoveEdge,
  onInsertAfter,
  onArchive,
  onOpen,
}: {
  row: MilestoneRow;
  rows: MilestoneRow[];
  rowsById: Map<string, MilestoneRow>;
  edges: FlowEdge[];
  onClose: () => void;
  onSave: (patch: DefPatch) => void;
  onApplyChoicesTo: (targetIds: string[]) => void;
  onAddEdge: (from: string, to: string) => void;
  onRemoveEdge: (edge: FlowEdge) => void;
  onInsertAfter: () => void;
  onArchive: (reconnect: boolean) => void;
  onOpen: (id: string) => void;
}) {
  const [archiveOpen, setArchiveOpen] = useState(false);
  const others: OtherDef[] = rows
    .filter((r) => r.id !== row.id)
    .map((r) => ({ id: r.id, name: r.name, fieldType: r.fieldType, choices: r.choices }));
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
      footer={<span>Changes apply to new projects. Existing projects update when you Sync them.</span>}
    >
      <div className="space-y-6 p-4 outline-none" tabIndex={-1} {...{ [PANEL_BODY_ATTR]: "" }} aria-label={`Details of ${row.name}`} role="group">
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
          onSave={onSave}
          others={others}
          onApplyChoicesTo={onApplyChoicesTo}
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

        <section className="space-y-3 border-t pt-4" aria-label="Arrows in the template flow">
          <ArrowPicker
            direction="in"
            milestoneId={row.id}
            rows={rows}
            edges={edges}
            onAdd={(otherId) => onAddEdge(otherId, row.id)}
            onRemove={onRemoveEdge}
            onOpen={onOpen}
          />
          <ArrowPicker
            direction="out"
            milestoneId={row.id}
            rows={rows}
            edges={edges}
            onAdd={(otherId) => onAddEdge(row.id, otherId)}
            onRemove={onRemoveEdge}
            onOpen={onOpen}
          />
        </section>

        <div className="flex flex-wrap gap-2 border-t pt-4">
          <Button variant="outline" size="sm" onClick={onInsertAfter}>
            <CornerDownRight className="size-3.5" aria-hidden /> Insert after
          </Button>
          <Button asChild variant="ghost" size="sm">
            <Link href={`/library?m=${encodeURIComponent(row.id)}`}>
              <BookOpen className="size-3.5" aria-hidden /> Open in Library
            </Link>
          </Button>
          <Popover open={archiveOpen} onOpenChange={setArchiveOpen}>
            <PopoverTrigger asChild>
              <Button variant="destructive" size="sm" className="ml-auto">
                <Archive className="size-3.5" aria-hidden /> Archive
              </Button>
            </PopoverTrigger>
            <PopoverContent side="top" align="end" className="w-80">
              <ArchiveConfirmBody
                row={row}
                rowsById={rowsById}
                edges={edges}
                onCancel={() => setArchiveOpen(false)}
                onConfirm={(reconnect) => {
                  setArchiveOpen(false);
                  onArchive(reconnect);
                }}
              />
            </PopoverContent>
          </Popover>
        </div>
      </div>
    </SidePanel>
  );
}
