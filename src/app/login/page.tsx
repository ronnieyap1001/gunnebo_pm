import { redirect } from "next/navigation";
import { authConfig, safeNextPath } from "@/server/auth/token";
import { readSession } from "@/server/auth/session";
import { LoginForm } from "./login-form";
import { AppMark } from "@/components/shell/app-mark";

export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  if (!authConfig().ok) redirect("/not-configured");
  const { next } = await searchParams;
  const target = safeNextPath(next);
  if (await readSession()) redirect(target);

  return (
    <main className="flex min-h-svh items-center justify-center bg-muted/40 p-6">
      <div className="w-full max-w-sm rounded-xl border bg-background p-6 shadow-sm">
        <div className="mb-6 flex items-center gap-3">
          <AppMark className="size-9" />
          <div>
            <h1 className="text-base font-semibold leading-tight">Gunnebo PM</h1>
            <p className="text-sm text-muted-foreground">Sign in to continue</p>
          </div>
        </div>
        <LoginForm next={target} />
      </div>
    </main>
  );
}
