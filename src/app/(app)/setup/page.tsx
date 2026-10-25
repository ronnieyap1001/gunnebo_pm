import { requireUser } from "@/server/auth/session";
import { PageHeader } from "@/components/shell/page-header";
import { SetupScreen } from "@/components/admin/setup-screen";
import { describeOpenJobs, readSetupStatus, timeZoneOrDefault } from "./status";
import { parentTitleFor } from "@/server/notion/registry";

export const metadata = { title: "Setup" };

/** Never calls requireReadyStorage: this is where the app sends people until Notion is ready. */
export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireUser();
  const sp = await searchParams;
  const status = await readSetupStatus();
  let jobProjects: Record<string, string> = {};
  let timeZone = "Asia/Singapore";
  if (status.openJobs.length) [jobProjects, timeZone] = await Promise.all([describeOpenJobs(status), timeZoneOrDefault()]);
  const job = typeof sp.job === "string" ? sp.job : null;
  const kind = typeof sp.kind === "string" ? sp.kind : null;
  return (
    <>
      <PageHeader title="Setup" description="Connect Notion and load the starting milestones. You only do this once." />
      <SetupScreen
        status={status}
        parentTitle={parentTitleFor()}
        isPreview={process.env.VERCEL_ENV === "preview"}
        resumeJob={job && kind ? { jobId: job, kind } : null}
        jobProjects={jobProjects}
        timeZone={timeZone}
      />
    </>
  );
}
