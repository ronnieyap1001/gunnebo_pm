/**
 * The hint under a percent box ("Enter a number from 0 to 100.") reaches screen readers: it is announced when it
 * appears (role="alert") and the box points at it (aria-describedby), in the step panel / Edit details editor, the List
 * view cell and the New project form (review finding UI-5). Rendered to static markup: the editors' own "invalid"
 * state needs a browser, so they share InputHint and hintedBy, tested here.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ProjectField } from "@/domain/types";
import { hintedBy, InputHint, PERCENT_HINT } from "@/components/fields/input-hint";
import { ValueEditor } from "@/components/fields/value-editor";
import { DetailInput } from "@/components/projects/detail-inputs";

const noop = () => undefined;

describe("percent hint for screen readers", () => {
  it("the hint is an alert with the id its box points at", () => {
    const html = renderToStaticMarkup(createElement(InputHint, { id: "pct-hint", children: PERCENT_HINT }));
    expect(html).toBe(`<p id="pct-hint" role="alert" class="text-xs text-destructive">${PERCENT_HINT}</p>`);
    expect(hintedBy("pct-hint", true)).toEqual({ "aria-invalid": true, "aria-describedby": "pct-hint" });
    expect(hintedBy("pct-hint", false)).toEqual({});
  });

  it("the percent editor shows no hint and no description while the value is valid", () => {
    const html = renderToStaticMarkup(
      createElement(ValueEditor, {
        def: { fieldType: "PERCENT", choices: [], config: {} },
        value: { percent: 40 },
        today: "2026-10-25",
        onCommit: noop,
        label: "Design review",
      }),
    );
    expect(html).toContain('aria-label="Design review: percent"');
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain("aria-describedby=");
    expect(html).not.toContain("aria-invalid=");
  });

  it("a New project percent field points at its error line", () => {
    const field = { id: "f1", key: "progress", label: "Progress", fieldType: "PERCENT", choices: [], config: {} } as unknown as ProjectField;
    const render = (error?: string) =>
      renderToStaticMarkup(
        createElement(DetailInput, {
          field,
          choices: [],
          value: null,
          onChange: noop,
          text: "150",
          onText: noop,
          error,
          today: "2026-10-25",
          inputId: "np-field-f1",
        }),
      );
    const invalid = render(PERCENT_HINT);
    expect(invalid).toContain('aria-invalid="true"');
    expect(invalid).toContain('aria-describedby="np-field-f1-msg"');
    expect(render()).not.toContain("aria-describedby=");
  });
});
