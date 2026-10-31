import { cn } from "@/lib/utils";

/** Keyboard key hint, e.g. <Kbd>N</Kbd>. */
export function Kbd({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        "inline-flex h-4.5 min-w-4.5 items-center justify-center rounded border bg-muted px-1 font-sans text-[10px] font-medium text-muted-foreground",
        className,
      )}
    >
      {children}
    </kbd>
  );
}
