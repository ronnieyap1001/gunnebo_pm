import { requireReadyStorage } from "@/server/guards";
import { getTemplateView } from "@/server/queries";
import { TemplateScreen } from "@/components/template/template-screen";

export const metadata = { title: "Template Flow" };

type SearchParams = Record<string, string | string[] | undefined>;

function one(v: string | string[] | undefined): string | null {
  return typeof v === "string" && v.length > 0 && v.length <= 200 ? v : null;
}

export default async function Page({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await requireReadyStorage();
  const [view, sp] = await Promise.all([getTemplateView(), searchParams]);
  const m = one(sp.m);
  const job = one(sp.job);
  const kind = one(sp.kind);
  const resume =
    job && /^[A-Za-z0-9-]{8,64}$/.test(job) && (kind === "import" || kind === "sync") ? { opId: job, kind: kind as "import" | "sync" } : null;
  return (
    <TemplateScreen
      view={view}
      initialSelectedId={m && view.milestones.some((r) => r.id === m) ? m : null}
      resume={resume}
    />
  );
}
