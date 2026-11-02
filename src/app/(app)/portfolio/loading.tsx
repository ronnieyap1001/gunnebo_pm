import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/shell/page-header";

const COLS = 40;

export default function Loading() {
  return (
    <main className="flex h-svh min-h-0 flex-col" aria-busy="true" aria-label="Loading the portfolio">
      <PageHeader
        title="Portfolio"
        description={<span className="mt-1 inline-block h-3 w-72 animate-pulse rounded-md bg-muted" />}
        actions={<Skeleton className="h-7 w-40" />}
      />
      <div className="flex items-center gap-2 border-b px-4 py-2">
        <Skeleton className="h-8 w-60" />
        {[56, 64, 56, 110, 84].map((w, i) => (
          <Skeleton key={i} className="h-7 rounded-full" style={{ width: w }} />
        ))}
      </div>
      <div className="h-0.5" />
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-hidden">
          <div className="flex h-[168px] items-end border-b">
            <div className="h-full w-[300px] shrink-0 border-r" />
            {Array.from({ length: COLS }, (_, i) => (
              <div key={i} className="flex w-[22px] shrink-0 justify-center pb-1.5">
                <Skeleton className="w-2.5" style={{ height: 60 + ((i * 37) % 90) }} />
              </div>
            ))}
          </div>
          {Array.from({ length: 6 }, (_, r) => (
            <div key={r} className="flex h-9 items-center border-b border-border/60">
              <div className="flex w-[300px] shrink-0 items-center gap-2 border-r px-3">
                <Skeleton className="h-3 w-14" />
                <div className="flex-1 space-y-1">
                  <Skeleton className="h-3 w-32" />
                  <Skeleton className="h-2.5 w-16" />
                </div>
                <Skeleton className="h-1.5 w-8" />
              </div>
              {Array.from({ length: COLS }, (_, i) => (
                <div key={i} className="flex w-[22px] shrink-0 justify-center">
                  <Skeleton className="size-5 rounded-[3px]" />
                </div>
              ))}
            </div>
          ))}
        </div>
        <div className="w-[330px] shrink-0 border-l">
          <div className="flex h-11 items-center border-b px-3">
            <Skeleton className="h-4 w-28" />
          </div>
          <div className="flex gap-1.5 border-b px-3 py-2">
            <Skeleton className="h-7 w-20 rounded-full" />
            <Skeleton className="h-7 w-40 rounded-full" />
          </div>
          {Array.from({ length: 7 }, (_, i) => (
            <div key={i} className="space-y-1.5 border-b border-border/70 px-3 py-2">
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-2.5 w-2/3" />
            </div>
          ))}
        </div>
      </div>
      <span className="sr-only">Loading the portfolio…</span>
    </main>
  );
}
