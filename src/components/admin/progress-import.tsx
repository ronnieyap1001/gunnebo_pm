"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { FileUp, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { applyProgressProjectAction, previewProgressImportAction } from "@/app/(app)/settings/actions";
import type { ItemOutcome, ProgressReport, ReportItem } from "@/server/services/progressImport";
import { callAction } from "./call";
import { Notice } from "./notice";
import { SettingsGroup, SettingsRow } from "./settings-section";

interface FileProject {
  code: string;
  name: string;
}

interface LoadedFile {
  name: string;
  /** The parsed file, sent back to the server one project at a time. */
  data: { format: unknown; version: unknown; asOf?: unknown; source?: unknown; projects: FileProject[] };
  preview: ProgressReport;
}

type Phase =
  | { kind: "idle" }
  | { kind: "previewing" }
  | { kind: "ready"; file: LoadedFile }
  | { kind: "applying"; file: LoadedFile; index: number }
  | { kind: "done"; file: LoadedFile; items: ReportItem[]; failed: { code: string; error: string }[] };

const OUTCOME_LABEL: Record<ItemOutcome, string> = {
  planned: "Will change",
  done: "Saved",
  unchanged: "Already up to date",
  skipped: "Left as is",
  error: "Problem",
};

/** Report items grouped by project code, in file order. */
function byProject(items: ReportItem[]): [string, ReportItem[]][] {
  const groups = new Map<string, ReportItem[]>();
  for (const i of items) {
    const g = groups.get(i.code) ?? [];
    g.push(i);
    groups.set(i.code, g);
  }
  return [...groups.entries()];
}

