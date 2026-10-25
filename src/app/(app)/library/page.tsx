import { requireReadyStorage } from "@/server/guards";
import { getLibraryView } from "@/server/queries";
import { LibraryScreen } from "@/components/library/library-screen";

export const metadata = { title: "Milestone Library" };

function one(v: string | string[] | undefined): string | null {
  return typeof v === "string" && v ? v : null;
}

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireReadyStorage();
  const [view, sp] = await Promise.all([getLibraryView(), searchParams]);
  const tab = one(sp.tab) === "project-fields" ? "project-fields" : "milestones";
  return <LibraryScreen view={view} initial={{ tab, m: one(sp.m), f: one(sp.f) }} />;
}
