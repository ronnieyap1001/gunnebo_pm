import { Skeleton } from "@/components/ui/skeleton";

function Header({ title }: { title: string }) {
  return (
    <header className="flex min-h-12 items-center gap-3 border-b px-4 py-2">
      <div className="min-w-0 flex-1">
        <h1 className="text-sm font-semibold">{title}</h1>
        <Skeleton className="mt-1 h-3 w-72" />
      </div>
    </header>
  );
}

export function SetupSkeleton() {
  return (
    <>
      <Header title="Setup" />
      <main className="mx-auto w-full max-w-3xl space-y-5 px-4 py-6" aria-busy="true" aria-label="Loading setup">
        <Skeleton className="h-4 w-96" />
        <div className="divide-y rounded-xl border">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="flex gap-3 px-4 py-3.5">
              <Skeleton className="size-6 rounded-full" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-56" />
                <Skeleton className="h-3 w-80" />
              </div>
            </div>
          ))}
        </div>
      </main>
    </>
  );
}

export function SettingsSkeleton() {
  return (
    <>
      <Header title="Settings" />
      <main className="mx-auto w-full max-w-4xl space-y-6 px-4 py-6" aria-busy="true" aria-label="Loading settings">
        {[2, 1, 5, 2].map((rows, g) => (
          <div key={g} className="space-y-2">
            <Skeleton className="h-4 w-32" />
            <div className="divide-y rounded-xl border">
              {Array.from({ length: rows }, (_, i) => (
                <div key={i} className="flex items-center gap-6 px-4 py-3">
                  <div className="w-80 space-y-1.5">
                    <Skeleton className="h-4 w-40" />
                    <Skeleton className="h-3 w-72" />
                  </div>
                  <Skeleton className="ml-auto h-8 w-40" />
                </div>
              ))}
            </div>
          </div>
        ))}
      </main>
    </>
  );
}

export function ArchiveSkeleton() {
  return (
    <>
      <Header title="Archive" />
      <main className="flex flex-1 flex-col" aria-busy="true" aria-label="Loading archive">
        <div className="flex items-center gap-3 border-b px-4 py-2">
          <Skeleton className="h-8 w-[560px]" />
          <Skeleton className="ml-auto h-8 w-64" />
        </div>
        <div className="divide-y">
          <div className="h-8" />
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className="flex h-9 items-center gap-4 px-4">
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-4 flex-1" />
              <Skeleton className="h-4 w-36" />
              <Skeleton className="h-6 w-20" />
            </div>
          ))}
        </div>
      </main>
    </>
  );
}
