import "server-only";
/**
 * Next-specific wrappers (the only module of the business layer that imports next/*).
 *
 * Library/template, project fields and settings are cached with unstable_cache (tags in ./tags, revalidate 60 s);
 * projects, steps, notes, attachments and History are always read fresh. Server Components call these; Server
 * Actions call `updateTag(TAGS.x)` after writes and build their context with `getActionCtx`.
 *
 * The Notion schema registry (database and property ids, about 20 Notion requests to discover) is shared by every
 * server instance through unstable_cache (tag 'schema', revalidate 1 h); see shareSchemaRegistry below.
 */
import { createHash } from "node:crypto";
import { revalidateTag, unstable_cache } from "next/cache";
import { after } from "next/server";
import { todayIn } from "@/domain/dates";
import type { DayContext, EventSource, ProjectField, Template } from "@/domain/types";
import { fakeNotionFile, getNotion, storageMode } from "@/server/notion/client";
import { discoverShareableRegistry, parentTitleFor } from "@/server/notion/registry";
import { SCHEMA_VERSION } from "@/server/notion/schema";
import { getRepo, getStorageAdmin, setRegistryLoader } from "@/server/repo";
import { getAppSettings, type AppSettings } from "@/server/services/admin";
import { makeCtx, type Ctx } from "@/server/services/context";
import { getTemplate } from "@/server/services/library";
import { listProjectFields } from "@/server/services/projectFields";
import { reconcileProject } from "@/server/services/projects";
import * as archiveQ from "./archive";
import type { ReadDeps } from "./common";
import * as historyQ from "./history";
import * as libraryQ from "./library";
import * as portfolioQ from "./portfolio";
import * as projectsQ from "./projects";
import * as setupQ from "./setup";
import { CACHE_REVALIDATE_SECONDS, SCHEMA_REVALIDATE_SECONDS, TAGS } from "./tags";

/**
 * One schema discovery for all server instances: a cold instance reads the registry from Next's data cache instead
 * of making ~20 Notion requests, and "Check again", "Reload from Notion", Setup and "Start over" (which revalidate the
 * 'schema' tag) reach every instance. Only a ready registry is cached (discoverShareableRegistry throws any other one
 * back to the instance that asked); when the data cache is unavailable the repo discovers directly. The key names the
 * environment, the parent page setting and the token (hashed), and with local test data the data file, so another
 * workspace, page or test file never reuses an entry.
 */
function shareSchemaRegistry(): void {
  const env = process.env;
  const mode = storageMode(env);
  const tokenHash = env.NOTION_TOKEN ? createHash("sha256").update(env.NOTION_TOKEN).digest("hex").slice(0, 16) : "none";
  const fakeFile = mode === "fake" ? (fakeNotionFile(env) ?? ":memory:") : "";
  const loader = unstable_cache(
    async () => discoverShareableRegistry(getNotion()),
    ["gpm", TAGS.schema, String(SCHEMA_VERSION), mode, parentTitleFor(env), env.NOTION_PARENT_PAGE_ID ?? "", tokenHash, fakeFile],
    { tags: [TAGS.schema], revalidate: SCHEMA_REVALIDATE_SECONDS },
  );
  setRegistryLoader(loader, () => {
    try {
      revalidateTag(TAGS.schema, { expire: 0 });
    } catch {
      // Not allowed while rendering: this instance rediscovers directly; the shared entry expires on its own.
    }
  });
}
shareSchemaRegistry();

export const getCachedTemplate: () => Promise<Template> = unstable_cache(async () => getTemplate(getRepo()), ["gpm", "template"], {
  tags: [TAGS.library],
  revalidate: CACHE_REVALIDATE_SECONDS,
});

export const getCachedProjectFields: () => Promise<ProjectField[]> = unstable_cache(
  async () => listProjectFields(getRepo(), { includeArchived: true }),
  ["gpm", "project-fields"],
  { tags: [TAGS.projectFields], revalidate: CACHE_REVALIDATE_SECONDS },
);

/** Includes the template revision, so it is also tagged 'library'. */
export const getCachedAppSettings: () => Promise<AppSettings> = unstable_cache(async () => getAppSettings(getRepo()), ["gpm", "settings"], {
  tags: [TAGS.settings, TAGS.library],
  revalidate: CACHE_REVALIDATE_SECONDS,
});

