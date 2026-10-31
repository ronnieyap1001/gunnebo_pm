"use client";

import { useEffect, useRef } from "react";

/**
 * Keyboard shortcuts. Keys are matched on `event.key` (case-insensitive for letters).
 * Prefix with "mod+" for Cmd (Mac) / Ctrl (others), e.g. "mod+k". Plain keys never fire while a modifier is held,
 * while typing in an input, textarea, select or contenteditable, or during IME composition.
 */
export type HotkeyMap = Record<string, (e: KeyboardEvent) => void>;

function isTypingTarget(target: EventTarget | null): boolean {
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

export function matchHotkey(e: KeyboardEvent, combo: string): boolean {
  const parts = combo.toLowerCase().split("+");
  const key = parts.pop()!;
  const wantMod = parts.includes("mod");
  const wantShift = parts.includes("shift");
  const wantAlt = parts.includes("alt");
  const mod = e.metaKey || e.ctrlKey;
  if (wantMod !== mod) return false;
  if (wantAlt !== e.altKey) return false;
  // Shift is implied for characters like "?"; only enforce when declared.
  if (wantShift && !e.shiftKey) return false;
  return e.key.toLowerCase() === key;
}

export function useHotkeys(map: HotkeyMap, enabled = true): void {
  const ref = useRef(map);
  ref.current = map;
  useEffect(() => {
    if (!enabled) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.isComposing || e.defaultPrevented) return;
      for (const [combo, handler] of Object.entries(ref.current)) {
        const hasModifier = /(^|\+)(mod|alt)\+/.test(combo.toLowerCase());
        if (!hasModifier && (e.metaKey || e.ctrlKey || e.altKey)) continue;
        if (!hasModifier && combo.toLowerCase() !== "escape" && isTypingTarget(e.target)) continue;
        if (matchHotkey(e, combo)) {
          handler(e);
          return;
        }
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled]);
}
