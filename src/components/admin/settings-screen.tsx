"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  CircleCheck,
  Database,
  Download,
  ExternalLink,
  FileWarning,
  Loader2,
  LogOut,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Trash2,
  Wrench,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { ok, type ActionResult } from "@/lib/action-result";
import type { JobProgress } from "@/lib/run-job";
import { newOpId } from "@/lib/write-queue";
import type { SettingsData, SetupStatusDTO } from "@/server/queries";
import {
  recordBackupAction,
  reloadFromNotionAction,
  repairBatchAction,
  repairListAction,
  saveDisplayNameAction,
  saveTimeZoneAction,
  signOutEverywhereAction,
  startOverAction,
  startResetTemplateAction,
  verifyHistoryAction,
} from "@/app/(app)/settings/actions";
import { continueImportAction } from "@/app/(app)/setup/actions";
import { makeBackupJob } from "./backup";
import { callAction, toastError } from "./call";
import { ago, downloadText, when, ymdIn } from "./format";
import { Notice } from "./notice";
import { SettingsGroup, SettingsRow } from "./settings-section";
import { useJob } from "./use-job";

const COMMON_ZONES: { tz: string; label: string }[] = [
  { tz: "Asia/Singapore", label: "Singapore" },
  { tz: "Asia/Shanghai", label: "China (Shanghai, Kunshan)" },
  { tz: "Asia/Hong_Kong", label: "Hong Kong" },
  { tz: "Asia/Kuala_Lumpur", label: "Malaysia" },
  { tz: "Asia/Tokyo", label: "Japan" },
  { tz: "Asia/Kolkata", label: "India" },
  { tz: "Asia/Dubai", label: "United Arab Emirates" },
  { tz: "Australia/Sydney", label: "Australia (Sydney)" },
  { tz: "Europe/London", label: "United Kingdom" },
  { tz: "Europe/Stockholm", label: "Sweden" },
  { tz: "Europe/Paris", label: "France" },
  { tz: "Europe/Berlin", label: "Germany" },
  { tz: "America/New_York", label: "US Eastern (New York)" },
  { tz: "America/Chicago", label: "US Central (Chicago)" },
  { tz: "America/Los_Angeles", label: "US Pacific (Los Angeles)" },
  { tz: "UTC", label: "UTC" },
];
const OTHER = "__other";

function knowsZone(tz: string): boolean {
  if (!tz.trim()) return false;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz.trim() });
    return true;
  } catch {
    return false;
  }
}

interface VerifySummary {
  checked: number;
  unhashed: number;
  mismatches: { id: string; seq: number; summary: string; occurredAt: string }[];
}

