import { Skeleton } from "@/components/ui/skeleton";

const WIDTHS = ["w-56", "w-72", "w-44", "w-64", "w-52", "w-80", "w-48", "w-60"];

export default function Loading() {
  return (
    <div className="flex h-svh min-h-0 flex-col" aria-busy="true" aria-label="Loading the Milestone Library">
      <header className="flex min-h-12 items-center gap-3 border-b px-4 py-2">
        <div className="min-w-0 flex-1 space-y-1.5">
          <Skeleton className="h-3.5 w-40" />
          <Skeleton className="h-3 w-96 max-w-full" />
        </div>
        <Skeleton className="h-8 w-28" />
      </header>
      <div className="flex h-10 items-end gap-5 border-b px-4 pb-2.5">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-4 w-28" />
      </div>
      <div className="flex items-center gap-2 border-b px-4 py-2">
        <Skeleton className="h-8 w-80" />
        <Skeleton className="h-8 w-40" />
      </div>
      <div className="border-b bg-muted/40 px-4 py-2">
        <Skeleton className="h-3 w-[28rem] max-w-full" />
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <div className="flex h-8 items-center gap-4 border-b px-4">
          <Skeleton className="h-3 w-6" />
          <Skeleton className="h-3 w-24" />
          <Skeleton className="ml-auto h-3 w-20" />
        </div>
        {Array.from({ length: 18 }, (_, i) => (
          <div key={i} className="flex h-8 items-center gap-4 border-b border-border/60 px-4">
            <Skeleton className="size-3.5" />
            <Skeleton className="h-3 w-5" />
            <Skeleton className={`h-3 ${WIDTHS[i % WIDTHS.length]}`} />
            <Skeleton className="ml-auto h-3 w-20" />
            <Skeleton className="hidden h-3 w-48 md:block" />
            <Skeleton className="hidden h-3 w-16 lg:block" />
          </div>
        ))}
      </div>
    </div>
  );
}
