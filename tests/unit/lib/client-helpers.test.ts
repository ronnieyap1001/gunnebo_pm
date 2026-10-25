import { describe, expect, it, vi } from "vitest";
import { enqueue, pendingCount } from "@/lib/write-queue";
import { runJob } from "@/lib/run-job";
import { matchHotkey } from "@/lib/hotkeys";

describe("write queue", () => {
  it("runs tasks for one key strictly in order, one at a time", async () => {
    const log: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const task = (name: string, ms: number) => async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      log.push(`start ${name}`);
      await new Promise((r) => setTimeout(r, ms));
      log.push(`end ${name}`);
      inFlight--;
      return name;
    };
    const results = await Promise.all([enqueue("p1", task("a", 20)), enqueue("p1", task("b", 1)), enqueue("p1", task("c", 5))]);
    expect(results).toEqual(["a", "b", "c"]);
    expect(log).toEqual(["start a", "end a", "start b", "end b", "start c", "end c"]);
    expect(maxInFlight).toBe(1);
    expect(pendingCount("p1")).toBe(0);
  });

  it("keeps going after a failed task", async () => {
    const failing = enqueue("p2", async () => {
      throw new Error("boom");
    });
    const next = enqueue("p2", async () => "ok");
    await expect(failing).rejects.toThrow("boom");
    await expect(next).resolves.toBe("ok");
  });

  it("runs different keys in parallel", async () => {
    let concurrent = 0;
    let max = 0;
    const t = async () => {
      concurrent++;
      max = Math.max(max, concurrent);
      await new Promise((r) => setTimeout(r, 10));
      concurrent--;
    };
    await Promise.all([enqueue("x", t), enqueue("y", t)]);
    expect(max).toBe(2);
  });
});

describe("runJob", () => {
  it("steps until done and reports progress", async () => {
    let n = 0;
    const progress = vi.fn();
    const res = await runJob(async () => {
      n++;
      return { ok: true, data: { done: n === 3, message: `step ${n}` } };
    }, { onProgress: progress });
    expect(res.ok).toBe(true);
    expect(n).toBe(3);
    expect(progress).toHaveBeenCalledTimes(3);
  });

  it("gives up with a plain message on a non-busy error", async () => {
    const res = await runJob(async () => ({ ok: false, error: "Code taken", code: "CODE_TAKEN" }));
    expect(res).toEqual({ ok: false, error: "Code taken", code: "CODE_TAKEN" });
  });

  it("retries BUSY with backoff up to the limit", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const p = runJob(async () => {
      calls++;
      return { ok: false, error: "busy", code: "BUSY" };
    }, { maxBusyRetries: 2 });
    await vi.runAllTimersAsync();
    const res = await p;
    vi.useRealTimers();
    expect(calls).toBe(3);
    expect(res.ok).toBe(false);
  });
});

describe("matchHotkey", () => {
  const ev = (key: string, mods: Partial<KeyboardEvent> = {}) =>
    ({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods }) as KeyboardEvent;

  it("matches plain keys case-insensitively", () => {
    expect(matchHotkey(ev("F"), "f")).toBe(true);
    expect(matchHotkey(ev("f"), "l")).toBe(false);
  });
  it("requires mod for mod combos and rejects mod on plain keys", () => {
    expect(matchHotkey(ev("k", { metaKey: true }), "mod+k")).toBe(true);
    expect(matchHotkey(ev("k", { ctrlKey: true }), "mod+k")).toBe(true);
    expect(matchHotkey(ev("k"), "mod+k")).toBe(false);
    expect(matchHotkey(ev("c", { metaKey: true }), "c")).toBe(false);
  });
});
