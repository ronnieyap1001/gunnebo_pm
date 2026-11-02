import { cn } from "@/lib/utils";

/** What a percent box says when the typed text can't be saved ("12,5" and "12.5" are fine: they save 13). */
export const PERCENT_HINT = "Enter a number from 0 to 100.";

/**
 * The line that says why what was typed in a box can't be saved. role="alert": a screen reader announces it as soon as
 * it appears. The box points at it with `hintedBy(id, shown)`, so the reason is read again whenever the box gets focus.
 */
export function InputHint({ id, className, children }: { id: string; className?: string; children: React.ReactNode }) {
  return (
    <p id={id} role="alert" className={cn("text-xs text-destructive", className)}>
      {children}
    </p>
  );
}

/** aria-invalid and aria-describedby for a box while its InputHint (with this id) is shown. */
export function hintedBy(id: string, shown: boolean): { "aria-invalid"?: true; "aria-describedby"?: string } {
  return shown ? { "aria-invalid": true, "aria-describedby": id } : {};
}
