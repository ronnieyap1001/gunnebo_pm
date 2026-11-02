"use client";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Kbd } from "./kbd";

const SHORTCUTS: [string[], string][] = [
  [["N"], "New milestone (in the middle of the screen)"],
  [["L"], "Auto-layout menu"],
  [["F"], "Fit the whole chart"],
  [["Tab"], "Move between milestones and arrows on the chart"],
  [["Enter"], "Open the focused milestone (or pick the focused arrow)"],
  [["Delete", "⌫"], "Archive the selected milestone, or delete the selected arrow"],
  [["←", "→", "↑", "↓"], "Nudge the selected milestone"],
  [["Shift", "drag"], "Select several milestones to move them together"],
  [["Esc"], "Close the panel / clear the selected arrow"],
  [["?"], "Show these shortcuts"],
];

const MOUSE: [string, string][] = [
  ["Drag from a dot to another milestone", "Draw an arrow"],
  ["Drag from a right dot onto empty space", "New milestone right after that one"],
  ["Drag from a left dot onto empty space", "New milestone with an arrow into that one"],
  ["Double-click empty space", "New milestone at that spot"],
  ["Click an arrow, or hover it and press ×", "Delete the arrow"],
  ["Right-click a milestone", "Insert after, Archive"],
];

export function ShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Keyboard and mouse</DialogTitle>
          <DialogDescription>Template Flow</DialogDescription>
        </DialogHeader>
        <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 text-[13px]">
          {SHORTCUTS.map(([keys, what]) => (
            <div key={what} className="contents">
              <dt className="flex items-center gap-1">
                {keys.map((k) => (
                  <Kbd key={k} className="h-5 min-w-5 text-[11px]">
                    {k}
                  </Kbd>
                ))}
              </dt>
              <dd className="text-muted-foreground">{what}</dd>
            </div>
          ))}
        </dl>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 border-t pt-3 text-[13px]">
          {MOUSE.map(([how, what]) => (
            <div key={how} className="contents">
              <dt>{how}</dt>
              <dd className="text-muted-foreground">{what}</dd>
            </div>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  );
}
