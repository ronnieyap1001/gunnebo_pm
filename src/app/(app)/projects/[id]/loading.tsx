import { Skeleton } from "@/components/ui/skeleton";

/** Header + flow canvas placeholder in the project page's layout. */
export default function Loading() {
  return (
    <div className="flex h-svh min-h-0 flex-col" aria-busy="true" aria-label="Loading the project">
      <header className="space-y-2 border-b px-4 py-2.5">
        <div className="flex items-center gap-2">
          <Skeleton className="h-5 w-16 rounded-md" />
          <Skeleton className="h-4 w-56" />
          <Skeleton className="h-5 w-14 rounded-full" />
          <Skeleton className="h-5 w-16 rounded-full" />
          <div className="flex-1" />
          <Skeleton className="h-7 w-48 rounded-md" />
          <Skeleton className="h-7 w-24 rounded-md" />
          <Skeleton className="size-7 rounded-md" />
        </div>
        <Skeleton className="h-3 w-96 max-w-full" />
        <div className="flex items-center gap-3">
          <Skeleton className="h-2 w-64 rounded-full" />
          <Skeleton className="h-3 w-40" />
          <Skeleton className="h-3 w-56" />
        </div>
        <div className="flex items-center gap-1.5">
          <Skeleton className="h-3 w-12" />
          <Skeleton className="h-5 w-32 rounded-full" />
          <Skeleton className="h-5 w-28 rounded-full" />
          <Skeleton className="h-5 w-36 rounded-full" />
        </div>
      </header>
      <div className="relative min-h-0 flex-1 overflow-hidden bg-[radial-gradient(var(--border)_1px,transparent_1px)] [background-size:16px_16px]">
        <div className="absolute top-3 left-3 flex items-center gap-1 rounded-lg border bg-background p-1 shadow-sm">
          {[16, 28, 24, 24, 28, 18].map((w, i) => (
            <Skeleton key={i} className="h-7" style={{ width: `${w * 4}px` }} />
          ))}
        </div>
        <div className="absolute inset-x-8 top-20 space-y-10">
          {Array.from({ length: 5 }, (_, r) => (
            <div key={r} className="flex gap-6">
              {Array.from({ length: 7 }, (_, i) => (
                <Skeleton key={i} className="h-14 w-44 shrink-0 rounded-md" />
              ))}
            </div>
          ))}
        </div>
        <Skeleton className="absolute right-4 bottom-4 h-28 w-48 rounded-md" />
      </div>
    </div>
  );
}