export function SettingsScreen({
  settings,
  status,
  now: serverNow,
  resumeJob,
}: {
  settings: SettingsData;
  status: SetupStatusDTO;
  now: string;
  resumeJob: { jobId: string; kind: string } | null;
}) {
  const router = useRouter();
  const job = useJob();
  const [now, setNow] = useState(serverNow);
  const [backupAt, setBackupAt] = useState(settings.backupLastAt);
  const [verify, setVerify] = useState<VerifySummary | null>(null);
  const [repair, setRepair] = useState<{ checked: number; repaired: number } | null>(null);
  const [reloading, setReloading] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [confirmStartOver, setConfirmStartOver] = useState(false);
  /** Remounts the Start over dialog on every fresh open, so a RESET typed earlier never carries over. */
  const [startOverKey, setStartOverKey] = useState(0);
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const [startingOver, setStartingOver] = useState(false);
  const [startingReset, setStartingReset] = useState(false);
  /** Set while Reset, Start over or Sign out everywhere is starting: blocks a second start from a double click. */
  const inFlight = useRef(false);
  const [signingOut, setSigningOut] = useState(false);
  const tz = settings.timeZone;

  useEffect(() => {
    setNow(new Date().toISOString());
    const t = window.setInterval(() => setNow(new Date().toISOString()), 60_000);
    return () => window.clearInterval(t);
  }, []);
  useEffect(() => setBackupAt(settings.backupLastAt), [settings.backupLastAt]);

  const daysSince = backupAt ? Math.floor((Date.parse(now) - Date.parse(backupAt)) / 86_400_000) : null;
  const backupStale = daysSince === null || daysSince > 7;

  // ---- Backup -------------------------------------------------------------
  async function downloadBackup(): Promise<boolean> {
    const backup = makeBackupJob();
    const r = await job.run("Downloading full backup", backup.step, { maxSteps: 20_000 });
    if (!r.ok) {
      toastError(r, "The backup stopped", { retry: () => void downloadBackup() });
      return false;
    }
    const exportedAt = new Date().toISOString();
    try {
      downloadText(`gunnebo-pm-backup-${ymdIn(exportedAt, tz)}.json`, JSON.stringify(backup.file(exportedAt)));
    } catch {
      toast.error("The browser could not save the file. Try again, or try another browser.");
      return false;
    }
    toast.success("Backup downloaded", {
      description: `${backup.rowCount().toLocaleString("en-GB")} rows in one file. Keep it somewhere safe, such as OneDrive.`,
    });
    await noteBackupTime(newOpId());
    return true;
  }

  async function noteBackupTime(opId: string) {
    const rec = await callAction(() => recordBackupAction(opId));
    if (!rec.ok) {
      toastError(rec, "The backup file is saved, but the app could not note the time", { retry: () => void noteBackupTime(opId) });
      return;
    }
    setBackupAt(rec.data.at);
    router.refresh();
  }

  // ---- Maintenance --------------------------------------------------------
  async function verifyHistory() {
    const opId = newOpId();
    let cursor: string | null = null;
    const total: VerifySummary = { checked: 0, unhashed: 0, mismatches: [] };
    const step = async (): Promise<ActionResult<JobProgress>> => {
      const r = await verifyHistoryAction(opId, cursor);
      if (!r.ok) return r;
      total.checked += r.data.checked;
      total.unhashed += r.data.unhashed;
      total.mismatches.push(...r.data.mismatches);
      cursor = r.data.nextCursor;
      return ok({
        done: !cursor,
        message: `Checked ${total.checked.toLocaleString("en-GB")} history rows${total.mismatches.length ? ` · ${total.mismatches.length} changed` : ""}…`,
      });
    };
    const r = await job.run("Checking the history", step, { maxSteps: 20_000 });
    if (!r.ok) {
      toastError(r, "The check stopped", { retry: () => void verifyHistory() });
      return;
    }
    setVerify({ ...total });
    if (total.mismatches.length) toast.warning(`${total.mismatches.length} history ${total.mismatches.length === 1 ? "row was" : "rows were"} changed outside the app`);
    else toast.success("History checked: nothing was changed outside the app");
  }

  async function repairMirrors() {
    const st: { ids: string[] | null; index: number; repaired: number; opIds: string[] } = { ids: null, index: 0, repaired: 0, opIds: [] };
    const step = async (): Promise<ActionResult<JobProgress>> => {
      if (!st.ids) {
        const list = await repairListAction();
        if (!list.ok) return list;
        st.ids = list.data;
        return ok({ done: st.ids.length === 0, message: `Found ${st.ids.length} ${st.ids.length === 1 ? "project" : "projects"}`, fraction: 0 });
      }
      const ids = st.ids;
      const chunk = ids.slice(st.index, st.index + 5);
      // One opId per chunk, reused when the same chunk is retried.
      const opId = (st.opIds[st.index] ??= newOpId());
      const r = await repairBatchAction(opId, chunk);
      if (!r.ok) return r;
      st.index += chunk.length;
      st.repaired += r.data.repaired.length;
      return ok({
        done: st.index >= ids.length,
        message: `Checked ${st.index} of ${ids.length} projects · ${st.repaired} repaired`,
        fraction: ids.length ? st.index / ids.length : 1,
      });
    };
    const r = await job.run("Repairing project summaries", step, { maxSteps: 5_000 });
    if (!r.ok) {
      toastError(r, "Repair stopped", { retry: () => void repairMirrors() });
      return;
    }
    const checked = st.ids?.length ?? 0;
    setRepair({ checked, repaired: st.repaired });
    if (!checked) toast.info("There are no projects to check yet.");
    else toast.success(st.repaired ? `Repaired ${st.repaired} of ${checked} projects` : `Checked ${checked} ${checked === 1 ? "project" : "projects"}: all correct`);
    router.refresh();
  }

  async function reloadFromNotion() {
    setReloading(true);
    const r = await callAction(() => reloadFromNotionAction());
    setReloading(false);
    if (!r.ok) {
      toastError(r, "Could not reload");
      return;
    }
    toast.success("Reloaded from Notion", { description: "The app now shows exactly what is stored in Notion." });
    router.refresh();
  }

  async function runReset(opId: string) {
    const r = await job.run("Resetting the template", () => continueImportAction(opId), { resume: { jobId: opId, kind: "import" } });
    if (!r.ok) {
      // The job is saved in Notion: Retry carries on where it stopped (same opId).
      toastError(r, "The reset stopped", { retry: () => void runReset(opId) });
      return;
    }
    toast.success("Template reset to the 64 seed milestones", {
      description: "Projects are unchanged until you sync them. The previous template is under Archive → Template snapshots.",
    });
    router.refresh();
  }

  async function resetTemplate(opId: string = newOpId()) {
    // A double click on the dialog's button must not start a second reset job.
    if (inFlight.current) return;
    inFlight.current = true;
    setStartingReset(true);
    try {
      const started = await callAction(() => startResetTemplateAction(opId));
      if (!started.ok) {
        toastError(started, "Could not start the reset", { retry: () => void resetTemplate(opId) });
        return;
      }
      await runReset(opId);
    } finally {
      inFlight.current = false;
      setStartingReset(false);
    }
  }

  async function startOver() {
    if (inFlight.current) return;
    inFlight.current = true;
    setStartingOver(true);
    const r = await callAction(() => startOverAction("RESET"), { retries: 1 });
    if (!r.ok) {
      inFlight.current = false;
      setStartingOver(false);
      toastError(r, "Start over did not finish");
      return;
    }
    toast.success("All app databases are in Notion's trash. Set the app up again.");
    router.replace("/setup");
    router.refresh();
  }

  async function signOutEverywhere() {
    if (inFlight.current) return;
    inFlight.current = true;
    setSigningOut(true);
    const r = await callAction(() => signOutEverywhereAction(), { retries: 1 });
    if (!r.ok) {
      inFlight.current = false;
      setSigningOut(false);
      toastError(r, "Could not sign out everywhere");
      return;
    }
    window.location.assign("/login");
  }

  // A reload during the template reset (e.g. after a deployment) comes back with ?job=…: finish it.
  const resumed = useRef(false);
  useEffect(() => {
    if (resumed.current || resumeJob?.kind !== "import") return;
    resumed.current = true;
    void runReset(resumeJob.jobId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const busy = job.running || startingOver || signingOut || startingReset;

  return (
    <main className="mx-auto w-full max-w-4xl space-y-6 px-4 py-6">
      <SettingsGroup id="general" title="General" description="How the app names you and decides what “today” is.">
        <NameRow initial={settings.displayName} disabled={busy} />
        <TimeZoneRow initial={settings.timeZone} now={now} disabled={busy} />
      </SettingsGroup>

      <SettingsGroup id="backup" title="Backup" description="Your data lives in Notion. A backup file on your computer protects you if anything goes wrong there.">
        <SettingsRow
          title="Download full backup"
          description="One file with every project, milestone, step, note, link and history row. Attached files stay in Notion; their names are listed."
          below={
            backupStale ? (
              <Notice tone="warning" title={backupAt ? `The last backup is ${daysSince} days old` : "No full backup yet"}>
                Download one now and keep it somewhere safe, such as OneDrive. It takes about a minute. Do this weekly.
              </Notice>
            ) : null
          }
        >
          <div className="mr-auto text-xs text-muted-foreground md:mr-2 md:text-right">
            <div>Last backup</div>
            <div className="font-medium text-foreground tabular-nums">
              {backupAt ? (
                <>
                  {when(backupAt, tz)} <span className="font-normal text-muted-foreground">({ago(backupAt, now, tz)})</span>
                </>
              ) : (
                "Never"
              )}
            </div>
          </div>
          <Button onClick={() => void downloadBackup()} disabled={busy}>
            <Download aria-hidden />
            Download full backup
          </Button>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup id="maintenance" title="Maintenance" description="Checks and repairs. Safe to run at any time; none of them changes values you entered.">
        <SettingsRow
          title="Verify history"
          description="Every history row is fingerprinted when it is written. This finds rows that were changed directly in Notion afterwards."
          below={verify ? <VerifyResult result={verify} timeZone={tz} /> : null}
        >
          <Button variant="outline" onClick={() => void verifyHistory()} disabled={busy}>
            <ShieldCheck aria-hidden />
            Verify history
          </Button>
        </SettingsRow>
        <SettingsRow
          title="Repair project summaries"
          description="Recalculates each project's progress, colours and current milestones from its steps, and fixes any that drifted."
          below={
            repair ? (
              <Notice tone="success">
                {repair.checked
                  ? `Checked ${repair.checked} ${repair.checked === 1 ? "project" : "projects"}: ${repair.repaired ? `${repair.repaired} repaired.` : "all were correct."}`
                  : "There are no projects to check yet."}
              </Notice>
            ) : null
          }
        >
          <Button variant="outline" onClick={() => void repairMirrors()} disabled={busy}>
            <Wrench aria-hidden />
            Repair mirrors
          </Button>
        </SettingsRow>
        <SettingsRow
          title="Reload from Notion"
          description="Forgets what the app remembered and reads the Milestone Library, project fields and settings from Notion again. Use it after editing something directly in Notion."
        >
          <Button variant="outline" onClick={() => void reloadFromNotion()} disabled={busy || reloading}>
            {reloading ? <Loader2 className="animate-spin" aria-hidden /> : <RefreshCw aria-hidden />}
            Reload from Notion
          </Button>
        </SettingsRow>
        <SettingsRow
          title="Reset template to seed"
          description="Puts the Milestone Library and Template Flow back to the original 64 milestones. Your projects are kept."
        >
          <Button variant="outline" onClick={() => setConfirmReset(true)} disabled={busy}>
            <RotateCcw aria-hidden />
            Reset template…
          </Button>
        </SettingsRow>
        <SettingsRow
          title="Start over"
          description="Moves all the app's Notion databases to Notion's trash (recoverable there for 30 days) and runs Setup again. Everything in the app is gone afterwards."
        >
          <Button
            variant="destructive"
            onClick={() => {
              setStartOverKey((k) => k + 1);
              setConfirmStartOver(true);
            }}
            disabled={busy}
          >
            <Trash2 aria-hidden />
            Start over…
          </Button>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup id="security" title="Security and connection">
        <SettingsRow
          title="Sign out everywhere"
          description="Signs out every browser and device that is signed in, including this one. Use it if you signed in on a shared computer or think someone knows your password."
        >
          <Button variant="outline" onClick={() => setConfirmSignOut(true)} disabled={busy}>
            {signingOut ? <Loader2 className="animate-spin" aria-hidden /> : <LogOut aria-hidden />}
            Sign out everywhere…
          </Button>
        </SettingsRow>
        <NotionRow status={status} settings={settings} />
      </SettingsGroup>

      <ConfirmDialog
        open={confirmReset}
        onOpenChange={setConfirmReset}
        title="Reset the template to the 64 seed milestones?"
        confirmLabel="Reset template"
        description={
          <>
            <p>The Milestone Library and Template Flow go back to the original 64 milestones in one chain. Milestones you added are archived, not deleted.</p>
            <p>
              <strong>Your projects are kept</strong> exactly as they are. They change only when you sync them from the template.
            </p>
            <p>The current template is saved first: you can download it later from Archive → Template snapshots and import it again.</p>
          </>
        }
        onConfirm={() => {
          setConfirmReset(false);
          void resetTemplate();
        }}
      />

      <ConfirmDialog
        key={startOverKey}
        open={confirmStartOver}
        onOpenChange={setConfirmStartOver}
        title="Start over with an empty app?"
        destructive
        typeToConfirm="RESET"
        confirmLabel="Start over"
        description={
          <>
            <p>
              All the app&apos;s Notion databases (projects, milestones, history, notes and files) move to Notion&apos;s trash. You can
              restore them from there for 30 days. Then Setup runs again from the beginning.
            </p>
            <p className="font-medium text-foreground">Download a full backup first{backupAt ? ` (last one: ${ago(backupAt, now, tz)})` : " (you have none yet)"}.</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={async () => {
                setConfirmStartOver(false);
                const saved = await downloadBackup();
                if (saved) setConfirmStartOver(true);
              }}
            >
              <Download aria-hidden />
              Download full backup
            </Button>
          </>
        }
        onConfirm={() => {
          setConfirmStartOver(false);
          void startOver();
        }}
      />

      <ConfirmDialog
        open={confirmSignOut}
        onOpenChange={setConfirmSignOut}
        title="Sign out on every device?"
        confirmLabel="Sign out everywhere"
        description={<p>Every signed-in browser, including this one, has to sign in again with the password.</p>}
        onConfirm={() => {
          setConfirmSignOut(false);
          void signOutEverywhere();
        }}
      />

      {startingOver ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 backdrop-blur-sm" role="status">
          <div className="flex items-center gap-2 rounded-lg border bg-card px-4 py-3 text-sm shadow-sm">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            Moving the databases to Notion&apos;s trash…
          </div>
        </div>
      ) : null}
      {job.dialog}
    </main>
  );
}

/** One opId per value: saving the same value again after a failure re-sends the failed write's opId. */
function opIdFor(pending: React.RefObject<{ value: string; opId: string } | null>, value: string): string {
  if (pending.current?.value !== value) pending.current = { value, opId: newOpId() };
  return pending.current.opId;
}

function NameRow({ initial, disabled }: { initial: string; disabled: boolean }) {
  const router = useRouter();
  const pending = useRef<{ value: string; opId: string } | null>(null);
  const [value, setValue] = useState(initial);
  const [saved, setSaved] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Follow the server only when it reports a value this row didn't save itself: the refresh after our own save
  // must not overwrite what is being typed meanwhile.
  const known = useRef(initial);
  useEffect(() => {
    if (initial === known.current) return;
    known.current = initial;
    setValue(initial);
    setSaved(initial);
  }, [initial]);
  const clean = value.trim().replace(/\s+/g, " ");
  const changed = clean !== saved;
  const localError = !clean ? "Enter a name." : clean.length > 80 ? "The name is too long (maximum 80 characters)." : null;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!changed || localError) {
      setError(localError);
      return;
    }
    setSaving(true);
    setError(null);
    const opId = opIdFor(pending, clean);
    const r = await callAction(() => saveDisplayNameAction(opId, clean));
    setSaving(false);
    if (!r.ok) {
      setError(r.error);
      toastError(r, "Name not saved");
      return;
    }
    pending.current = null;
    known.current = r.data.name;
    setSaved(r.data.name);
    setValue((v) => (v.trim().replace(/\s+/g, " ") === r.data.name ? r.data.name : v));
    toast.success("Name saved", { description: "New changes and notes show this name." });
    router.refresh();
  }

  return (
    <form onSubmit={save}>
      <SettingsRow
        title="Your name"
        htmlFor="display-name"
        description="Shown as the author of changes and notes in the history."
        below={error ? <p className="text-xs text-destructive" role="alert">{error}</p> : null}
      >
        <Input
          id="display-name"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
          maxLength={120}
          autoComplete="name"
          aria-invalid={Boolean(error) || undefined}
          className="h-8 w-full md:w-64"
        />
        <Button type="submit" variant={changed ? "default" : "outline"} disabled={disabled || saving || !changed}>
          {saving ? <Loader2 className="animate-spin" aria-hidden /> : null}
          Save
        </Button>
      </SettingsRow>
    </form>
  );
}

