"use client";

import { useHotkeys, type HotkeyMap } from "@/lib/hotkeys";

/**
 * True while a dialog, popover, alert or menu is open. The project page's single-key shortcuts must not act on the
 * page underneath it (e.g. J moving to another milestone while "Clear the value?" asks about this one).
 */
export function layerOpen(): boolean {
  if (typeof document === "undefined") return false;
  return Boolean(
    document.querySelector("[role='dialog'][data-state='open'],[role='alertdialog'][data-state='open'],[role='menu'][data-state='open']"),
  );
}

/** `useHotkeys` for the project page: every handler is skipped while a dialog, popover or menu is open. */
export function useProjectHotkeys(map: HotkeyMap, enabled = true): void {
  const guarded: HotkeyMap = {};
  for (const [combo, handler] of Object.entries(map)) {
    guarded[combo] = (e) => {
      if (layerOpen()) return;
      handler(e);
    };
  }
  useHotkeys(guarded, enabled);
}
