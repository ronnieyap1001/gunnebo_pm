import { CircleCheck, Info, OctagonAlert, TriangleAlert, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

type Tone = "problem" | "warning" | "success" | "info";

const TONES: Record<Tone, { cls: string; icon: LucideIcon; label: string }> = {
  problem: { cls: "state-b", icon: OctagonAlert, label: "Problem" },
  warning: { cls: "state-w", icon: TriangleAlert, label: "Note" },
  success: { cls: "state-d", icon: CircleCheck, label: "Done" },
  info: { cls: "state-ip", icon: Info, label: "Information" },
};

/** A tinted message box. Tone is shown by colour, icon and a hidden label (never colour alone). */
export function Notice({
  tone,
  title,
  children,
  action,
  className,
}: {
  tone: Tone;
  title?: React.ReactNode;
  children?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  const t = TONES[tone];
  const Icon = t.icon;
  return (
    <div
      role={tone === "problem" ? "alert" : undefined}
      className={cn(
        "flex gap-2.5 rounded-lg border border-[var(--s-border)] bg-[var(--s-bg)] px-3 py-2.5 text-sm",
        t.cls,
        className,
      )}
    >
      <Icon className="mt-0.5 size-4 shrink-0 text-[var(--s-solid)]" aria-hidden />
      <div className="min-w-0 flex-1 space-y-1">
        <span className="sr-only">{t.label}: </span>
        {title ? <p className="font-medium text-foreground">{title}</p> : null}
        {children ? <div className="text-foreground/85">{children}</div> : null}
      </div>
      {action ? <div className="flex shrink-0 items-start">{action}</div> : null}
    </div>
  );
}