function TimeZoneRow({ initial, now, disabled }: { initial: string; now: string; disabled: boolean }) {
  const router = useRouter();
  const pending = useRef<{ value: string; opId: string } | null>(null);
  const inList = COMMON_ZONES.some((z) => z.tz === initial);
  const [choice, setChoice] = useState(inList ? initial : OTHER);
  const [other, setOther] = useState(inList ? "" : initial);
  const [saved, setSaved] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // As in NameRow: only a value this row didn't save itself replaces the current choice.
  const known = useRef(initial);
  useEffect(() => {
    if (initial === known.current) return;
    known.current = initial;
    const listed = COMMON_ZONES.some((z) => z.tz === initial);
    setChoice(listed ? initial : OTHER);
    setOther(listed ? "" : initial);
    setSaved(initial);
  }, [initial]);

  const wanted = choice === OTHER ? other.trim() : choice;
  const valid = knowsZone(wanted);
  const changed = wanted !== saved;
  const preview = useMemo(() => (valid ? when(now, wanted) : null), [valid, now, wanted]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!changed) return;
    if (!valid) {
      setError(`"${wanted}" is not a time zone this browser knows. Use a name like Asia/Singapore or Europe/London.`);
      return;
    }
    setSaving(true);
    setError(null);
    const opId = opIdFor(pending, wanted);
    const r = await callAction(() => saveTimeZoneAction(opId, wanted));
    setSaving(false);
    if (!r.ok) {
      setError(r.error);
      toastError(r, "Time zone not saved");
      return;
    }
    pending.current = null;
    known.current = r.data.timeZone;
    setSaved(r.data.timeZone);
    toast.success("Time zone saved", { description: `Dates now turn green at midnight in ${r.data.timeZone}.` });
    router.refresh();
  }

  return (
    <form onSubmit={save}>
      <SettingsRow
        title="Time zone"
        htmlFor="time-zone"
        description={
          <>
            Decides what “today” is: planned dates turn green at midnight in this zone. Default: Singapore.
            {preview ? (
              <span className="mt-1 block tabular-nums text-foreground/80">
                Now in {wanted}: {preview}
              </span>
            ) : null}
          </>
        }
        below={error ? <p className="text-xs text-destructive" role="alert">{error}</p> : null}
      >
        <Select
          value={choice}
          onValueChange={(v) => {
            setChoice(v);
            setError(null);
          }}
          disabled={disabled || saving}
        >
          <SelectTrigger id="time-zone" className="h-8 w-full md:w-64" aria-label="Time zone">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {COMMON_ZONES.map((z) => (
              <SelectItem key={z.tz} value={z.tz}>
                {z.label} <span className="text-muted-foreground">· {z.tz}</span>
              </SelectItem>
            ))}
            <SelectSeparator />
            <SelectItem value={OTHER}>Other time zone…</SelectItem>
          </SelectContent>
        </Select>
        {choice === OTHER ? (
          <Input
            value={other}
            onChange={(e) => {
              setOther(e.target.value);
              setError(null);
            }}
            placeholder="e.g. Asia/Seoul"
            aria-label="Other time zone (IANA name)"
            aria-invalid={(other.trim() !== "" && !valid) || undefined}
            className="h-8 w-full md:w-48"
            autoFocus
          />
        ) : null}
        <Button type="submit" variant={changed ? "default" : "outline"} disabled={disabled || saving || !changed || !wanted}>
          {saving ? <Loader2 className="animate-spin" aria-hidden /> : null}
          Save
        </Button>
      </SettingsRow>
    </form>
  );
}

