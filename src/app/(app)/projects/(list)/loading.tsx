import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/shell/page-header";

export default function Loading() {
  return (
    <main className="flex h-svh min-h-0 flex-col" aria-busy="true" aria-label="Loading projects">
      <PageHeader
        title="Projects"
        description={<span className="mt-1 inline-block h-3 w-48 animate-pulse rounded-md bg-muted" />}
        actions={<Skeleton className="h-7 w-32" />}
      />
      <div className="flex items-center gap-2 border-b px-4 py-2">
        <Skeleton className="h-8 w-72" />
        {[64, 72, 64, 44].map((w, i) => (
          <Skeleton key={i} className="h-7 rounded-full" style={{ width: w }} />
        ))}
      </div>
      <div className="flex-1 overflow-hidden">
        <div className="flex h-9 items-center gap-6 border-b px-4">
          {[40, 120, 80, 90, 80, 50, 30, 60, 60, 120, 50].map((w, i) => (
            <Skeleton key={i} className="h-3" style={{ width: w }} />
          ))}
        </div>
        {Array.from({ length: 10 }, (_, r) => (
          <div key={r} className="flex h-8 items-center gap-6 border-b border-border/70 px-4">
            {[44, 160, 70, 100, 80, 60, 30, 56, 70, 140, 44].map((w, i) => (
              <Skeleton key={i} className="h-3" style={{ width: w * (0.75 + ((r * 7 + i * 3) % 5) / 10) }} />
            ))}
          </div>
        ))}
      </div>
      <span className="sr-only">Loading projects…</span>
    </main>
  );
}
