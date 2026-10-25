import { authConfig, MIN_PASSWORD_LENGTH } from "@/server/auth/token";
import { AppMark } from "@/components/shell/app-mark";

export const dynamic = "force-dynamic";

/** Shown before the app has a password. Reveals nothing about the data. */
export default function NotConfiguredPage() {
  const cfg = authConfig();
  return (
    <main className="flex min-h-svh items-center justify-center bg-muted/40 p-6">
      <div className="w-full max-w-lg rounded-xl border bg-background p-6 shadow-sm">
        <div className="mb-4 flex items-center gap-3">
          <AppMark className="size-9" />
          <h1 className="text-base font-semibold">Gunnebo PM needs one more setting</h1>
        </div>
        {cfg.ok ? (
          <p className="text-sm">
            Everything is configured. <a className="underline" href="/login">Go to sign in</a>.
          </p>
        ) : (
          <div className="space-y-3 text-sm">
            <p className="font-medium text-destructive">{cfg.problem}</p>
            <p>In Vercel, open this project, then Settings, then Environment Variables, and add:</p>
            <ul className="list-disc space-y-1 pl-5">
              <li>
                <code className="rounded bg-muted px-1">APP_PASSWORD</code>: the password you will use to sign in, at least{" "}
                {MIN_PASSWORD_LENGTH} characters. Four or five random words work well.
              </li>
              <li>
                <code className="rounded bg-muted px-1">NOTION_TOKEN</code>: the secret of your Notion connection.
              </li>
            </ul>
            <p>Then open Deployments and choose Redeploy on the latest one. The README has the full steps.</p>
          </div>
        )}
      </div>
    </main>
  );
}