function VerifyResult({ result, timeZone }: { result: VerifySummary; timeZone: string }) {
  const shown = result.mismatches.slice(0, 50);
  const unhashed = result.unhashed ? ` ${result.unhashed.toLocaleString("en-GB")} older ${result.unhashed === 1 ? "row has" : "rows have"} no fingerprint and could not be checked.` : "";
  if (!result.mismatches.length) {
    return (
      <Notice tone="success" title={`Checked ${result.checked.toLocaleString("en-GB")} history rows: all match`}>
        Nothing was changed outside the app.{unhashed}
      </Notice>
    );
  }
  return (
    <Notice
      tone="problem"
      title={`${result.mismatches.length} of ${result.checked.toLocaleString("en-GB")} history rows ${result.mismatches.length === 1 ? "was" : "were"} changed outside the app`}
    >
      <p className="mb-1.5">
        Their content no longer matches the fingerprint written by the app, so someone edited them directly in Notion. The rows are kept
        as they are; compare them with your latest backup.{unhashed}
      </p>
      <ul className="max-h-64 divide-y overflow-auto rounded-md border bg-background">
        {shown.map((m) => (
          <li key={m.id} className="flex items-center gap-3 px-2 py-1.5 text-xs">
            <FileWarning className="state-b size-3.5 shrink-0 text-[var(--s-solid)]" aria-hidden />
            <span className="min-w-0 flex-1 truncate" title={m.summary}>
              {m.summary}
            </span>
            <span className="shrink-0 tabular-nums text-muted-foreground">{when(m.occurredAt, timeZone)}</span>
          </li>
        ))}
      </ul>
      {result.mismatches.length > shown.length ? (
        <p className="mt-1 text-xs text-muted-foreground">and {result.mismatches.length - shown.length} more.</p>
      ) : null}
    </Notice>
  );
}

