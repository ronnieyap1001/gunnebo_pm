import type { SetupStatus } from "@/server/repo/types";

/** The Setup screen's steps, in order. */
export type SetupStepKey = "connect" | "page" | "databases" | "seed";

/**
 * Which step Setup shows as the one to do now.
 * - 'connect': no NOTION_TOKEN, or Notion rejected it (copy the secret again).
 * - 'busy': Notion was busy or did not answer, so the app cannot tell what is missing: "try again", never "create
 *   the page" (that would make people create a second page with the same name).
 */
export function currentSetupStep(s: Pick<SetupStatus, "mode" | "parentPage" | "schemaReady" | "seeded" | "errorKind">): SetupStepKey | "busy" | "ready" {
  if (s.mode === "unconfigured" || s.errorKind === "tokenRejected") return "connect";
  if (s.errorKind === "busy") return "busy";
  if (!s.parentPage) return "page";
  if (!s.schemaReady) return "databases";
  if (!s.seeded) return "seed";
  return "ready";
}

type Step = ReturnType<typeof currentSetupStep>;

/**
 * What "Check again" says, from the step shown before the check and the one shown after it. A busy Notion is only
 * busy: the notice below says nothing needs to change, so the toast must not say something changed.
 */
export function checkAgainToast(before: Step, next: Step): { tone: "info" | "warning" | "success"; text: string } {
  if (next === before) return { tone: "info", text: next === "ready" ? "Everything is set up." : "Nothing has changed yet." };
  if (next === "busy") return { tone: "warning", text: "Notion is busy right now. Wait a minute, then click Check again." };
  if (before === "ready") return { tone: "warning", text: "Something changed in Notion. Follow the step marked below." };
  return { tone: "success", text: "Thanks, that worked." };
}

/**
 * After the seed: Notion's search can take a few seconds to show its marker when another server instance answers
 * the check, so check up to `tries` times, `gapMs` apart (about 8 s), before showing step 4 again. Stops at once on a
 * failed check (null), at any other step, or while the load is still unfinished ("Continue loading" shows then).
 */
export async function checkUntilSeeded<S extends Parameters<typeof currentSetupStep>[0] & { openJobs: { kind: string }[] }>(
  check: () => Promise<S | null>,
  opts: { tries?: number; gapMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<S | null> {
  const tries = opts.tries ?? 5;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let i = 1; ; i++) {
    const s = await check();
    if (!s || currentSetupStep(s) !== "seed" || s.openJobs.some((j) => j.kind === "import") || i >= tries) return s;
    await sleep(opts.gapMs ?? 2_000);
  }
}

/** State of one step row: done, the one to do now, or later. While Notion is busy, step 1 is done and nothing is current. */
export function setupStepState(step: SetupStepKey, current: SetupStepKey | "busy" | "ready"): "done" | "current" | "todo" {
  const order: SetupStepKey[] = ["connect", "page", "databases", "seed"];
  if (current === "ready") return "done";
  if (current === "busy") return step === "connect" ? "done" : "todo";
  const i = order.indexOf(step);
  const c = order.indexOf(current);
  return i < c ? "done" : i === c ? "current" : "todo";
}