function count(items: ReportItem[], outcome: ItemOutcome): number {
  return items.filter((i) => i.outcome === outcome).length;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Settings → Import progress: preview a progress file, then save it project by project. */
export function ProgressImportGroup({ disabled }: { disabled?: boolean }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [problem, setProblem] = useState<string | null>(null);
  const running = phase.kind === "previewing" || phase.kind === "applying";

  // Leaving the page mid-import stops it; the projects saved so far stay, and running it again continues.
  useEffect(() => {
    if (phase.kind !== "applying") return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [phase.kind]);

  async function choose(file: File) {
    setProblem(null);
    if (file.size > 1_000_000) {
      setProblem("This file is larger than 1 MB. A progress file is usually well under 200 KB: check you picked the right file.");
      return;
    }
    let data: LoadedFile["data"];
    try {
      data = JSON.parse(await file.text());
    } catch {
      setProblem("This file is not a progress file (it could not be read as JSON).");
      return;
    }
    if (!data || data.format !== "gunnebo-pm-progress" || !Array.isArray(data.projects)) {
      setProblem("This file is not a progress file. Pick the .json file Claude prepared for you.");
      return;
    }
    setPhase({ kind: "previewing" });
    const r = await callAction(() => previewProgressImportAction(data));
    if (!r.ok) {
      setPhase({ kind: "idle" });
      setProblem(r.error);
      return;
    }
    setPhase({ kind: "ready", file: { name: file.name, data, preview: r.data } });
  }

  async function apply(file: LoadedFile) {
    const items: ReportItem[] = [];
    const failed: { code: string; error: string }[] = [];
    const { projects, ...head } = file.data;
    for (let i = 0; i < projects.length; i++) {
      setPhase({ kind: "applying", file, index: i });
      // One project per call; a timeout or dropped connection is retried, and the import continues where it stopped.
      const r = await callAction(() => applyProgressProjectAction({ ...head, projects: [projects[i]] }), { retries: 4 });
      if (r.ok) items.push(...r.data.items);
      else failed.push({ code: projects[i].code, error: r.error });
    }
    setPhase({ kind: "done", file, items, failed });
    router.refresh();
  }

  const preview = phase.kind === "ready" ? phase.file.preview : null;
  const newProjects = preview ? preview.items.filter((i) => i.outcome === "planned" && i.what.startsWith("create project")).length : 0;

  return (
    <SettingsGroup
      id="import"
      title="Import progress"
      description="Load projects and their progress from a file Claude prepares from your emails."
    >
      <SettingsRow
        title="Import a progress file"
        description="You see every change before anything is saved. Values you changed in the app are never overwritten, and importing the same file twice changes nothing."
        below={
          <div className="space-y-3">
            {problem ? <Notice tone="problem">{problem}</Notice> : null}
            {phase.kind === "previewing" ? (
              <Notice tone="info">
                <span className="inline-flex items-center gap-2">
                  <Loader2 className="size-4 animate-spin" aria-hidden /> Checking the file against the app…
                </span>
              </Notice>
            ) : null}
            {phase.kind === "ready" && preview ? (
              <>
                <Notice
                  tone={preview.counts.error ? "warning" : "info"}
                  title={`${phase.file.name}: ${plural(phase.file.data.projects.length, "project")}`}
                  action={
                    <div className="flex gap-2">
                      <Button size="sm" onClick={() => void apply(phase.file)} disabled={disabled || preview.counts.planned === 0}>
                        Apply {plural(preview.counts.planned, "change")}
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => setPhase({ kind: "idle" })}>
                        Cancel
                      </Button>
                    </div>
                  }
                >
                  {plural(newProjects, "new project")}, {plural(preview.counts.planned, "change")} to save,{" "}
                  {preview.counts.unchanged} already up to date, {preview.counts.skipped} left as is
                  {preview.counts.error ? `, ${plural(preview.counts.error, "problem")} (those items are skipped)` : ""}. Nothing is saved
                  until you click Apply.
                </Notice>
                <ReportList items={preview.items} />
              </>
            ) : null}
            {phase.kind === "applying" ? (
              <Notice tone="info" title={`Saving project ${phase.index + 1} of ${phase.file.data.projects.length}`}>
                <div className="space-y-2">
                  <div>
                    {phase.file.data.projects[phase.index].code} · {phase.file.data.projects[phase.index].name}
                  </div>
                  <div
                    className="h-1.5 overflow-hidden rounded-full bg-muted"
                    role="progressbar"
                    aria-label="Import progress"
                    aria-valuemin={0}
                    aria-valuemax={phase.file.data.projects.length}
                    aria-valuenow={phase.index}
                  >
                    <div
                      className="h-full bg-primary transition-[width]"
                      style={{ width: `${(phase.index / phase.file.data.projects.length) * 100}%` }}
                    />
                  </div>
                  <div className="text-xs text-muted-foreground">
                    A new project takes about a minute (its milestones are copied first). Keep this page open.
                  </div>
                </div>
              </Notice>
            ) : null}
            {phase.kind === "done" ? (
              <>
                <Notice
                  tone={phase.failed.length || count(phase.items, "error") ? "warning" : "success"}
                  title={phase.failed.length ? "Import finished with problems" : "Import finished"}
                >
                  {plural(count(phase.items, "done"), "change")} saved, {count(phase.items, "unchanged")} already up to date,{" "}
                  {count(phase.items, "skipped")} left as is
                  {count(phase.items, "error") ? `, ${plural(count(phase.items, "error"), "problem")}` : ""}.
                  {phase.failed.length ? (
                    <ul className="mt-1 list-disc pl-5">
                      {phase.failed.map((f) => (
                        <li key={f.code}>
                          {f.code}: {f.error} Run the import again to finish it.
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </Notice>
                <ReportList items={phase.items} />
              </>
            ) : null}
          </div>
        }
      >
        <input
          ref={input}
          id="progress-file"
          type="file"
          accept="application/json,.json"
          className="sr-only"
          tabIndex={-1}
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) void choose(f);
          }}
        />
        <Button variant="outline" onClick={() => input.current?.click()} disabled={disabled || running}>
          {running ? <Loader2 className="animate-spin" aria-hidden /> : <FileUp aria-hidden />}
          Choose progress file…
        </Button>
      </SettingsRow>
    </SettingsGroup>
  );
}

/** Per-project list of what the import plans or did; problems first, open by default when there are any. */
function ReportList({ items }: { items: ReportItem[] }) {
  return (
    <div className="divide-y rounded-lg border">
      {byProject(items).map(([code, list]) => {
        const errors = count(list, "error");
        const changes = count(list, "planned") + count(list, "done");
        return (
          <details key={code} open={errors > 0} className="group px-3 py-2 text-sm">
            <summary className="flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1">
              <span className="font-mono text-xs font-medium">{code}</span>
              <span className="text-xs text-muted-foreground">
                {plural(changes, "change")}
                {count(list, "skipped") ? ` · ${count(list, "skipped")} left as is` : ""}
                {errors ? ` · ${plural(errors, "problem")}` : ""}
              </span>
            </summary>
            <ul className="mt-2 space-y-1 pl-4 text-xs">
              {[...list]
                .sort((a, b) => Number(b.outcome === "error") - Number(a.outcome === "error"))
                .map((i, n) => (
                  <li key={n} className="flex gap-2">
                    <span className={i.outcome === "error" ? "font-medium text-destructive" : "text-muted-foreground"}>{OUTCOME_LABEL[i.outcome]}</span>
                    <span className="min-w-0 break-words">
                      {i.what}
                      {i.detail ? <span className="text-muted-foreground"> ({i.detail})</span> : null}
                    </span>
                  </li>
                ))}
            </ul>
          </details>
        );
      })}
    </div>
  );
}
