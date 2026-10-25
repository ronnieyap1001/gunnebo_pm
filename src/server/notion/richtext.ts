import "server-only";
import type { PropValue, RichTextRequest } from "./client";
import { ValueTooLargeError } from "./errors";

/** Notion limits: 2,000 characters per rich text item, 100 items per array. */
export const RICH_TEXT_ITEM_MAX = 2000;
export const RICH_TEXT_MAX_ITEMS = 100;

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/**
 * Splits `s` into pieces of at most `max` UTF-16 code units, never between the two halves of a
 * surrogate pair (so an emoji is never cut in half).
 */
export function splitText(s: string, max = RICH_TEXT_ITEM_MAX): string[] {
  if (max < 2) throw new Error("splitText: max must be at least 2");
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    let end = Math.min(i + max, s.length);
    if (end < s.length && isHighSurrogate(s.charCodeAt(end - 1))) end -= 1;
    out.push(s.slice(i, end));
    i = end;
  }
  return out;
}

/** Cuts `s` to at most `max` UTF-16 units without splitting a surrogate pair; adds '…' when cut. */
export function truncateText(s: string, max: number): string {
  if (s.length <= max) return s;
  let end = max - 1;
  if (end > 0 && isHighSurrogate(s.charCodeAt(end - 1))) end -= 1;
  return `${s.slice(0, end)}…`;
}

/**
 * Text → rich text items of ≤ 2,000 units each. '' → [] (the API rejects empty text items).
 * Throws ValueTooLargeError above 100 items (200,000 characters) before anything is sent.
 */
export function textToRichText(s: string | null | undefined, field = "This text"): RichTextRequest[] {
  if (!s) return [];
  const parts = splitText(s);
  if (parts.length > RICH_TEXT_MAX_ITEMS) {
    throw new ValueTooLargeError(
      `${field} is too long to store in Notion (${s.length.toLocaleString("en-US")} characters; the limit is ${(RICH_TEXT_ITEM_MAX * RICH_TEXT_MAX_ITEMS).toLocaleString("en-US")}).`,
      { detail: `${parts.length} rich text items` },
    );
  }
  return parts.map((content) => ({ type: "text", text: { content } }));
}

type RichTextLike = { plain_text?: string; text?: { content?: string } };

/** Joins every item's plain_text, whatever the item boundaries (Notion may merge or re-split items). */
export function richTextToText(items: readonly RichTextLike[] | null | undefined): string {
  if (!items) return "";
  let s = "";
  for (const it of items) s += it.plain_text ?? it.text?.content ?? "";
  return s;
}

/** JSON value → chunked rich text. null / undefined → [] (read back as the fallback). */
export function jsonToRichText(value: unknown, field = "This value"): RichTextRequest[] {
  if (value === undefined || value === null) return [];
  return textToRichText(JSON.stringify(value), field);
}

/** Chunked rich text → parsed JSON; empty or unparseable text → `fallback`. */
export function richTextToJson<T>(items: readonly RichTextLike[] | null | undefined, fallback: T): T {
  const text = richTextToText(items);
  if (!text.trim()) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/** Plain text of a title or rich_text property value ('' for anything else or undefined). */
export function titleOf(prop: PropValue | undefined | null): string {
  if (!prop) return "";
  if (prop.type === "title") return richTextToText(prop.title);
  if (prop.type === "rich_text") return richTextToText(prop.rich_text);
  return "";
}

/** One short readable mirror item (truncated to one rich text item). */
export function mirrorText(s: string | null | undefined, max = RICH_TEXT_ITEM_MAX): RichTextRequest[] {
  if (!s) return [];
  return textToRichText(truncateText(s, max));
}