async function deps(): Promise<ReadDeps> {
  const [template, projectFields] = await Promise.all([getCachedTemplate(), getCachedProjectFields()]);
  return { template, projectFields };
}

/** Today in the configured time zone, computed once per request on the server. */
export async function getDay(now: Date = new Date()): Promise<DayContext> {
  const { timeZone } = await getCachedAppSettings();
  return { today: todayIn(timeZone, now), timeZone };
}

/** Context for a Server Action: opId from the browser, actor = display name, day from the configured time zone. */
export async function getActionCtx(input: {
  opId: string;
  source?: EventSource;
  correlationId?: string;
  externalRef?: string;
}): Promise<Ctx> {
  const s = await getCachedAppSettings();
  return makeCtx(getRepo(), {
    opId: input.opId,
    source: input.source ?? "MANUAL",
    actor: s.displayName,
    timeZone: s.timeZone,
    correlationId: input.correlationId,
    externalRef: input.externalRef,
  });
}

export async function getLibraryView(): Promise<libraryQ.LibraryView> {
  return libraryQ.getLibraryView(getRepo(), await deps());
}

export async function getTemplateView(): Promise<libraryQ.TemplateView> {
  return libraryQ.getTemplateView(getRepo(), await deps());
}

export async function getProjectsList(opts: { includeArchived?: boolean } = {}): Promise<projectsQ.ProjectListRow[]> {
  const [day, d] = await Promise.all([getDay(), deps()]);
  return projectsQ.getProjectsList(getRepo(), day, opts, d);
}

export async function getProjectPageData(id: string): Promise<projectsQ.ProjectPageData | null> {
  const [day, d] = await Promise.all([getDay(), deps()]);
  return projectsQ.getProjectPageData(getRepo(), day, id, d);
}

/** After the project page has rendered: recompute Cells / Progress / Current and PATCH only when they differ. */
export function scheduleReconcile(projectId: string): void {
  after(async () => {
    try {
      const s = await getCachedAppSettings();
      await reconcileProject(makeCtx(getRepo(), { source: "SYSTEM", actor: s.displayName, timeZone: s.timeZone }), projectId);
    } catch {
      // Best effort: the next page view tries again.
    }
  });
}

export async function getCellDetails(stepId: string): Promise<projectsQ.CellDetails | null> {
  return projectsQ.getCellDetails(getRepo(), await getDay(), stepId);
}

export async function getPortfolioData(filters?: portfolioQ.PortfolioFilters): Promise<portfolioQ.PortfolioData> {
  const [day, d] = await Promise.all([getDay(), deps()]);
  return portfolioQ.getPortfolioData(getRepo(), day, filters, d);
}

export async function getArchiveData(opts: { projectId?: string } = {}): Promise<archiveQ.ArchiveData> {
  return archiveQ.getArchiveData(getRepo(), opts, await deps());
}

export function getStepHistory(stepId: string, cursor: string | null = null, limit?: number): Promise<historyQ.HistoryPageDTO> {
  return historyQ.getStepHistory(getRepo(), stepId, cursor, limit);
}

export function getProjectHistory(
  projectId: string,
  filters: historyQ.HistoryFilters = {},
  cursor: string | null = null,
  limit?: number,
): Promise<historyQ.HistoryPageDTO> {
  return historyQ.getProjectHistory(getRepo(), projectId, filters, cursor, limit);
}

export function getAllHistory(filters: historyQ.HistoryFilters = {}, cursor: string | null = null, limit?: number): Promise<historyQ.HistoryPageDTO> {
  return historyQ.getAllHistory(getRepo(), filters, cursor, limit);
}

export function getTemplateSnapshots(cursor: string | null = null) {
  return historyQ.getTemplateSnapshots(getRepo(), cursor);
}

/** Never cached: Setup decides whether the app can run at all. */
export function getSetupStatus(): Promise<setupQ.SetupStatusDTO> {
  // getRepo() throws while Notion isn't configured (no NOTION_TOKEN on Vercel); the admin still reports that state.
  let repo: ReturnType<typeof getRepo> | undefined;
  try {
    repo = getRepo();
  } catch {
    repo = undefined;
  }
  return setupQ.getSetupStatus(getStorageAdmin(), repo);
}

export function getSettingsData(): Promise<setupQ.SettingsData> {
  return setupQ.getSettingsData(getRepo());
}
