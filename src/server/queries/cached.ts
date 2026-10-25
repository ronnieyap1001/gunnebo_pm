import "server-only";
/**
 * Next-specific wrappers (the only module of the business layer that imports next/*).
 *
 * Library/template, project fields and settings are cached with unstable_cache (tags in ./tags, revalidate 60 s);
 * projects, steps, notes, attachments and History are always read fresh. Server Components call these; Server
 * Actions call `updateTag(TAGS.x)` after writes and build their context with `getActionCtx`.
 */
import { unstable_cache } from "next/cache";
import { after } from "next/server";
import { todayIn } from "@/domain/dates";
import type { DayContext, EventSource, ProjectField, Template } from "@/domain/types";
import { getRepo, getStorageAdmin } from "@/server/repo";
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
import { CACHE_REVALIDATE_SECONDS, TAGS } from "./tags";

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
