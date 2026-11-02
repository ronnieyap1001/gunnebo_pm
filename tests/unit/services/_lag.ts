/**
 * A fake Notion whose queries lag behind writes, driven by the real Notion repo and services.
 *
 * Every Notion call advances the fake clock by `perCallMs` (the time one request takes), and calls go through the
 * app's 3-in-flight gate, so the clock moves the way it does on Vercel. New pages stay invisible to dataSources.query
 * for `queryLagMs` of that clock (see FakeNotionOptions.queryLagMs), so read-after-write through a query fails exactly
 * when Notion's lag exceeds the time between two batches. Deterministic and fast: nothing sleeps for real.
 */
import { randomUUID } from "node:crypto";
import type { Ymd } from "@/domain/types";
import { withConcurrencyGate, type NotionLike } from "@/server/notion/client";
import { createFakeNotion, type FakeNotion } from "@/server/notion/fake";
import { createRegistryHandle } from "@/server/notion/registry";
import { createNotionRepo } from "@/server/repo/notionRepo";
import type { Repo } from "@/server/repo/types";
import { makeCtx, type Ctx } from "@/server/services/context";
import { FAKE_OPTS, runSetup } from "../notion/helpers";

export const LAG_TODAY: Ymd = "2026-10-25";

/** Wraps every Notion method so each call first advances the fake clock (`tick` gets the method, e.g. 'pages.create'). */
function ticking<T extends object>(obj: T, tick: (method: string, args: unknown[]) => void, path = ""): T {
  return new Proxy(obj, {
    get(target, prop, recv) {
      const v = Reflect.get(target, prop, recv);
      if (prop === "fake") return v;
      const name = path ? `${path}.${String(prop)}` : String(prop);
      if (typeof v === "function") {
        return async (...args: unknown[]) => {
          tick(name, args);
          return (v as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      if (v && typeof v === "object") return ticking(v as object, tick, name);
      return v;
    },
  });
}

export interface LagWorld {
  /** The raw fake (no clock tick, no gate): for assertions. */
  raw: FakeNotion;
  /** What the app talks to: ticking clock + 3-in-flight gate. */
  notion: NotionLike;
  /** One server instance (remembers ids it wrote). */
  repo: Repo;
  /** A context for one browser call (the action's timestamp is the fake clock now). */
  ctx(opId?: string, r?: Repo): Ctx;
  /** Time between two browser calls. */
  advance(ms: number): void;
  now(): number;
  /** A second, cold server instance on the same Notion (no row ids remembered; registry from the shared cache). */
  coldRepo(): Repo;
  /** Runs before every Notion call the app makes (after the clock tick); throw from it to make that call fail unsent. */
  beforeCall: ((method: string, args: unknown[]) => void) | null;
}

export async function lagWorld(opts: { queryLagMs?: number; perCallMs?: number } = {}): Promise<LagWorld> {
  let now = Date.UTC(2026, 9, 25, 2, 0, 0);
  const raw = createFakeNotion({ now: () => now, queryLagMs: opts.queryLagMs ?? 2_000, latencyMs: 1 });
  await runSetup(raw);
  now += 60_000;
  const perCall = opts.perCallMs ?? 100;
  const notion = withConcurrencyGate(
    ticking(raw, (method, args) => {
      now += perCall;
      world.beforeCall?.(method, args);
    }),
    3,
  );
  const handle = createRegistryHandle(notion, FAKE_OPTS);
  const repo = createNotionRepo(notion, handle);
  const world: LagWorld = {
    beforeCall: null,
    raw,
    notion,
    repo,
    ctx: (opId = randomUUID(), r = repo) =>
      makeCtx(r, { now: new Date(now).toISOString(), today: LAG_TODAY, timeZone: "Asia/Singapore", actor: "Me", opId }),
    advance: (ms) => {
      now += ms;
    },
    now: () => now,
    // The schema registry comes from the cache all instances share (no discovery); nothing else is remembered.
    coldRepo: () => createNotionRepo(notion, handle),
  };
  return world;
}

/** Calls `cont` the way the browser's runJob does: one call after another, `gapMs` apart. */
export async function driveJob(w: LagWorld, cont: () => Promise<{ done: boolean }>, gapMs = 500, limit = 200): Promise<number> {
  for (let calls = 1; calls <= limit; calls++) {
    w.advance(gapMs);
    if ((await cont()).done) return calls;
  }
  throw new Error("job did not finish");
}
