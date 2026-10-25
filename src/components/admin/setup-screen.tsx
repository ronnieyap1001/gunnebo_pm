"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ArrowRight, Check, CircleCheck, Database, ExternalLink, ListChecks, Loader2, Play, Plug, RefreshCw, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { enqueue, newOpId } from "@/lib/write-queue";
import type { ActionResult } from "@/lib/action-result";
import type { JobProgress } from "@/lib/run-job";
import type { SetupStatusDTO } from "@/server/queries";
import {
  checkSetupAction,
  continueCreateProjectAction,
  continueImportAction,
  continueSyncAction,
  runSchemaStepAction,
  startSeedAction,
} from "@/app/(app)/setup/actions";
import { callAction, toastError } from "./call";
import { when } from "./format";
import { Notice } from "./notice";
import { useJob } from "./use-job";

export const README_SETUP_URL = "https://github.com/ronnieyap1001/gunnebo_pm#one-time-setup-about-15-minutes";

type OpenJob = SetupStatusDTO["openJobs"][number];
type StepKey = "connect" | "page" | "databases" | "seed";

const JOB_LABEL: Record<OpenJob["kind"], string> = {
  import: "Loading milestones into the template",
  createProject: "Creating a project",
  sync: "Syncing a project from the template",
};

/** Fraction for "Created database Steps (5 of 8)"; tidy-up steps creep towards the end. */
function schemaProgress(p: JobProgress, previous: JobProgress | null): JobProgress {
  const m = /\((\d+) of (\d+)\)/.exec(p.message);
  if (m) return { ...p, fraction: (Number(m[1]) / Number(m[2])) * 0.85 };
  if (p.done) return { ...p, fraction: 1 };
  const prev = previous?.fraction ?? 0;
  return { ...p, fraction: Math.min(0.97, Math.max(prev, 0.85) + 0.03) };
}

function currentStep(s: SetupStatusDTO): StepKey | "ready" {
  if (s.mode === "unconfigured") return "connect";
  if (!s.parentPage) return "page";
  if (!s.schemaReady) return "databases";
  if (!s.seeded) return "seed";
  return "ready";
}

