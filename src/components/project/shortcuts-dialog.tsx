"use client";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Kbd } from "./kbd";

const GROUPS: { title: string; keys: [string[], string][] }[] = [
  {
    title: "Anywhere on the project",
    keys: [
      [["V"], "Switch between Flow and List"],
      [["H"], "History"],
      [["?"], "This list"],
      [["Esc"], "Close the panel or dialog"],
    ],
  },
  {
    title: "Flow",
    keys: [
      [["F"], "Fit the whole chart"],
      [["C"], "Go to the current milestones"],
      [["L"], "Auto-layout (with Undo)"],
      [["E"], "Edit arrows on / off"],
      [["Tab"], "Move to the next card"],
      [["Enter"], "Open the focused card"],
      [["Del"], "Archive a project-only step (with Undo)"],
    ],
  },
  {
    title: "Milestone panel",
    keys: [
      [["J"], "Next milestone in flow order (first one if none is open)"],
      [["K"], "Previous milestone"],
      [["X"], "Not applicable on / off"],
      [["N"], "Write a note"],
      [["1", "–", "9"], "Pick a dropdown choice"],
      [["Ctrl", "Enter"], "Add the note"],
    ],
  },
  {
    title: "List",
    keys: [
      [["↑", "↓"], "Move between rows (or J / K)"],
      [["Enter"], "Edit the value"],
      [["Tab"], "Save and edit the next row's value"],
      [["Esc"], "Cancel editing"],
      [["X"], "Not applicable on / off"],
      [["N"], "Add a note"],
      [["O"], "Open the panel"],
      [["Space"], "Select the row"],
    ],
  },
];

export function ShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>Shortcuts don&apos;t fire while you type in a field.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          {GROUPS.map((g) => (
            <section key={g.title} aria-label={g.title}>
              <h3 className="mb-1.5 text-xs font-semibold text-muted-foreground uppercase">{g.title}</h3>
              <dl className="space-y-1 text-sm">
                {g.keys.map(([keys, what]) => (
                  <div key={what} className="flex items-center justify-between gap-3">
                    <dt className="text-muted-foreground">{what}</dt>
                    <dd className="flex shrink-0 gap-0.5">
                      {keys.map((k) => (k === "–" ? <span key={k}>–</span> : <Kbd key={k}>{k}</Kbd>))}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
