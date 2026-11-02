import { CircleCheck, CirclePause, CirclePlay, type LucideIcon } from "lucide-react";
import type { ProjectStatus } from "@/domain/types";
import { cn } from "@/lib/utils";

export const PROJECT_STATUS_OPTIONS: { id: ProjectStatus; label: string }[] = [
  { id: "ACTIVE", label: "Active" },
  { id: "ON_HOLD", label: "On hold" },
  { id: "CLOSED", label: "Closed" },
];

const META: Record<ProjectStatus, { label: string; icon: LucideIcon; tone: string }> = {
  ACTIVE: { label: "Active", icon: CirclePlay, tone: "state-ip" },
  ON_HOLD: { label: "On hold", icon: CirclePause, tone: "state-w" },
  CLOSED: { label: "Closed", icon: CircleCheck, tone: "state-ns" },
};

/** Project status (Active / On hold / Closed): icon + text, tinted with the state tokens (works in both themes). */
export function StatusPill({ status, className }: { status: ProjectStatus; className?: string }) {
  const m = META[status] ?? META.ACTIVE;
  const Icon = m.icon;
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center gap-1 rounded-full border border-[var(--s-border)] bg-[var(--s-bg)] px-1.5 text-[11px] font-medium whitespace-nowrap text-[var(--s-fg)]",
        m.tone,
        className,
      )}
    >
      <Icon className="size-3 shrink-0" aria-hidden />
      {m.label}
    </span>
  );
}

/** "% done" mini bar with the number. */
export function ProgressMini({
  pct,
  done,
  applicable,
  className,
  barClassName,
}: {
  pct: number;
  done: number;
  applicable: number;
  className?: string;
  barClassName?: string;
}) {
  const clamped = Math.max(0, Math.min(100, Math.round(pct)));
  return (
    <span className={cn("inline-flex items-center gap-1.5", className)} title={`${done} of ${applicable} milestones done`}>
      <span className={cn("relative h-1.5 w-12 shrink-0 overflow-hidden rounded-full bg-muted", barClassName)} aria-hidden>
        <span className="state-d absolute inset-y-0 left-0 rounded-full bg-[var(--s-solid)]" style={{ width: `${clamped}%` }} />
      </span>
      <span className="w-8 text-right text-xs tabular-nums">
        {clamped}
        <span className="text-muted-foreground"> %</span>
      </span>
      <span className="sr-only">
        , {done} of {applicable} milestones done
      </span>
    </span>
  );
}
