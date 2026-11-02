import "server-only";
/**
 * Cache tags. Server Actions call `updateTag(TAGS.x)` (Route Handlers `revalidateTag(TAGS.x, { expire: 0 })`)
 * after writes that change what the tag covers.
 *
 * - library: milestones, template flow and revision (Library, Template Flow, import/seed/reset).
 * - projectFields: project field definitions.
 * - settings: time zone, display name, backup time, seed marker.
 * - schema: the Notion schema registry (database and property ids), shared by all server instances. Setup, "Check
 *   again", "Reload from Notion" and "Start over" refresh it; the repo also drops it when it meets a stale id or finds
 *   it out of date (while a page renders, right after the response).
 * Projects, steps, notes, attachments and History are never cached.
 */
export const TAGS = {
  library: "library",
  projectFields: "project-fields",
  settings: "settings",
  schema: "schema",
} as const;

export type CacheTag = (typeof TAGS)[keyof typeof TAGS];

/** Seconds before a cached entry is refreshed even without a tag update. */
export const CACHE_REVALIDATE_SECONDS = 60;

/** The schema registry changes only through Setup (which refreshes the tag): an hour is plenty. */
export const SCHEMA_REVALIDATE_SECONDS = 3600;
