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

/** State of one step row: done, the one to do now, or later. While Notion is busy, step 1 is done and nothing is current. */
export function setupStepState(step: SetupStepKey, current: SetupStepKey | "busy" | "ready"): "done" | "current" | "todo" {
  const order: SetupStepKey[] = ["connect", "page", "databases", "seed"];
  if (current === "ready") return "done";
  if (current === "busy") return step === "connect" ? "done" : "todo";
  const i = order.indexOf(step);
  const c = order.indexOf(current);
  return i < c ? "done" : i === c ? "current" : "todo";
}
