import { describe, expect, it } from "vitest";
import { ValueTooLargeError } from "@/server/notion/errors";
import {
  RICH_TEXT_ITEM_MAX,
  jsonToRichText,
  mirrorText,
  richTextToJson,
  richTextToText,
  splitText,
  textToRichText,
  titleOf,
  truncateText,
} from "@/server/notion/richtext";

const contents = (items: ReturnType<typeof textToRichText>) =>
  items.map((i) => ("text" in i ? i.text.content : ""));

/** Response-shaped items (what Notion sends back). */
const asResponse = (parts: string[]) => parts.map((p) => ({ plain_text: p, text: { content: p } }));

describe("textToRichText", () => {
  it("returns [] for the empty string (Notion rejects empty text items)", () => {
    expect(textToRichText("")).toEqual([]);
    expect(textToRichText(null)).toEqual([]);
    expect(textToRichText(undefined)).toEqual([]);
  });

  it("keeps exactly 2,000 characters in one item", () => {
    const s = "x".repeat(2000);
    const items = textToRichText(s);
    expect(items).toHaveLength(1);
    expect(contents(items)[0]).toHaveLength(2000);
  });

  it("splits 2,001 characters into 2,000 + 1", () => {
    const items = textToRichText("y".repeat(2001));
    expect(contents(items).map((c) => c.length)).toEqual([2000, 1]);
  });

  it("never splits a surrogate pair at the boundary", () => {
    const s = `${"a".repeat(1999)}😀b`; // the emoji occupies units 1999 and 2000
    const parts = splitText(s);
    expect(parts[0]).toHaveLength(1999);
    expect(parts[1]).toBe("😀b");
    expect(parts.join("")).toBe(s);
    for (const p of parts) {
      const last = p.charCodeAt(p.length - 1);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    }
  });

  it("handles a string made only of emoji", () => {
    const s = "😀".repeat(1500); // 3,000 units
    const parts = splitText(s);
    expect(parts.join("")).toBe(s);
    expect(parts.every((p) => p.length <= RICH_TEXT_ITEM_MAX && p.length % 2 === 0)).toBe(true);
  });

  it("accepts 100 chunks and throws a clear error above that", () => {
    expect(textToRichText("z".repeat(200_000))).toHaveLength(100);
    expect(() => textToRichText("z".repeat(200_001), "The project cells")).toThrow(ValueTooLargeError);
    expect(() => textToRichText("z".repeat(200_001), "The project cells")).toThrow(/The project cells is too long/);
  });
});

describe("JSON helpers", () => {
  it("round-trips a ~200 KB JSON value", () => {
    const value: Record<string, { k: string; t: string; n: number }> = {};
    let i = 0;
    while (JSON.stringify(value).length < 195_000) {
      value[`step-${i}`] = { k: `milestone-${i}`, t: "DROPDOWN", n: i };
      i++;
    }
    const items = jsonToRichText(value);
    expect(items.length).toBeLessThanOrEqual(100);
    expect(contents(items).every((c) => c.length <= 2000)).toBe(true);
    expect(richTextToJson(asResponse(contents(items)), null)).toEqual(value);
  });

  it("null and undefined become [] and read back as the fallback", () => {
    expect(jsonToRichText(null)).toEqual([]);
    expect(jsonToRichText(undefined)).toEqual([]);
    expect(richTextToJson([], { a: 1 })).toEqual({ a: 1 });
  });

  it("falls back on unparseable text", () => {
    expect(richTextToJson(asResponse(["{not json"]), "fallback")).toBe("fallback");
  });

  it("joins items whatever their boundaries (Notion may re-split them)", () => {
    const json = JSON.stringify({ hello: "world", list: [1, 2, 3] });
    const reSplit = [json.slice(0, 3), json.slice(3, 10), json.slice(10)];
    expect(richTextToJson(asResponse(reSplit), null)).toEqual({ hello: "world", list: [1, 2, 3] });
    expect(richTextToText(asResponse(["ab", "", "cd"]))).toBe("abcd");
  });
});

describe("other helpers", () => {
  it("titleOf reads title and rich_text values", () => {
    expect(titleOf({ id: "title", type: "title", title: [] })).toBe("");
    expect(titleOf(undefined)).toBe("");
  });

  it("truncateText and mirrorText keep one item", () => {
    expect(truncateText("abc", 5)).toBe("abc");
    expect(truncateText("abcdef", 4)).toBe("abc…");
    expect(truncateText("ab😀c", 4)).toBe("ab…");
    expect(mirrorText("q".repeat(5000))).toHaveLength(1);
    expect(mirrorText("")).toEqual([]);
  });
});
