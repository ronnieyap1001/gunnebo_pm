"use client";

import { Fragment } from "react";
import { usePathname } from "next/navigation";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Kbd } from "./kbd";
import { isCurrentSection, sectionsFor, type ShortcutRow, type ShortcutSection } from "./shortcuts";
import { useIsMac } from "./use-now";

function Keys({ row, mac }: { row: ShortcutRow; mac: boolean }) {
  const sep = row.join === "then" ? "then" : row.join === "or" ? "or" : null;
  return (
    <span className="flex flex-wrap items-center gap-1">
      {row.keys.map((group, i) => (
        <Fragment key={i}>
          {i > 0 && sep ? <span className="text-[11px] text-muted-foreground">{sep}</span> : null}
          <span className="inline-flex items-center gap-0.5">
            {group.map((k, j) => (
              <Kbd key={j} className="h-5 min-w-5 text-[11px]">
                {k === "mod" ? (mac ? "⌘" : "Ctrl") : k}
              </Kbd>
            ))}
          </span>
        </Fragment>
      ))}
    </span>
  );
}

/** Splits the sections into columns of similar height, keeping their order within each column. */
function balance(sections: ShortcutSection[], n: number): ShortcutSection[][] {
  const cols: ShortcutSection[][] = Array.from({ length: n }, () => []);
  const height = new Array<number>(n).fill(0);
  for (const s of sections) {
    const i = height.indexOf(Math.min(...height));
    cols[i].push(s);
    height[i] += s.rows.length + 2;
  }
  return cols;
}

/** "?" overlay: every shortcut of every screen, the current screen first. */
export function ShortcutOverlay({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const pathname = usePathname() ?? "/";
  const mac = useIsMac();
  const sections = sectionsFor(pathname);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88svh] overflow-y-auto sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            Single keys work when you are not typing in a box. Press <Kbd>?</Kbd> any time to see this list.
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-1 gap-x-8 lg:grid-cols-3">
          {balance(sections, 3).map((column, ci) => (
            <div key={ci} className="min-w-0">
              {column.map((s) => {
                const here = isCurrentSection(s, pathname);
                return (
                  <section key={s.id} className="mb-5" aria-labelledby={`sc-${s.id}`}>
                    <h3
                      id={`sc-${s.id}`}
                      className="mb-2 flex items-center gap-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase"
                    >
                      {s.title}
                      {here ? (
                        <span className="rounded-full bg-accent px-1.5 py-0.5 text-[10px] font-medium tracking-normal text-accent-foreground normal-case">
                          This screen
                        </span>
                      ) : null}
                    </h3>
                    <dl className="grid grid-cols-[minmax(84px,auto)_1fr] items-center gap-x-3 gap-y-1 text-[13px]">
                      {s.rows.map((row) => (
                        <div key={row.what} className="contents">
                          <dt>
                            <Keys row={row} mac={mac} />
                          </dt>
                          <dd className="text-muted-foreground">{row.what}</dd>
                        </div>
                      ))}
                    </dl>
                  </section>
                );
              })}
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
