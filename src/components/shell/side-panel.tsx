"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

const MIN = 320;
const MAX = 560;
const DEFAULT = 400;
const KEY = "gpm.sidepanel.width";

/**
 * Right-docked, non-modal, resizable panel. Esc closes it (unless focus is in a text field that handles Esc).
 * On screens narrower than 1280 px it overlays the content instead of pushing it aside.
 */
export function SidePanel({
  open,
  onClose,
  title,
  subtitle,
  headerExtra,
  children,
  footer,
  className,
}: {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  headerExtra?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
}) {
  const [width, setWidth] = useState(DEFAULT);
  const dragging = useRef(false);

  useEffect(() => {
    try {
      const stored = Number(window.localStorage.getItem(KEY));
      if (stored >= MIN && stored <= MAX) setWidth(stored);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "TEXTAREA" || (t.tagName === "INPUT" && (t as HTMLInputElement).value))) return;
      onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    dragging.current = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, []);
  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return;
    const next = Math.min(MAX, Math.max(MIN, window.innerWidth - e.clientX));
    setWidth(next);
  }, []);
  const onPointerUp = useCallback(() => {
    dragging.current = false;
    try {
      window.localStorage.setItem(KEY, String(width));
    } catch {
      /* ignore */
    }
  }, [width]);

  if (!open) return null;

  return (
    <aside
      role="complementary"
      aria-label="Details"
      style={{ width }}
      className={cn(
        "relative flex h-full shrink-0 flex-col border-l bg-background",
        "max-[1279px]:absolute max-[1279px]:inset-y-0 max-[1279px]:right-0 max-[1279px]:z-30 max-[1279px]:shadow-xl",
        className,
      )}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panel"
        className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      />
      <div className="flex items-start gap-2 border-b px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold leading-snug">{title}</div>
          {subtitle ? <div className="mt-0.5 text-xs text-muted-foreground">{subtitle}</div> : null}
        </div>
        {headerExtra}
        <Button variant="ghost" size="icon" className="size-7" onClick={onClose} aria-label="Close panel">
          <X className="size-4" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      {footer ? <div className="border-t px-4 py-2 text-xs text-muted-foreground">{footer}</div> : null}
    </aside>
  );
}
