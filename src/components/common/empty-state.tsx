import { cn } from "@/lib/utils";

export function EmptyState({
  title,
  children,
  action,
  className,
}: {
  title: string;
  children?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mx-auto flex max-w-md flex-col items-center gap-2 px-6 py-16 text-center", className)}>
      <h2 className="text-sm font-semibold">{title}</h2>
      {children ? <div className="text-sm text-muted-foreground">{children}</div> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
