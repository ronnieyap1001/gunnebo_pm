"use client";

import { useEffect, useState } from "react";
import { Clock, OctagonAlert, Pin } from "lucide-react";
import type { NodeFlag } from "@/domain/types";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { stateClass } from "@/components/state/state-badge";
import { useProject } from "./context";
import type { StepView } from "./types";

const OPTIONS: { value: NodeFlag | null; label: string; icon: typeof Pin | null }[] = [
  { value: null, label: "None", icon: null },
  { value: "WAITING", label: "Waiting", icon: Clock },
  { value: "BLOCKED", label: "Blocked", icon: OctagonAlert },
];

/**
 * Waiting / Blocked flag. It overrides the value's colour (only N/A ranks above it). Picking a flag asks for an
 * optional reason, which is saved as a note; "None" clears it at once.
 */
export function StepFlag({ step }: { step: StepView }) {
  const { api, readOnly } = useProject();
  const [asking, setAsking] = useState<NodeFlag | null>(null);
  const [reason, setReason] = useState("");
  useEffect(() => {
    setAsking(null);
    setReason("");
  }, [step.id]);

  function pick(v: NodeFlag | null) {
    if (v === null) {
      setAsking(null);
      if (step.flag) void api.setFlag(step.id, null);
      return;
    }
    if (v === step.flag) return;
    setAsking(v);
  }

  function save() {
    if (!asking) return;
    void api.setFlag(step.id, asking, reason);
    setAsking(null);
    setReason("");
  }

  return (
    <div className="space-y-2">
      <div role="radiogroup" aria-label="Flag" className="inline-flex rounded-md border p-0.5">
        {OPTIONS.map((o) => {
          const active = (asking ?? step.flag ?? null) === o.value;
          const Icon = o.icon;
          const cls = o.value === "WAITING" ? stateClass("WAITING") : o.value === "BLOCKED" ? stateClass("BLOCKED") : "";
          return (
            <button
              key={o.label}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={readOnly}
              onClick={() => pick(o.value)}
              className={cn(
                cls,
                "inline-flex h-7 items-center gap-1 rounded px-2.5 text-xs font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50",
                active
                  ? o.value
                    ? "bg-[var(--s-bg)] text-[var(--s-fg)] ring-1 ring-[var(--s-border)]"
                    : "bg-muted text-foreground"
                  : "text-muted-foreground hover:bg-muted/60",
              )}
            >
              {Icon ? <Icon className="size-3.5 text-[var(--s-solid)]" aria-hidden /> : null}
              {o.label}
            </button>
          );
        })}
      </div>
      {asking ? (
        <form
          className="space-y-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <Input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            autoFocus
            placeholder={asking === "BLOCKED" ? "What blocks it? (optional, saved as a note)" : "Waiting for what? (optional, saved as a note)"}
            aria-label="Reason (optional)"
            className="h-8"
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                setAsking(null);
              }
            }}
          />
          <div className="flex justify-end gap-1">
            <Button type="button" size="xs" variant="ghost" onClick={() => setAsking(null)}>
              Cancel
            </Button>
            <Button type="submit" size="xs">
              Flag as {asking === "BLOCKED" ? "Blocked" : "Waiting"}
            </Button>
          </div>
        </form>
      ) : step.flag ? (
        <p className="text-xs text-muted-foreground">The flag overrides the value&apos;s colour until you remove it or the milestone is done.</p>
      ) : null}
    </div>
  );
}
