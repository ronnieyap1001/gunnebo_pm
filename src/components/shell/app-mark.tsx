import { cn } from "@/lib/utils";

/** Small logo: three connected flow nodes (grey → blue → green). */
export function AppMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" className={cn("shrink-0", className)}>
      <rect width="32" height="32" rx="7" className="fill-foreground" />
      <path d="M9 16h5M18 16h5" className="stroke-background" strokeWidth="1.6" strokeLinecap="round" />
      <rect x="4.5" y="13" width="5" height="6" rx="1.5" fill="oklch(0.75 0.02 255)" />
      <rect x="13.5" y="13" width="5" height="6" rx="1.5" fill="oklch(0.65 0.17 255)" />
      <rect x="22.5" y="13" width="5" height="6" rx="1.5" fill="oklch(0.68 0.15 150)" />
    </svg>
  );
}
