/**
 * Every percent box reads what was typed the same way (parsePercentInput): a comma is a decimal comma, so "7,5" is 8%,
 * never 75%. Number boxes keep reading a comma as a thousands separator ("1,200" is 1200). Covers the List view's
 * inline cell, the New project form's Number / Percent inputs and its validation (review finding UI-1).
 */
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";
import type { ProjectField } from "@/domain/types";
import { parsePercentInput } from "@/domain/values";
import { parseInline } from "@/components/project/list-view";
import { DetailInput, detailTextError, numberTextValue, type DetailInputProps } from "@/components/projects/detail-inputs";

const PERCENT = { fieldType: "PERCENT" } as const;
const NUMBER = { fieldType: "NUMBER" } as const;

describe("List view inline cell", () => {
  it("reads a decimal comma in a percent cell like the side panel does", () => {
    for (const t of ["7,5", "12,5", "0,5", "7.5", "45", "80 %", "100", "99,6"]) {
      expect(parseInline(PERCENT, t), t).toEqual({ percent: parsePercentInput(t) });
    }
    expect(parseInline(PERCENT, "7,5")).toEqual({ percent: 8 });
    expect(parseInline(PERCENT, "12,5")).toEqual({ percent: 13 });
  });

  it("refuses a percent that is not a number from 0 to 100, and clears on empty", () => {
    for (const t of ["150", "-5", "1.2.3", "12..5", "abc", "100,5"]) expect(parseInline(PERCENT, t), t).toBeUndefined();
    expect(parseInline(PERCENT, "  ")).toBeNull();
  });

  it("keeps commas as thousands separators in a number cell", () => {
    expect(parseInline(NUMBER, "1,200")).toEqual({ number: 1200 });
    expect(parseInline(NUMBER, "7,5")).toEqual({ number: 75 });
    expect(parseInline(NUMBER, "3.5")).toEqual({ number: 3.5 });
    expect(parseInline(NUMBER, "abc")).toBeUndefined();
  });
});

describe("New project form (detail inputs)", () => {
  it("a percent field reads a decimal comma and rounds to a whole percent", () => {
    expect(numberTextValue("PERCENT", "7,5")).toEqual({ percent: 8 });
    expect(numberTextValue("PERCENT", "12,5")).toEqual({ percent: 13 });
    expect(numberTextValue("PERCENT", "45 %")).toEqual({ percent: 45 });
    expect(numberTextValue("PERCENT", "")).toBeNull();
    // Not valid: the form keeps the last valid value and shows the error instead of saving a clamped one.
    expect(numberTextValue("PERCENT", "150")).toBeUndefined();
    expect(numberTextValue("PERCENT", "1.2.3")).toBeUndefined();
  });

  it("a number field keeps commas as thousands separators", () => {
    expect(numberTextValue("NUMBER", "1,200")).toEqual({ number: 1200 });
    expect(numberTextValue("NUMBER", "7,5")).toEqual({ number: 75 });
    expect(numberTextValue("NUMBER", " ")).toBeNull();
    expect(numberTextValue("NUMBER", "abc")).toBeUndefined();
  });

  it("the Number / Percent input saves what numberTextValue reads (and nothing while the text is not valid)", () => {
    // NumberInput has no hooks: render its element tree by hand and type into the box through its onChange.
    const type = (fieldType: "NUMBER" | "PERCENT", typed: string) => {
      const saved: unknown[] = [];
      const props = {
        field: { id: "f1", key: "f1", label: "Progress", fieldType, choices: [], config: {} } as unknown as ProjectField,
        choices: [],
        value: null,
        onChange: (v: unknown) => saved.push(v),
        text: undefined,
        onText: () => undefined,
        today: "2026-10-25",
        inputId: "np-field-f1",
      };
      const outer = DetailInput(props) as ReactElement<DetailInputProps, (p: DetailInputProps) => ReactElement>;
      const box = (outer.type(outer.props) as ReactElement<{ children: ReactElement[] }>).props.children[0];
      (box.props as { onChange: (e: { target: { value: string } }) => void }).onChange({ target: { value: typed } });
      return saved;
    };
    expect(type("PERCENT", "7,5")).toEqual([{ percent: 8 }]);
    expect(type("PERCENT", "")).toEqual([null]);
    expect(type("PERCENT", "150")).toEqual([]); // the form shows the error and keeps the last valid value
    expect(type("NUMBER", "1,200")).toEqual([{ number: 1200 }]);
    expect(type("NUMBER", "abc")).toEqual([]);
  });

  it("validation accepts what the input saves and names the range for a percent", () => {
    expect(detailTextError(PERCENT, "7,5")).toBeUndefined();
    expect(detailTextError(PERCENT, "100")).toBeUndefined();
    expect(detailTextError(PERCENT, "150")).toBe("Enter a number from 0 to 100.");
    expect(detailTextError(PERCENT, "abc")).toBe("Enter a number from 0 to 100.");
    expect(detailTextError(NUMBER, "1,200")).toBeUndefined();
    expect(detailTextError(NUMBER, "abc")).toBe("Enter a number, for example 24.");
    expect(detailTextError({ fieldType: "LINK" }, "example.com")).toBe("Enter a web address starting with https://");
    expect(detailTextError({ fieldType: "LINK" }, "https://example.com")).toBeUndefined();
    expect(detailTextError(PERCENT, "  ")).toBeUndefined();
  });
});
