/**
 * CR-1 (Setup screen): the "Everything is set up" card keeps a "Check again" button, so a change made in Notion since
 * (a database moved to the trash) can be found from there and leads to the Repair step.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { SetupStatusDTO } from "@/server/queries";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {}, push() {} }) }));
vi.mock("@/app/(app)/setup/actions", () => ({
  checkSetupAction: vi.fn(),
  continueCreateProjectAction: vi.fn(),
  continueImportAction: vi.fn(),
  continueSyncAction: vi.fn(),
  runSchemaStepAction: vi.fn(),
  startSeedAction: vi.fn(),
}));

const { SetupScreen } = await import("@/components/admin/setup-screen");

function render(status: Partial<SetupStatusDTO>): string {
  const full: SetupStatusDTO = {
    mode: "notion",
    problems: [],
    parentPage: { id: "p", title: "Gunnebo PM" },
    databases: [{ name: "Projects", ok: true }],
    schemaReady: true,
    seeded: true,
    openJobs: [],
    ...status,
  };
  return renderToStaticMarkup(
    createElement(SetupScreen, { status: full, parentTitle: "Gunnebo PM", isPreview: false, resumeJob: null, jobProjects: {}, timeZone: "Asia/Singapore" }),
  );
}

describe("Setup when everything is set up (CR-1)", () => {
  it("shows Check again next to Open Portfolio", () => {
    const html = render({});
    expect(html).toContain("Everything is set up");
    expect(html).toContain("Open Portfolio");
    expect(html).toMatch(/<button[^>]*>(?:(?!<\/button>)[\s\S])*Check again<\/button>/);
  });

  it("a database found missing afterwards shows the Repair step instead", () => {
    const html = render({ schemaReady: false, databases: [{ name: "Projects", ok: false }, { name: "Steps", ok: true }] });
    expect(html).not.toContain("Everything is set up");
    expect(html).toContain("Repair databases");
  });
});
