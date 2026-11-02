/**
 * Setup screen helpers.
 * - UI-3: after "Load the 64 milestones" finishes, the screen checks again a few times before it shows step 4 again,
 *   because another server instance may not see the seed's marker in Notion's search for a few seconds. The checks are
 *   bounded (the tab never waits forever) and stop as soon as there is something else to show.
 * - CR-1: "Check again" on the "Everything is set up" card says what it found, and never contradicts the step shown.
 */
import { describe, expect, it } from "vitest";
import { checkAgainToast, checkUntilSeeded } from "@/components/admin/setup-steps";

describe('what "Check again" says (CR-1)', () => {
  it("from ready: a change in Notion points to the step below; a busy Notion is only busy", () => {
    expect(checkAgainToast("ready", "ready")).toEqual({ tone: "info", text: "Everything is set up." });
    expect(checkAgainToast("ready", "databases")).toEqual({ tone: "warning", text: "Something changed in Notion. Follow the step marked below." });
    // The busy notice says nothing needs to change in Notion, and no step is marked: the toast must not say otherwise.
    const busy = checkAgainToast("ready", "busy");
    expect(busy.tone).toBe("warning");
    expect(busy.text).not.toMatch(/changed|step marked/i);
    expect(busy.text).toMatch(/busy/i);
  });

  it("from another step: unchanged, done, or busy", () => {
    expect(checkAgainToast("databases", "databases")).toEqual({ tone: "info", text: "Nothing has changed yet." });
    expect(checkAgainToast("page", "databases")).toEqual({ tone: "success", text: "Thanks, that worked." });
    expect(checkAgainToast("seed", "busy").text).not.toMatch(/worked/i);
  });
});

type S = { mode: "notion"; parentPage: { id: string; title: string }; schemaReady: boolean; seeded: boolean; openJobs: { kind: string }[] };
const seed: S = { mode: "notion", parentPage: { id: "p", title: "Gunnebo PM" }, schemaReady: true, seeded: false, openJobs: [] };
const ready: S = { ...seed, seeded: true };

function run(answers: (S | null)[]) {
  let calls = 0;
  const waits: number[] = [];
  const done = checkUntilSeeded(
    async () => answers[Math.min(calls++, answers.length - 1)],
    { sleep: async (ms) => void waits.push(ms) },
  );
  return { done, calls: () => calls, waits };
}

describe("checking again after the seed (UI-3)", () => {
  it("one check when it already says ready", async () => {
    const r = run([ready]);
    expect(await r.done).toBe(ready);
    expect(r.calls()).toBe(1);
    expect(r.waits).toEqual([]);
  });

  it("checks again 2 s apart while step 4 shows, and stops at ready", async () => {
    const r = run([seed, seed, ready]);
    expect(await r.done).toBe(ready);
    expect(r.calls()).toBe(3);
    expect(r.waits).toEqual([2_000, 2_000]);
  });

  it("gives up after 5 checks (about 8 s): step 4 shows again", async () => {
    const r = run([seed]);
    expect(await r.done).toBe(seed);
    expect(r.calls()).toBe(5);
    expect(r.waits.reduce((a, b) => a + b, 0)).toBe(8_000);
  });

  it("stops at once when a check fails, or when the load is still unfinished (Continue loading shows)", async () => {
    const failed = run([null, ready]);
    expect(await failed.done).toBeNull();
    expect(failed.calls()).toBe(1);
    const open = { ...seed, openJobs: [{ kind: "import" }] };
    const unfinished = run([open, ready]);
    expect(await unfinished.done).toBe(open);
    expect(unfinished.calls()).toBe(1);
  });
});
