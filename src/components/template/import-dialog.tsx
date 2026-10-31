"use client";

import { useState } from "react";
import { FileWarning, Info, Loader2 } from "lucide-react";
import type { ImportSummary } from "@/app/(app)/template/actions";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export type ImportPreview =
  | { kind: "summary"; fileName: string; summary: ImportSummary }
  | { kind: "problems"; fileName: string; message: string; problems: string[] };

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function isEmpty(s: ImportSummary): boolean {
  return (
    !s.added.length &&
    !s.updated.length &&
    !s.archived.length &&
    !s.choiceChanges.length &&
    !s.edgesAdded &&
    !s.edgesRemoved &&
    !s.projectFieldsAdded.length &&
    !s.projectFieldsUpdated.length
  );
}

/** One line of the summary with the names behind it (first few, then "Show all"). */
function SummaryRow({ label, items, tone }: { label: string; items: string[]; tone?: "warn" }) {
  const [all, setAll] = useState(false);
  if (!items.length) return null;
  const shown = all ? items : items.slice(0, 6);
  return (
    <li className="space-y-1">
      <div className={tone === "warn" ? "font-medium text-[var(--state-w-fg)]" : "font-medium"}>{label}</div>
      <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
        {shown.map((name, i) => (
          <li key={`${i}-${name}`} className="break-words">
            {name}
          </li>
        ))}
      </ul>
      {items.length > shown.length ? (
        <button type="button" className="pl-5 text-xs text-primary underline-offset-2 hover:underline" onClick={() => setAll(true)}>
          Show all {items.length}
        </button>
      ) : null}
    </li>
  );
}

/** Preview of a template import: what changes, the safety note, Import / Cancel (or the file's problems). */
export function ImportDialog({
  preview,
  pending,
  onCancel,
  onConfirm,
}: {
  preview: ImportPreview | null;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const open = preview !== null;
  return (
    <Dialog open={open} onOpenChange={(o) => !o && !pending && onCancel()}>
      <DialogContent className="sm:max-w-lg">
        {preview?.kind === "problems" ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <FileWarning className="size-4 text-destructive" aria-hidden />
                “{preview.fileName}” can’t be imported
              </DialogTitle>
              <DialogDescription>{preview.message}</DialogDescription>
            </DialogHeader>
            {preview.problems.length ? (
              <ul className="max-h-64 list-disc space-y-1 overflow-y-auto pl-5 text-xs text-muted-foreground">
                {preview.problems.slice(0, 20).map((p, i) => (
                  <li key={`${i}-${p}`} className="break-words">
                    {p}
                  </li>
                ))}
                {preview.problems.length > 20 ? <li>and {preview.problems.length - 20} more</li> : null}
              </ul>
            ) : null}
            <p className="text-xs text-muted-foreground">Nothing was changed. Choose a template file exported from Gunnebo PM (Export JSON).</p>
            <DialogFooter>
              <Button onClick={onCancel}>Close</Button>
            </DialogFooter>
          </>
        ) : preview?.kind === "summary" ? (
          <>
            <DialogHeader>
              <DialogTitle>Import “{preview.fileName}”?</DialogTitle>
              <DialogDescription>The file replaces the current template. This is what changes:</DialogDescription>
            </DialogHeader>
            {isEmpty(preview.summary) ? (
              <p className="rounded-md border bg-muted/40 p-3 text-sm">This file matches the current template. Nothing would change.</p>
            ) : (
              <ul className="max-h-[50vh] space-y-3 overflow-y-auto pr-1 text-sm">
                <SummaryRow label={`${plural(preview.summary.added.length, "milestone")} added`} items={preview.summary.added} />
                <SummaryRow label={`${plural(preview.summary.updated.length, "milestone")} updated`} items={preview.summary.updated} />
                <SummaryRow
                  label={`${plural(preview.summary.archived.length, "milestone")} archived (not in the file; you can restore them from the Archive)`}
                  items={preview.summary.archived}
                  tone="warn"
                />
                <SummaryRow label={`Choice changes in ${plural(preview.summary.choiceChanges.length, "milestone")}`} items={preview.summary.choiceChanges} />
                {preview.summary.edgesAdded || preview.summary.edgesRemoved ? (
                  <li>
                    <div className="font-medium">Arrows</div>
                    <div className="text-xs text-muted-foreground">
                      {plural(preview.summary.edgesAdded, "arrow")} added · {plural(preview.summary.edgesRemoved, "arrow")} removed
                    </div>
                  </li>
                ) : null}
                <SummaryRow label={`${plural(preview.summary.projectFieldsAdded.length, "project field")} added`} items={preview.summary.projectFieldsAdded} />
                <SummaryRow label={`${plural(preview.summary.projectFieldsUpdated.length, "project field")} updated`} items={preview.summary.projectFieldsUpdated} />
              </ul>
            )}
            <div className="flex gap-2 rounded-md border bg-muted/40 p-2.5 text-xs text-muted-foreground">
              <Info className="mt-px size-3.5 shrink-0" aria-hidden />
              <p>
                A snapshot of the current template is saved first, so you can go back. Projects are not changed until you Sync them.
              </p>
            </div>
            <DialogFooter>
              <Button variant="outline" disabled={pending} onClick={onCancel}>
                Cancel
              </Button>
              <Button disabled={pending || isEmpty(preview.summary)} onClick={onConfirm} autoFocus={!isEmpty(preview.summary)}>
                {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
                {pending ? "Starting…" : "Import and replace"}
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
