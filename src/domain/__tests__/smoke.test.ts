import { describe, expect, it } from "vitest";
import { FIELD_TYPES, STATES } from "@/domain/types";

describe("types", () => {
  it("lists 11 field types and 6 states", () => {
    expect(FIELD_TYPES).toHaveLength(11);
    expect(STATES).toHaveLength(6);
  });
});
