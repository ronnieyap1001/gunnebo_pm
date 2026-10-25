/**
 * Slugs for milestone keys, project-field keys and choice ids.
 * Pattern: lowercase ASCII letters, digits and '-', starting with a letter or digit.
 */

/** Keys and choice ids in template files must match this. */
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export const DEFAULT_SLUG_MAX_LENGTH = 48;

/** 32-bit FNV-1a hash of a string (UTF-16 code units). Deterministic, not cryptographic. */
export function fnv1a32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Six base-36 characters derived from a string. */
export function shortHash(text: string): string {
  return fnv1a32(text).toString(36).padStart(7, "0").slice(-6);
}

/** The bare slug of a label (no uniqueness, no fallback). May be empty. */
export function baseSlug(label: string, maxLen: number = DEFAULT_SLUG_MAX_LENGTH): string {
  const slug = String(label ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip accents: 'Café' -> 'Cafe'
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const limit = Math.max(1, Math.floor(maxLen));
  if (slug.length <= limit) return slug;
  let cut = slug.slice(0, limit);
  if (slug[limit] !== "-") {
    // We cut inside a word: go back to the previous word boundary when there is one.
    const boundary = cut.lastIndexOf("-");
    if (boundary > 0) cut = cut.slice(0, boundary);
  }
  return cut.replace(/-+$/g, "");
}

/**
 * A unique slug for a label: lowercase ASCII [a-z0-9-], truncated at a word boundary to `maxLen` (48) characters
 * before any numeric suffix ('-2', '-3', ...). `taken` should include archived ids. A label with no ASCII letters or
 * digits gets 'c-' + 6 base-36 characters derived from the label and the size of `taken` (no randomness).
 */
export function slugify(label: string, taken: Iterable<string>, maxLen: number = DEFAULT_SLUG_MAX_LENGTH): string {
  const takenSet = new Set(taken);
  let base = baseSlug(label, maxLen);
  if (!base) base = `c-${shortHash(`${String(label ?? "")}\u0000${takenSet.size}`)}`;
  if (!takenSet.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!takenSet.has(candidate)) return candidate;
  }
}

/** Name normalisation for matching (e.g. linking a project-only step to a new milestone). */
export function normalizeName(name: string): string {
  return String(name ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}
