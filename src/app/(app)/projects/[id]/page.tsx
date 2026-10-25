import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";
import { requireReadyStorage } from "@/server/guards";
import { getCachedAppSettings, getDay, getProjectPageData, scheduleReconcile } from "@/server/queries";
import { getRepo } from "@/server/repo";
import { listOpenJobs } from "@/server/services/jobs";
import { ProjectScreen } from "@/components/project/project-screen";
import type { ProjectViewMode } from "@/components/project/types";

type SearchParams = Record<string, string | string[] | undefined>;

function one(v: string | string[] | undefined): string | null {
  return typeof v === "string" && v.length > 0 && v.length <= 200 ? v : null;
}

const VIEWS: ProjectViewMode[] = ["flow", "list", "history"];

/** One read per request, shared by the title and the page; `readAt` is taken before the read starts. */
const load = cache(async (id: string) => {
  const readAt = new Date().toISOString();
  return { data: await getProjectPageData(id), readAt };
});

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  try {
    const { data } = await load(id);
    return { title: data ? `${data.project.code} ${data.project.name}` : "Project" };
  } catch {
    return { title: "Project" };
  }
}

export default async function ProjectPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<SearchParams> }) {
  await requireReadyStorage();
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  if (!id || id.length > 200) notFound();
  const [{ data, readAt }, day, settings] = await Promise.all([load(id), getDay(), getCachedAppSettings()]);
  if (!data) notFound();
  scheduleReconcile(id);

  const viewParam = one(sp.view);
  const view = VIEWS.includes(viewParam as ProjectViewMode) ? (viewParam as ProjectViewMode) : "flow";
  const node = one(sp.node);
  const job = one(sp.job);
  const resumeSync = job && /^[A-Za-z0-9-]{8,64}$/.test(job) && one(sp.kind) === "sync" ? job : null;

  // A project whose copy from the template was interrupted: offer to finish it.
  let setupJob: string | null = null;
  if (data.project.setup === "CREATING") {
    try {
      const jobs = await listOpenJobs(getRepo());
      setupJob = jobs.find((j) => j.kind === "createProject" && j.projectId === id)?.opId ?? null;
    } catch {
      setupJob = null;
    }
  }

  return (
    <ProjectScreen
      data={data}
      readAt={readAt}
      timeZone={day.timeZone}
      displayName={settings.displayName}
      now={new Date().toISOString()}
      initialView={view}
      initialNodeId={node && data.steps.some((s) => s.id === node) ? node : null}
      resumeSyncJob={resumeSync}
      setupJob={setupJob}
    />
  );
}
