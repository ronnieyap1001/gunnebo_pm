import { PageHeader } from "@/components/shell/page-header";
import { SettingsScreen } from "@/components/admin/settings-screen";
import { getSettingsData } from "@/server/queries";
import { readSetupStatus } from "../setup/status";
import { requireReadyStorage } from "@/server/guards";

export const metadata = { title: "Settings" };

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireReadyStorage();
  const [settings, status, sp] = await Promise.all([getSettingsData(), readSetupStatus(), searchParams]);
  const job = typeof sp.job === "string" ? sp.job : null;
  const kind = typeof sp.kind === "string" ? sp.kind : null;
  return (
    <>
      <PageHeader title="Settings" description="Your name, time zone, backups, maintenance and the Notion connection." />
      <SettingsScreen
        settings={settings}
        status={status}
        now={new Date().toISOString()}
        resumeJob={job && kind ? { jobId: job, kind } : null}
      />
    </>
  );
}
