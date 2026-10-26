/**
 * runJob and a job another tab or window is running (DS-1): one driver id per run, RUNNING_ELSEWHERE waits (with the
 * plain message) for as long as the server says so, and a step's wait hint is honoured.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActionResult } from "@/lib/action-result";
import { runJob, RUNNING_ELSEWHERE, RUNNING_ELSEWHERE_MESSAGE, type JobProgress } from "@/lib/run-job";

afterEach(() => {
  vi.useRealTimers();
});

const progress = (p: JobProgress): ActionResult<JobProgress> => ({ ok: true, data: p });

describe("runJob with a driver id", () => {
  it("passes the same driver id to every step of one run, and a new one to the next run", async () => {
    const seen: string[] = [];
    let n = 0;
    const step = async (driver: string) => {
      seen.push(driver);
      n++;
      return progress({ done: n % 3 === 0, message: `step ${n}` });
    };
    await runJob(step);
    await runJob(step);
    expect(seen).toHaveLength(6);
    expect(new Set(seen.slice(0, 3)).size).toBe(1);
    expect(new Set(seen.slice(3)).size).toBe(1);
    expect(seen[0]).not.toBe(seen[3]);
    expect(seen[0]).toMatch(/^[A-Za-z0-9-]{8,64}$/);
  });

  it("keeps the same driver id across a BUSY retry (the run carries on at once on the server)", async () => {
    vi.useFakeTimers();
    const seen: string[] = [];
    let n = 0;
    const p = runJob(async (driver) => {
      seen.push(driver);
      n++;
      if (n === 1) return { ok: false, error: "busy", code: "BUSY" };
      return progress({ done: true, message: "done" });
    });
    await vi.runAllTimersAsync();
    expect((await p).ok).toBe(true);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(seen[1]);
  });

  it("waits while another tab or window runs the job, says so, and does not count the waits as steps", async () => {
    vi.useFakeTimers();
    const shown: string[] = [];
    let n = 0;
    const p = runJob(
      async () => {
        n++;
        if (n <= 12) return progress({ done: false, message: "x", fraction: n / 20, code: RUNNING_ELSEWHERE, retryInMs: 3000 });
        return progress({ done: true, message: "Project ready" });
      },
      { maxSteps: 3, onProgress: (q) => shown.push(q.message) },
    );
    await vi.runAllTimersAsync();
    const res = await p;
    expect(res.ok).toBe(true);
    expect(n).toBe(13);
    expect(shown.slice(0, 12).every((m) => m === RUNNING_ELSEWHERE_MESSAGE)).toBe(true);
    expect(shown.at(-1)).toBe("Project ready");
  });

  it("calls again only after the wait the server asks for", async () => {
    vi.useFakeTimers();
    const times: number[] = [];
    let n = 0;
    const p = runJob(async () => {
      times.push(Date.now());
      n++;
      if (n === 1) return progress({ done: false, message: "Other tab", code: RUNNING_ELSEWHERE, retryInMs: 2500 });
      if (n === 2) return progress({ done: false, message: "Checking Notion for duplicate rows", retryInMs: 2000 });
      return progress({ done: true, message: "Template updated" });
    });
    await vi.runAllTimersAsync();
    await p;
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(2500);
    expect(times[2] - times[1]).toBeGreaterThanOrEqual(2000);
  });

  it("stops waiting when aborted", async () => {
    vi.useFakeTimers();
    const ctl = new AbortController();
    let n = 0;
    const p = runJob(
      async () => {
        if (++n === 3) ctl.abort();
        return progress({ done: false, message: "x", code: RUNNING_ELSEWHERE, retryInMs: 1000 });
      },
      { signal: ctl.signal },
    );
    await vi.runAllTimersAsync();
    expect(await p).toMatchObject({ ok: false, code: "ABORTED" });
  });
});
