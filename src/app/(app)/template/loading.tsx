import { Skeleton } from "@/components/ui/skeleton";

/** Placeholder cards in the wrapped layout's rhythm (rows of chained cards). */
const ROWS = 4;
const PER_ROW = 7;

export default function Loading() {
  return (
    <div className="flex h-svh min-h-0 flex-col" aria-busy="true" aria-label="Loading the Template Flow">
      <header className="flex min-h-12 items-center gap-3 border-b px-4 py-2">
        <div className="min-w-0 flex-1 space-y-1.5">
          <Skeleton className="h-3.5 w-32" />
          <Skeleton className="h-3 w-[30rem] max-w-full" />
        </div>
      </header>
      <div className="relative min-h-0 flex-1 overflow-hidden bg-[radial-gradient(var(--border)_1px,transparent_1px)] [background-size:16px_16px]">
        <div className="absolute top-4 left-4 flex items-center gap-1 rounded-lg border bg-background p-1 shadow-sm">
          <Skeleton className="h-7 w-24" />
          <Skeleton className="h-7 w-28" />
          <Skeleton className="h-7 w-14" />
          <Skeleton className="h-7 w-24" />
          <Skeleton className="h-7 w-24" />
          <Skeleton className="h-7 w-32" />
        </div>
        <div className="absolute inset-x-8 top-24 space-y-12">
          {Array.from({ length: ROWS }, (_, r) => (
            <div key={r} className="flex gap-6">
              {Array.from({ length: PER_ROW }, (_, i) => (
                <Skeleton key={i} className="h-11 w-36 shrink-0 rounded-md" />
              ))}
            </div>
          ))}
        </div>
        <Skeleton className="absolute right-4 bottom-4 h-28 w-48 rounded-md" />
      </div>
      <div className="flex h-9 items-center gap-3 border-t px-3">
        <Skeleton className="h-3 w-40" />
        <Skeleton className="h-3 w-56" />
      </div>
    </div>
  );
}
