import { describe, expect, it } from "vitest";
import { SLUG_PATTERN, baseSlug, normalizeName, shortHash, slugify } from "@/domain/slug";

describe("slugify", () => {
  it.each<[string, string]>([
    ["Customer PO / LOI", "customer-po-loi"],
    ["Held – open items", "held-open-items"],
    ["LOI received", "loi-received"],
    ["Issued & set up", "issued-set-up"],
    ["Battery cert (UN38.3)", "battery-cert-un38-3"],
    ["  Spaces   everywhere  ", "spaces-everywhere"],
    ["Café crème", "cafe-creme"],
    ["AFL-Compact", "afl-compact"],
    ["O2F shipment requirements form", "o2f-shipment-requirements-form"],
    ["Number (%)", "number"],
    ["already-a-slug", "already-a-slug"],
    ["UPPER_case", "upper-case"],
  ])("%j -> %s", (label, slug) => {
    expect(slugify(label, [])).toBe(slug);
  });

  it("adds -2, -3 when taken (taken includes archived ids)", () => {
    expect(slugify("Sent", ["sent"])).toBe("sent-2");
    expect(slugify("Sent", ["sent", "sent-2"])).toBe("sent-3");
    expect(slugify("Sent", new Set(["sent", "sent-3"]))).toBe("sent-2");
    expect(slugify("Sent", ["sent-2"])).toBe("sent");
  });

  it("truncates to 48 characters at a word boundary before the suffix", () => {
    const label = "Pre-PO work approval (engineering at risk, samples, advance production)";
    const slug = slugify(label, []);
    expect(slug).toBe("pre-po-work-approval-engineering-at-risk-samples");
    expect(slug.length).toBeLessThanOrEqual(48);
    expect(slugify(label, [slug])).toBe(`${slug}-2`);
  });

  it("cuts back to the previous word when the limit falls inside a word", () => {
    expect(slugify("alpha bravo charlie", [], 14)).toBe("alpha-bravo"); // 'alpha-bravo-ch' -> 'alpha-bravo'
    expect(slugify("alpha bravo charlie", [], 11)).toBe("alpha-bravo"); // exact boundary
    expect(slugify("alpha bravo charlie", [], 12)).toBe("alpha-bravo"); // trailing '-' dropped
  });

  it("hard-cuts a single long word", () => {
    expect(slugify("x".repeat(80), [])).toBe("x".repeat(48));
  });

  it("falls back to c-<6 base36> for labels without ASCII letters or digits", () => {
    const a = slugify("昆山工厂", []);
    expect(a).toMatch(/^c-[0-9a-z]{6}$/);
    expect(slugify("昆山工厂", [])).toBe(a); // deterministic
    expect(slugify("—", [])).toMatch(/^c-[0-9a-z]{6}$/);
    expect(slugify("", [])).toMatch(/^c-[0-9a-z]{6}$/);
    // depends on the number of taken ids, so a second symbol-only label in the same list differs
    expect(slugify("昆山工厂", ["x"])).not.toBe(a);
    // and is still unique if the fallback collides
    expect(slugify("昆山工厂", [a]).startsWith("c-")).toBe(true);
    expect(slugify("昆山工厂", [a])).not.toBe(a);
  });

  it("always produces a key matching the template-file pattern", () => {
    const labels = [
      "Enquiry / RFQ received",
      "Ready – access pending",
      "---",
      "!!!",
      "9 lives",
      "Spares & maintenance (AMC) handover",
      "Ünïcödé",
      "a".repeat(200),
      "a b ".repeat(60),
    ];
    const taken: string[] = [];
    for (const label of labels) {
      const slug = slugify(label, taken);
      expect(slug, label).toMatch(SLUG_PATTERN);
      expect(taken).not.toContain(slug);
      taken.push(slug);
    }
  });
});

describe("helpers", () => {
  it("baseSlug can be empty", () => {
    expect(baseSlug("%%%")).toBe("");
  });

  it("shortHash is 6 base-36 characters and stable", () => {
    expect(shortHash("abc")).toMatch(/^[0-9a-z]{6}$/);
    expect(shortHash("abc")).toBe(shortHash("abc"));
    expect(shortHash("abc")).not.toBe(shortHash("abd"));
  });

  it("normalizeName ignores case, punctuation and accents", () => {
    expect(normalizeName("  Customer PO / LOI ")).toBe(normalizeName("customer po loi"));
    expect(normalizeName("Factory lead time & costing")).toBe("factory lead time and costing");
    expect(normalizeName("Café")).toBe("cafe");
  });
});
