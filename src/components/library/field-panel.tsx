"use client";

import Link from "next/link";
import { Archive, Lock, TriangleAlert, X } from "lucide-react";
import type { FieldType } from "@/domain/types";
import { FIELD_TYPES } from "@/domain/types";
import { FIELD_TYPE_META } from "@/domain/fieldTypes";
import type { ProjectFieldRow } from "@/server/queries";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { SidePanel } from "@/components/shell/side-panel";
import { DefinitionEditor, type DefPatch } from "./definition-editor";
import { FieldTypeIcon } from "./field-type-icon";
import { TypeChangeEffect } from "./type-change";

export interface BlockingProject {
  projectId: string;
  code: string;
  reason: string;
}

export interface TypeBlock {
  to: FieldType;
  message: string;
  blocking: BlockingProject[];
}

/** Project fields can be any type but File. System fields only switch between Dropdown and Multiple. */
export const FIELD_TYPES_FOR_FIELDS: FieldType[] = FIELD_TYPES.filter((t) => t !== "FILE");
export const SYSTEM_FIELD_TYPES: FieldType[] = ["DROPDOWN", "MULTIPLE"];
export const SYSTEM_FIELD_NOTE =
  "Used by the Portfolio filters: it can be renamed and its choices edited, and switch between Dropdown and Multiple, but it can't be archived.";

export function FieldPanel({
  row,
  block,
  onDismissBlock,
  onClose,
  validateName,
  onSave,
  onToggleSummary,
  onArchive,
}: {
  row: ProjectFieldRow | null;
  block: TypeBlock | null;
  onDismissBlock: () => void;
  onClose: () => void;
  validateName: (row: ProjectFieldRow, label: string) => string | null;
  onSave: (row: ProjectFieldRow, patch: DefPatch) => void;
  onToggleSummary: (row: ProjectFieldRow, on: boolean) => void;
  onArchive: (row: ProjectFieldRow) => void;
}) {
  if (!row) return null;
  const system = row.systemKey !== null;
  const usedLine = row.usedIn > 0 ? `${row.usedIn} project${row.usedIn === 1 ? " has a value" : "s have a value"}` : "No values yet";

  return (
    <SidePanel
      open
      onClose={onClose}
      title={
        <span className="flex items-center gap-2">
          <span className="min-w-0 truncate">{row.label}</span>
          {system ? (
            <Badge variant="outline" className="h-5 gap-1 px-1.5 text-[11px] font-medium text-muted-foreground">
              <Lock aria-hidden className="size-3" /> System
            </Badge>
          ) : null}
        </span>
      }
      subtitle={
        <span className="inline-flex items-center gap-1.5">
          <FieldTypeIcon type={row.fieldType} className="size-3" />
          {row.fieldTypeLabel} · {usedLine}
        </span>
      }
      footer={<span>Project details use the field directly: renames and new choices show in every project at once.</span>}
    >
      <div className="space-y-6 p-4">
        {block ? (
          <div role="alert" className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs">
            <div className="flex items-start gap-2">
              <TriangleAlert aria-hidden className="mt-px size-4 shrink-0 text-destructive" />
              <div className="min-w-0 flex-1 space-y-1">
                <div className="font-medium text-foreground">Can&apos;t change to {FIELD_TYPE_META[block.to].label}</div>
                <p className="text-muted-foreground">{block.message}</p>
              </div>
              <Button variant="ghost" size="icon" className="size-6 shrink-0" aria-label="Dismiss" onClick={onDismissBlock}>
                <X className="size-3.5" />
              </Button>
            </div>
            {block.blocking.length ? (
              <ul className="max-h-48 space-y-1 overflow-y-auto pl-6">
                {block.blocking.map((b) => (
                  <li key={b.projectId} className="flex gap-2">
                    <Link
                      href={`/projects/${encodeURIComponent(b.projectId)}`}
                      className="shrink-0 font-medium text-foreground underline underline-offset-2 hover:no-underline"
                    >
                      {b.code}
                    </Link>
                    <span className="text-muted-foreground">{b.reason}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}

        <DefinitionEditor
          key={row.id}
          def={{ name: row.label, description: "", fieldType: row.fieldType, choices: row.choices, config: row.config, key: row.key }}
          onSave={(patch) => onSave(row, patch)}
          validateName={(label) => validateName(row, label)}
          withStates={false}
          withDescription={false}
          nameLabel="Label"
          fieldTypes={system ? SYSTEM_FIELD_TYPES : FIELD_TYPES_FOR_FIELDS}
          typeHint={system ? SYSTEM_FIELD_NOTE : undefined}
          typeChangeEffect={(to) => (
            <TypeChangeEffect
              from={row.fieldType}
              to={to}
              kind="field"
              usedIn={row.usedIn}
              choiceCount={row.choices.filter((c) => !c.archived).length}
            />
          )}
        />

        <div className="flex items-start justify-between gap-3 rounded-md border p-3">
          <div className="space-y-0.5">
            <Label htmlFor="field-summary">Shown in summary</Label>
            <p className="text-xs text-muted-foreground">In the project header line and as a column in the Projects table.</p>
          </div>
          <Switch id="field-summary" checked={row.showInSummary} onCheckedChange={(on) => onToggleSummary(row, on)} />
        </div>

        <div className="border-t pt-4">
          {system ? (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Lock aria-hidden className="size-3.5" /> System fields can&apos;t be archived.
            </p>
          ) : (
            <Button variant="destructive" size="sm" onClick={() => onArchive(row)}>
              <Archive className="size-3.5" aria-hidden /> Archive field
            </Button>
          )}
        </div>
      </div>
    </SidePanel>
  );
}
