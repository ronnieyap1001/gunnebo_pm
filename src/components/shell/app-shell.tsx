"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useHotkeys } from "@/lib/hotkeys";
import { CommandPalette } from "./command-palette";
import { ShortcutOverlay } from "./shortcut-overlay";
import { Sidebar } from "./sidebar";
import type { BackupStatus } from "./backup-reminder";

interface ShellApi {
  openPalette: () => void;
  openShortcuts: () => void;
}

const ShellContext = createContext<ShellApi>({ openPalette: () => {}, openShortcuts: () => {} });

/** Open the command palette or the shortcut overlay from anywhere inside the app shell. */
export function useShell(): ShellApi {
  return useContext(ShellContext);
}

/** "G then …" destinations (Portfolio, pRojects, Library, Template, Archive, Settings). */
const GO_TO: Record<string, string> = {
  p: "/portfolio",
  r: "/projects",
  l: "/library",
  t: "/template",
  a: "/archive",
  s: "/settings",
};
const SEQUENCE_MS = 1200;

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    const type = (target as HTMLInputElement).type;
    return !["checkbox", "radio", "button", "submit", "reset", "range"].includes(type);
  }
  return Boolean(target.closest("[role='combobox'],[role='textbox'],[cmdk-input]"));
}

function anyDialogOpen(): boolean {
  return Boolean(
    document.querySelector("[role='dialog'][data-state='open'],[role='alertdialog'][data-state='open'],[role='menu'][data-state='open']"),
  );
}

/**
 * Client shell: sidebar, command palette (⌘K / Ctrl+K), "?" shortcut overlay and the "G then P/R/L/T" navigation keys.
 * Screen-level "?" handlers (Template, Library) win: the overlay only opens when no screen handled the key.
 */
export function AppShell({ backup, children }: { backup: BackupStatus | null; children: React.ReactNode }) {
  const router = useRouter();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  const openPalette = useCallback(() => {
    setShortcutsOpen(false);
    setPaletteOpen(true);
  }, []);
  const openShortcuts = useCallback(() => {
    setPaletteOpen(false);
    setShortcutsOpen(true);
  }, []);
  const api = useMemo(() => ({ openPalette, openShortcuts }), [openPalette, openShortcuts]);

  useHotkeys({
    "mod+k": (e) => {
      e.preventDefault();
      // Not on top of another dialog (a form, a running job): finish or close that first.
      if (!paletteOpen && !shortcutsOpen && anyDialogOpen()) return;
      setShortcutsOpen(false);
      setPaletteOpen((o) => !o);
    },
    "?": (e) => {
      if (paletteOpen || shortcutsOpen || anyDialogOpen()) return;
      // Let the screen's own "?" (e.g. Template Flow help) win: check once every listener has run.
      window.setTimeout(() => {
        if (!e.defaultPrevented && !anyDialogOpen()) setShortcutsOpen(true);
      }, 0);
    },
  });

  // "G" then a letter: capture phase, so the second key never reaches the screen's own single-key shortcuts.
  const gAt = useRef(0);
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.isComposing || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
      if (isTyping(e.target) || anyDialogOpen()) {
        gAt.current = 0;
        return;
      }
      const key = e.key.toLowerCase();
      if (gAt.current && Date.now() - gAt.current < SEQUENCE_MS) {
        gAt.current = 0;
        const dest = GO_TO[key];
        if (dest) {
          e.preventDefault();
          e.stopPropagation();
          router.push(dest);
        }
        return;
      }
      gAt.current = key === "g" && !e.shiftKey ? Date.now() : 0;
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [router]);

  return (
    <ShellContext.Provider value={api}>
      <div className="flex min-h-svh">
        <Sidebar backup={backup} />
        <div className="flex min-w-0 flex-1 flex-col">{children}</div>
      </div>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} onShowShortcuts={openShortcuts} />
      <ShortcutOverlay open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
    </ShellContext.Provider>
  );
}