function NotionRow({ status, settings }: { status: SetupStatusDTO; settings: SettingsData }) {
  const okCount = status.databases.filter((d) => d.ok).length;
  const mode =
    status.mode === "notion" ? (
      <Badge variant="outline" className="state-d border-[var(--s-border)] bg-[var(--s-bg)] text-[var(--s-fg)]">
        <CircleCheck aria-hidden />
        Connected to Notion
      </Badge>
    ) : status.mode === "fake" ? (
      <Badge variant="secondary">
        <Database aria-hidden />
        Local test data (no Notion token)
      </Badge>
    ) : (
      <Badge variant="destructive">Not connected</Badge>
    );
  return (
    <SettingsRow
      title="Notion connection"
      description="Where the app keeps its data. Browse it in Notion, but make changes in the app so history and colours stay correct."
      below={
        <div className="space-y-2">
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs">
            <dt className="text-muted-foreground">Status</dt>
            <dd>{mode}</dd>
            <dt className="text-muted-foreground">Notion page</dt>
            <dd>
              {status.parentPage ? (
                status.parentPage.url ? (
                  <a
                    href={status.parentPage.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="inline-flex items-center gap-0.5 font-medium text-primary underline-offset-4 hover:underline"
                  >
                    {status.parentPage.title}
                    <ExternalLink className="size-3" aria-hidden />
                    <span className="sr-only"> (opens Notion in a new tab)</span>
                  </a>
                ) : (
                  <span className="font-medium">{status.parentPage.title}</span>
                )
              ) : (
                "Not found"
              )}
            </dd>
            <dt className="text-muted-foreground">Databases</dt>
            <dd className="tabular-nums">
              {okCount} of {status.databases.length} ready
              {status.databases.some((d) => !d.ok) ? (
                <span className="text-muted-foreground"> (missing: {status.databases.filter((d) => !d.ok).map((d) => d.name).join(", ")})</span>
              ) : null}
            </dd>
            <dt className="text-muted-foreground">Template</dt>
            <dd className="tabular-nums">
              Revision {settings.templateRevision}
              {settings.seedAppliedAt ? <span className="text-muted-foreground"> · milestones loaded {when(settings.seedAppliedAt, settings.timeZone)}</span> : null}
            </dd>
          </dl>
          {status.problems.map((p) => (
            <Notice key={p} tone="problem">
              {p}
            </Notice>
          ))}
          {status.warnings?.map((w) => (
            <Notice
              key={w}
              tone="warning"
              action={
                <Button asChild size="xs" variant="outline">
                  <Link href="/setup">Open Setup</Link>
                </Button>
              }
            >
              {w}
            </Notice>
          ))}
        </div>
      }
    />
  );
}
