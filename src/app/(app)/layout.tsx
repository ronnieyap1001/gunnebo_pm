import { requireUser } from "@/server/auth/session";
import { Sidebar } from "@/components/shell/sidebar";

// Every signed-in page reads live data, so render per request.
export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  await requireUser();
  return (
    <div className="flex min-h-svh">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
