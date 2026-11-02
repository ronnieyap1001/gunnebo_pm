import { Circle, CircleCheck, CircleDot, Clock, MinusCircle, OctagonAlert, type LucideIcon } from "lucide-react";
import { STATE_META } from "@/domain/state";
import type { State } from "@/domain/types";
import { STATES } from "@/domain/types";
import { cn } from "@/lib/utils";

/** CSS class that sets --s-solid/--s-bg/--s-border/--s-fg for a state (see globals.css). */
export function stateClass(state: State): string {
  return `state-${STATE_META[state].code.toLowerCase()}`;
}

export const STATE_ICONS: Record<State, LucideIcon> = {
  NOT_STARTED: Circle,
  IN_PROGRESS: CircleDot,
  WAITING: Clock,
  BLOCKED: OctagonAlert,
  DONE: CircleCheck,
  NOT_APPLICABLE: MinusCircle,
};

export function StateIcon({ state, className }: { state: State; className?: string }) {
  const Icon = STATE_ICONS[state];
  return <Icon aria-hidden className={cn("size-3.5 shrink-0 text-[var(--s-solid)]", stateClass(state), className)} />;
}

export function StateDot({ state, className, title }: { state: State; className?: string; title?: string }) {
  return (
    <span
      title={title ?? STATE_META[state].label}
      className={cn(
        "inline-block size-2.5 shrink-0 rounded-full bg-[var(--s-solid)]",
        state === "NOT_APPLICABLE" && "border border-dashed border-[var(--s-border)] bg-transparent",
        stateClass(state),
        className,
      )}
    >
      <span className="sr-only">{STATE_META[state].label}</span>
    </span>
  );
}

export function StateBadge({ state, className, compact }: { state: State; className?: string; compact?: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center gap-1 rounded-full border border-[var(--s-border)] bg-[var(--s-bg)] px-1.5 text-[11px] font-medium text-[var(--s-fg)]",
        state === "NOT_APPLICABLE" && "border-dashed",
        stateClass(state),
        className,
      )}
    >
      <StateIcon state={state} className="size-3" />
      {compact ? <span className="sr-only">{STATE_META[state].label}</span> : STATE_META[state].label}
    </span>
  );
}

export function StateLegend({ className }: { className?: string }) {
  return (
    <div className={cn("flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground", className)}>
      {STATES.map((s) => (
        <span key={s} className="inline-flex items-center gap-1">
          <StateDot state={s} />
          {STATE_META[s].label}
        </span>
      ))}
      <span className="inline-flex items-center gap-1">
        <span className="inline-block size-2.5 rounded-full ring-2 ring-[var(--current-ring)]" />
        Current
      </span>
    </div>
  );
}
