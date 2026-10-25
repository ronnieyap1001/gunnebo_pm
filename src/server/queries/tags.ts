import "server-only";
/**
 * Cache tags. Server Actions call `updateTag(TAGS.x)` (Route Handlers `revalidateTag(TAGS.x, { expire: 0 })`)
 * after writes that change what the tag covers.
 *
 * - library: milestones, template flow and revision (Library, Template Flow, import/seed/reset).
 * - projectFields: project field definitions.
 * - settings: time zone, display name, backup time, seed marker.
 * Projects, steps, notes, attachments and History are never cached.
 */
export const TAGS = {
  library: "library",
  projectFields: "project-fields",
  settings: "settings",
} as const;

export type CacheTag = (typeof TAGS)[keyof typeof TAGS];

/** Seconds before a cached entry is refreshed even without a tag update. */
export const CACHE_REVALIDATE_SECONDS = 60;
