import { requireReadyStorage } from "@/server/guards";
import { getDay, getPortfolioData, getProjectsList } from "@/server/queries";
import { PortfolioScreen } from "@/components/portfolio/portfolio-screen";
import { hasFilterParams, parsePortfolioQuery } from "@/components/portfolio/filters";

export const metadata = { title: "Portfolio" };

type SearchParams = Record<string, string | string[] | undefined>;

export default async function PortfolioPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await requireReadyStorage();
  const sp = await searchParams;
  const get = (k: string) => {
    const v = sp[k];
    return Array.isArray(v) ? v.join(",") : (v ?? null);
  };
  const query = parsePortfolioQuery(get);
  const [data, day] = await Promise.all([
    getPortfolioData({
      status: query.status,
      customer: query.customer,
      projectType: query.type,
      q: query.q,
      includeWaiting: query.waiting,
      includeDateDriven: query.dated,
    }),
    getDay(),
  ]);

  // Only when the filters leave nothing: is it "no projects yet" or "none match"?
  let totalProjects = data.rows.length;
  if (totalProjects === 0) {
    const all = await getProjectsList();
    totalProjects = all.filter((p) => p.setup === "READY").length;
  }

  return (
    <PortfolioScreen
      data={data}
      hasUrlFilters={hasFilterParams(get)}
      totalProjects={totalProjects}
      serverNow={new Date().toISOString()}
      timeZone={day.timeZone}
    />
  );
}
