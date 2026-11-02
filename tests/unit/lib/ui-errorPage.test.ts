/**
 * The page shown when a screen fails to load (most often Notion busy) says to wait and try again, and offers the Setup
 * page as the last resort with a direct link. It must not send people through Settings: Settings needs Notion too and
 * fails the same way, while Setup loads even when Notion does not answer (review finding UI-4).
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const down = () => {
  throw new Error("Notion is not answering");
};
vi.mock("@/server/auth/session", () => ({ requireUser: async () => undefined }));
vi.mock("@/server/queries", () => ({ getSetupStatus: async () => down(), getDay: async () => down() }));
vi.mock("@/server/repo", () => ({ getStorageAdmin: () => ({ status: async () => down() }), getRepo: () => down() }));
vi.mock("@/server/notion/registry", () => ({ parentTitleFor: () => "Gunnebo PM" }));
vi.mock("@/components/admin/setup-screen", () => ({ SetupScreen: () => null }));

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("the page shown when a screen fails to load", () => {
  it("says to wait and try again, and links straight to Setup as the last resort", async () => {
    const { default: AppError } = await import("@/app/(app)/error");
    const html = renderToStaticMarkup(createElement(AppError, { error: new Error("boom"), retry: () => undefined }));
    expect(text(html)).toMatch(/Wait a few seconds, then press Try again/);
    expect(html).toMatch(/<button[^>]*>Try again<\/button>/);
    // The only way out it offers is the Setup page itself, never "Settings → Open Setup" (Settings needs Notion too).
    expect([...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1])).toEqual(["/setup"]);
    expect(text(html)).not.toMatch(/Settings/);
    expect(text(html)).toMatch(/few minutes/);
  });

  it("the Setup page it links to loads while Notion does not answer, and says Notion is busy", async () => {
    const { default: SetupPage } = await import("@/app/(app)/setup/page");
    const page = await SetupPage({ searchParams: Promise.resolve({}) });
    const screen = (page.props as { children: { props: { status: { errorKind?: string } } }[] }).children[1];
    expect(screen.props.status.errorKind).toBe("busy");
  });
});
