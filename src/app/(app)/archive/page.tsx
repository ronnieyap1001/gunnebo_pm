import { PageHeader } from "@/components/shell/page-header";
import { ArchiveScreen } from "@/components/admin/archive-screen";
import { archiveTabOf, toArchiveProject, toSnapshotRow } from "@/components/admin/archive-types";
import { getArchiveData, getDay, getTemplateSnapshots } from "@/server/queries";
import { requireReadyStorage } from "@/server/guards";
import { stepNamesFor } from "./step-names";

export const metadata = { title: "Archive" };

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireReadyStorage();
  const sp = await searchParams;
  const tab = archiveTabOf(sp.tab);
  const projectId = typeof sp.project === "string" && sp.project ? sp.project : undefined;
  const [data, snapshots, day] = await Promise.all([getArchiveData({ projectId }), getTemplateSnapshots(), getDay()]);
  const project = data.project ? toArchiveProject(data.project, await stepNamesFor(data.project)) : null;
  return (
    <>
      <PageHeader title="Archive" description="Everything you delete comes here first. Restore puts it back exactly where it was." />
      <ArchiveScreen
        data={{ ...data, project: null }}
        project={project}
        snapshots={{ items: snapshots.items.map(toSnapshotRow), nextCursor: snapshots.nextCursor }}
        timeZone={day.timeZone}
        initialTab={tab}
      />
    </>
  );
}