export function SetupScreen({
  status: initial,
  parentTitle,
  isPreview,
  resumeJob,
  jobProjects,
  timeZone,
}: {
  status: SetupStatusDTO;
  parentTitle: string;
  isPreview: boolean;
  resumeJob: { jobId: string; kind: string } | null;
  /** "C0822 Heathrow T5 eGates" per unfinished project task (opId). */
  jobProjects: Record<string, string>;
  timeZone: string;
}) {
  const router = useRouter();
  const [status, setStatus] = useState(initial);
  const [checking, setChecking] = useState(false);
  const [startingSeed, setStartingSeed] = useState(false);
  const starting = useRef(false);
  const job = useJob();
  const resumed = useRef(false);

  useEffect(() => setStatus(initial), [initial]);

  const step = currentStep(status);
  const seedJob = status.openJobs.find((j) => j.kind === "import");
  const otherJobs = status.openJobs.filter((j) => !(step === "seed" && j === seedJob));

  async function checkAgain(opts: { quiet?: boolean } = {}) {
    setChecking(true);
    const r = await callAction(() => checkSetupAction());
    if (!r.ok && r.code === "STALE_DEPLOYMENT") {
      // Adding NOTION_TOKEN means a redeploy: the new version answers a fresh page load.
      window.location.reload();
      return null;
    }
    setChecking(false);
    if (!r.ok) {
      toastError(r, "Could not check Notion");
      return null;
    }
    setStatus(r.data);
    router.refresh();
    if (!opts.quiet) {
      const next = currentStep(r.data);
      if (next === currentStep(status)) toast.info(next === "ready" ? "Everything is set up." : "Nothing has changed yet.");
      else toast.success("Thanks, that worked.");
    }
    return r.data;
  }

  async function createDatabases() {
    const r = await job.run(
      "Setting up Notion",
      async (): Promise<ActionResult<JobProgress>> => runSchemaStepAction(),
      { map: schemaProgress },
    );
    if (!r.ok) {
      toastError(r, "Notion setup stopped", { retry: () => void createDatabases() });
      await checkAgain({ quiet: true });
      return;
    }
    toast.success("Notion is set up.");
    await checkAgain({ quiet: true });
  }

  async function runImport(opId: string, title: string, done: string): Promise<boolean> {
    const r = await job.run(title, () => continueImportAction(opId), { resume: { jobId: opId, kind: "import" } });
    if (!r.ok) {
      // The job is saved in Notion: Retry carries on where it stopped (same opId).
      toastError(r, "Loading stopped", {
        retry: () => void runImport(opId, title, done).then((ok) => (ok ? checkAgain({ quiet: true }) : null)),
      });
      await checkAgain({ quiet: true });
      return false;
    }
    toast.success(done);
    return true;
  }

  async function loadMilestones() {
    if (seedJob) {
      if (await runImport(seedJob.opId, "Loading the 64 milestones", "The 64 milestones are loaded.")) await checkAgain({ quiet: true });
      return;
    }
    // Starting takes a round trip before the progress dialog opens: a double click must not start a second load.
    if (starting.current) return;
    starting.current = true;
    setStartingSeed(true);
    try {
      const opId = newOpId();
      const started = await callAction(() => startSeedAction(opId));
      if (!started.ok) {
        toastError(started, "Could not start loading");
        await checkAgain({ quiet: true });
        return;
      }
      if (await runImport(opId, "Loading the 64 milestones", "The 64 milestones are loaded.")) await checkAgain({ quiet: true });
    } finally {
      starting.current = false;
      setStartingSeed(false);
    }
  }

  async function resume(j: { opId: string; kind: string; projectId?: string }) {
    if (j.kind === "import") {
      if (await runImport(j.opId, "Finishing the template import", "Template import finished.")) await checkAgain({ quiet: true });
      return;
    }
    if (j.kind === "createProject" || j.kind === "sync") {
      const action = j.kind === "sync" ? continueSyncAction : continueCreateProjectAction;
      let projectId = j.projectId ?? "";
      const step = async (): Promise<ActionResult<JobProgress>> => {
        const once = () => action(j.opId);
        const r = projectId ? await enqueue(projectId, once) : await once();
        if (r.ok && r.data.projectId) projectId = r.data.projectId;
        return r;
      };
      const r = await job.run(j.kind === "sync" ? "Finishing the sync" : "Finishing the new project", step, {
        resume: { jobId: j.opId, kind: j.kind },
      });
      if (!r.ok) {
        toastError(r, "Could not finish the task", { retry: () => void resume({ ...j, projectId: projectId || j.projectId }) });
      } else {
        toast.success(j.kind === "sync" ? "Sync finished." : "Project ready.", {
          action: projectId ? { label: "Open project", onClick: () => router.push(`/projects/${projectId}`) } : undefined,
        });
      }
      await checkAgain({ quiet: true });
    }
  }

  // A reload during a job (e.g. after a new deployment) lands here with ?job=…&kind=…: carry on where it stopped.
  useEffect(() => {
    if (resumed.current || !resumeJob) return;
    resumed.current = true;
    const known = initial.openJobs.find((j) => j.opId === resumeJob.jobId);
    void resume({ opId: resumeJob.jobId, kind: resumeJob.kind, projectId: known?.projectId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const busy = job.running || checking || startingSeed;
  // Some databases exist but not all of them are complete: say "repair", not "create".
  const incomplete = status.databases.filter((d) => !d.ok);
  const needsRepair = incomplete.length > 0 && incomplete.length < status.databases.length;
  const checkButton = (
    <Button variant="outline" onClick={() => void checkAgain()} disabled={busy}>
      {checking ? <Loader2 className="animate-spin" aria-hidden /> : <RefreshCw aria-hidden />}
      Check again
    </Button>
  );

  return (
    <main className="mx-auto w-full max-w-3xl space-y-5 px-4 py-6">
      <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <span className="min-w-0 flex-1">Gunnebo PM keeps all its data in your Notion workspace. These steps run once and take a few minutes.</span>
        <ModeBadge mode={status.mode} />
      </div>

      {step === "ready" ? (
        <ReadyCard status={status} />
      ) : null}

      <ol className="overflow-hidden rounded-xl border bg-card" aria-label="Setup steps">
        <StepRow
          n={1}
          title="Connect to Notion"
          state={step === "connect" ? "current" : "done"}
          doneText={status.mode === "fake" ? "Using local test data on this computer (no Notion token set)." : "The app has a Notion connection."}
        >
          <p>The app can&apos;t reach Notion yet because the <Code>NOTION_TOKEN</Code> setting is missing in Vercel.</p>
          <ol className="list-decimal space-y-1 pl-5">
            <li>
              In Notion, open <ExtLink href="https://www.notion.so/profile/integrations">Settings → Integrations</ExtLink> and choose{" "}
              <strong>Gunnebo PM app</strong> (if it isn&apos;t there, click <strong>New integration</strong>, name it Gunnebo PM app and
              save). Click <strong>Show</strong> next to the secret and copy it. It starts with <Code>ntn_</Code>.
            </li>
            <li>
              In Vercel, open this project, then <strong>Settings → Environment Variables</strong>. Add <Code>NOTION_TOKEN</Code> with that
              secret and tick Production, Preview and Development.
            </li>
            <li>
              Open <strong>Deployments</strong>, click <strong>⋯</strong> on the newest one and choose <strong>Redeploy</strong>. When it
              has finished, come back here and click <strong>Check again</strong>.
            </li>
          </ol>
          <Problems problems={status.problems} />
          <div className="flex flex-wrap items-center gap-3 pt-1">
            {checkButton}
            <ExtLink href={README_SETUP_URL}>Full steps in the README</ExtLink>
          </div>
        </StepRow>

        <StepRow
          n={2}
          title={`Find the “${parentTitle}” page in Notion`}
          state={step === "connect" ? "todo" : step === "page" ? "current" : "done"}
          doneText={
            status.parentPage ? (
              <>
                Using the page{" "}
                {status.parentPage.url ? <ExtLink href={status.parentPage.url}>{status.parentPage.title}</ExtLink> : <strong>{status.parentPage.title}</strong>}.
              </>
            ) : null
          }
        >
          <p>
            Notion has no page called <strong>{parentTitle}</strong> that the app is allowed to see.
            {isPreview ? " This is a preview version, so it uses its own page with test data, separate from your real data." : null}
          </p>
          <ol className="list-decimal space-y-1 pl-5">
            <li>
              In Notion, create a page at the top level of your sidebar named exactly <strong>{parentTitle}</strong> (or open it if it
              already exists).
            </li>
            <li>
              On that page click <strong>•••</strong> at the top right, then <strong>Connections</strong>, and add{" "}
              <strong>Gunnebo PM app</strong>.
            </li>
            <li>Come back here and click <strong>Check again</strong>.</li>
          </ol>
          <Problems problems={status.problems} />
          <div className="flex flex-wrap items-center gap-3 pt-1">
            {checkButton}
            <ExtLink href={README_SETUP_URL}>Full steps in the README</ExtLink>
          </div>
        </StepRow>

        <StepRow
          n={3}
          title="Create the databases"
          state={step === "connect" || step === "page" ? "todo" : step === "databases" ? "current" : "done"}
          doneText={`All ${status.databases.length || 8} databases are in place.`}
        >
          {needsRepair ? (
            <p>
              {incomplete.map((d) => d.name).join(", ")} {incomplete.length === 1 ? "is" : "are"} missing or incomplete in Notion, for
              example because something was deleted or renamed there. Repairing creates only what is missing; everything already stored
              is kept.
            </p>
          ) : (
            <p>
              The app keeps projects, milestones and their history in {status.databases.length || 8} Notion databases inside the{" "}
              <strong>{status.parentPage?.title ?? parentTitle}</strong> page. Creating them takes under a minute. Databases that
              already exist are kept and only repaired.
            </p>
          )}
          {status.databases.length ? (
            <ul className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-4" aria-label="Databases">
              {status.databases.map((d) => (
                <li key={d.name} className="flex items-center gap-1.5 text-xs">
                  {d.ok ? (
                    <CircleCheck className="state-d size-3.5 text-[var(--s-solid)]" aria-hidden />
                  ) : (
                    <Database className="size-3.5 text-muted-foreground" aria-hidden />
                  )}
                  <span className={d.ok ? "" : "text-muted-foreground"}>{d.name}</span>
                  <span className="sr-only">{d.ok ? "(ready)" : "(missing or incomplete)"}</span>
                </li>
              ))}
            </ul>
          ) : null}
          <Problems problems={status.problems} />
          <div className="flex flex-wrap items-center gap-3 pt-1">
            <Button onClick={() => void createDatabases()} disabled={busy} autoFocus>
              {needsRepair ? <Wrench aria-hidden /> : <Database aria-hidden />}
              {needsRepair ? "Repair databases" : "Create databases"}
            </Button>
          </div>
        </StepRow>

        <StepRow
          n={4}
          title="Load the 64 milestones"
          state={step === "ready" ? "done" : step === "seed" ? "current" : "todo"}
          doneText="The Milestone Library and Template Flow are loaded."
          last
        >
          <p>
            Loads the standard milestone list, from <em>Enquiry / RFQ received</em> to <em>Project closed</em>, as one chain in the
            Template Flow, plus the project detail fields (Customer, Product, Quantity, Project type and more). You can change all of
            it later in the Milestone Library and Template Flow.
          </p>
          {seedJob ? (
            <p className="text-muted-foreground">
              Loading started earlier and stopped at {seedJob.doneCount} of {seedJob.total}. It continues where it stopped.
            </p>
          ) : null}
          <Problems problems={status.problems} />
          <div className="flex flex-wrap items-center gap-3 pt-1">
            <Button onClick={() => void loadMilestones()} disabled={busy} autoFocus>
              {seedJob ? <Play aria-hidden /> : <ListChecks aria-hidden />}
              {seedJob ? "Continue loading" : "Load the 64 milestones"}
            </Button>
          </div>
        </StepRow>
      </ol>

      {otherJobs.length ? (
        <section aria-labelledby="open-jobs" className="space-y-2">
          <h2 id="open-jobs" className="text-sm font-semibold">Unfinished tasks</h2>
          <p className="text-xs text-muted-foreground">These stopped part-way, for example because a tab was closed. Resuming never repeats work.</p>
          <ul className="divide-y rounded-lg border bg-card">
            {otherJobs.map((j) => (
              <li key={j.opId} className="flex items-center gap-3 px-3 py-2 text-sm">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium" title={jobProjects[j.opId]}>
                    {JOB_LABEL[j.kind]}
                    {jobProjects[j.opId] ? <span className="font-normal text-muted-foreground">: {jobProjects[j.opId]}</span> : null}
                  </p>
                  <p className="text-xs text-muted-foreground tabular-nums">
                    {j.doneCount} of {j.total} done · started {when(j.createdAt, timeZone)}
                  </p>
                </div>
                <Button size="sm" variant="outline" onClick={() => void resume(j)} disabled={busy || !status.schemaReady}>
                  <Play aria-hidden />
                  Resume
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {status.warnings?.length ? (
        <section aria-labelledby="setup-notes" className="space-y-2">
          <h2 id="setup-notes" className="text-sm font-semibold">Notes</h2>
          {status.warnings.map((w) => (
            <Notice key={w} tone="warning">
              {w.replace(/\s*Open Setup to apply them\.$/, "")}
            </Notice>
          ))}
          {status.schemaReady ? (
            <Button variant="outline" size="sm" onClick={() => void createDatabases()} disabled={busy}>
              <Check aria-hidden />
              Apply the small fixes
            </Button>
          ) : null}
        </section>
      ) : null}

      {job.dialog}
    </main>
  );
}

function ReadyCard({ status }: { status: SetupStatusDTO }) {
  return (
    <div className="state-d flex flex-col items-start gap-3 rounded-xl border border-[var(--s-border)] bg-[var(--s-bg)] p-5 sm:flex-row sm:items-center">
      <CircleCheck className="size-8 shrink-0 text-[var(--s-solid)]" aria-hidden />
      <div className="min-w-0 flex-1">
        <h2 className="text-base font-semibold">Everything is set up</h2>
        <p className="text-sm text-foreground/80">
          Notion is connected{status.parentPage ? ` (page “${status.parentPage.title}”)` : ""}, the databases exist and the milestones are
          loaded.
        </p>
      </div>
      <Button asChild size="lg" className="h-10 px-5 text-sm">
        <Link href="/portfolio">
          Open Portfolio
          <ArrowRight aria-hidden />
        </Link>
      </Button>
    </div>
  );
}

function StepRow({
  n,
  title,
  state,
  doneText,
  last,
  children,
}: {
  n: number;
  title: string;
  state: "done" | "current" | "todo";
  doneText?: React.ReactNode;
  last?: boolean;
  children: React.ReactNode;
}) {
  return (
    <li
      aria-current={state === "current" ? "step" : undefined}
      className={cn("flex gap-3 px-4 py-3.5", !last && "border-b", state === "current" && "bg-muted/40")}
    >
      <div className="pt-0.5">
        {state === "done" ? (
          <span className="state-d flex size-6 items-center justify-center rounded-full bg-[var(--s-solid)] text-white dark:text-background">
            <Check className="size-3.5" aria-hidden />
            <span className="sr-only">Done:</span>
          </span>
        ) : (
          <span
            className={cn(
              "flex size-6 items-center justify-center rounded-full border text-xs font-semibold tabular-nums",
              state === "current" ? "border-primary bg-primary text-primary-foreground" : "text-muted-foreground",
            )}
          >
            {n}
            <span className="sr-only">{state === "current" ? "(to do now)" : "(later)"}</span>
          </span>
        )}
      </div>
      <div className="min-w-0 flex-1 space-y-2">
        <h2 className={cn("text-sm font-semibold leading-6", state === "todo" && "text-muted-foreground")}>{title}</h2>
        {state === "done" && doneText ? <p className="text-sm text-muted-foreground">{doneText}</p> : null}
        {state === "current" ? <div className="space-y-2.5 text-sm">{children}</div> : null}
      </div>
    </li>
  );
}

function Problems({ problems }: { problems: string[] }) {
  if (!problems.length) return null;
  return (
    <Notice tone="problem" title="What the app sees">
      <ul className="space-y-0.5">
        {problems.map((p) => (
          <li key={p}>{p}</li>
        ))}
      </ul>
    </Notice>
  );
}

function ModeBadge({ mode }: { mode: SetupStatusDTO["mode"] }) {
  if (mode === "notion") {
    return (
      <Badge variant="outline">
        <Plug aria-hidden />
        Notion
      </Badge>
    );
  }
  if (mode === "fake") {
    return (
      <Badge variant="secondary">
        <Database aria-hidden />
        Local test data
      </Badge>
    );
  }
  return (
    <Badge variant="destructive">
      <Plug aria-hidden />
      Not connected
    </Badge>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return <code className="rounded bg-muted px-1 py-0.5 font-mono text-[12px]">{children}</code>;
}

function ExtLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-0.5 font-medium text-primary underline-offset-4 hover:underline">
      {children}
      <ExternalLink className="size-3" aria-hidden />
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}
