import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import { E2E_FAKE_FILE, E2E_PASSWORD } from "../../playwright.config";

/**
 * The main journey, end to end, against a fresh fake Notion:
 * sign in → Setup (databases + 64 milestones) → new project → set values (state colours, history) → List view →
 * Portfolio → change the template → Sync the project (value kept) → Excel export.
 */
test.describe.configure({ mode: "serial" });

const FAKE = E2E_FAKE_FILE;

test.beforeAll(() => {
  // Fresh data for every run (the dev server reloads the file when it changes).
  for (const f of [FAKE, `${FAKE}.files`]) fs.rmSync(f, { recursive: true, force: true });
});

let projectUrl = "";

async function signIn(page: Page) {
  await page.goto("/login", { waitUntil: "networkidle" });
  await page.getByLabel("Password").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
}

test("sign-in refuses a wrong password and accepts the right one", async ({ page }) => {
  await page.goto("/portfolio", { waitUntil: "networkidle" });
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel("Password").fill("not the right password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("That password is not right.")).toBeVisible();
  await page.getByLabel("Password").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  // Not set up yet: every screen sends you to Setup.
  await expect(page).toHaveURL(/\/setup/);
});

test("Setup creates the databases and loads the 64 milestones", async ({ page }) => {
  await signIn(page);
  await page.goto("/setup");
  await page.getByRole("button", { name: /Create databases/ }).click();
  await expect(page.getByRole("button", { name: /Load the 64 milestones/ })).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: /Load the 64 milestones/ }).click();
  await expect(page.getByRole("link", { name: /Open Portfolio/ }).or(page.getByRole("button", { name: /Open Portfolio/ }))).toBeVisible({
    timeout: 90_000,
  });
  await page.goto("/library");
  await expect(page.getByText("Customer PO / LOI").first()).toBeVisible();
  await expect(page.getByText("Lessons learned").first()).toBeVisible();
});

test("a new project copies the template", async ({ page }) => {
  await signIn(page);
  await page.goto("/projects");
  await page.getByRole("button", { name: /New project/ }).first().click();
  await page.locator("#np-code").fill("c0999");
  await page.locator("#np-name").fill("E2E Heathrow test");
  await page.getByRole("button", { name: "Create project" }).click();
  await page.waitForURL(/\/projects\/[^/?]+/, { timeout: 120_000 });
  projectUrl = new URL(page.url()).pathname;
  await expect(page.getByText("C0999").first()).toBeVisible();
  await expect(page.getByText(/0 \/ 64 done/)).toBeVisible();
});

test("setting values colours the milestone and writes history", async ({ page }) => {
  await signIn(page);
  await page.goto(`${projectUrl}?view=list`);
  const row = page.locator("tr", { has: page.getByRole("button", { name: "Customer PO / LOI", exact: true }) });
  await expect(row).toHaveAttribute("data-state", "NOT_STARTED");

  await page.getByRole("button", { name: "Customer PO / LOI", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "Details" });
  await panel.getByRole("radio", { name: /Awaiting/ }).click();
  await expect(row).toHaveAttribute("data-state", "WAITING");
  await panel.getByRole("radio", { name: /Full PO/ }).click();
  await expect(row).toHaveAttribute("data-state", "DONE");
  await expect(row).toContainText("Full PO");
  await expect(page.getByText(/1 \/ 64 done/)).toBeVisible();

  // History: old → new.
  await expect(panel.getByText(/Awaiting.*Full PO|Full PO/).first()).toBeVisible();

  // A future date shows as in progress (planned).
  await page.getByRole("button", { name: "FAT date", exact: true }).click();
  const dateInput = panel.getByPlaceholder(/12 Nov 2026/);
  await dateInput.fill("+3w");
  await dateInput.press("Enter");
  const fatRow = page.locator("tr", { has: page.getByRole("button", { name: "FAT date", exact: true }) });
  await expect(fatRow).toHaveAttribute("data-state", "IN_PROGRESS");

  // Not applicable fades a step and removes it from the progress count.
  await page.getByRole("button", { name: "Storage at factory", exact: true }).click();
  await panel.getByRole("switch", { name: /Not applicable/ }).click();
  const storageRow = page.locator("tr", { has: page.getByRole("button", { name: "Storage at factory", exact: true }) });
  await expect(storageRow).toHaveAttribute("data-state", "NOT_APPLICABLE");
  await expect(page.getByText(/1 \/ 63 done/)).toBeVisible();
});

test("the Portfolio shows the project with its states", async ({ page }) => {
  await signIn(page);
  await page.goto("/portfolio");
  await expect(page.getByText("C0999").first()).toBeVisible();
  await expect(page.getByText("E2E Heathrow test").first()).toBeVisible();
});

test("a template change reaches the project only through Sync, and keeps the value", async ({ page }) => {
  await signIn(page);
  // Rename the chosen choice in the Library.
  await page.goto("/library");
  await page.getByRole("button", { name: "Actions for Customer PO / LOI" }).click();
  await page.getByRole("menuitem", { name: /Edit/ }).click();
  const labels = page.getByRole("textbox", { name: "Choice label" });
  await expect(labels.first()).toBeVisible();
  let choice = labels.first();
  for (let i = 0; i < (await labels.count()); i++) {
    if ((await labels.nth(i).inputValue()) === "Full PO") choice = labels.nth(i);
  }
  await expect(choice).toHaveValue("Full PO");
  await choice.fill("Full PO received");
  await choice.press("Enter");
  await page.waitForTimeout(1500);

  // The project still shows the old label until it is synced.
  await page.goto(`${projectUrl}?view=list`);
  const row = page.locator("tr", { has: page.getByRole("button", { name: "Customer PO / LOI", exact: true }) });
  await expect(row).toContainText("Full PO");
  await expect(page.getByText("Template changed since the last sync")).toBeVisible({ timeout: 70_000 });
  await page.getByRole("button", { name: "Review" }).click();
  await page.getByRole("button", { name: /^Apply / }).click();
  // The dialog closes itself when the sync has been applied.
  await expect(row).toContainText("Full PO received", { timeout: 60_000 });
  await expect(page.getByText("Template changed since the last sync")).toBeHidden();
  await expect(row).toHaveAttribute("data-state", "DONE");
});

test("Excel export downloads a workbook", async ({ page }) => {
  await signIn(page);
  const id = projectUrl.split("/").pop()!;
  const res = await page.request.get(`/api/export/project/${id}`);
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toContain("spreadsheetml");
  expect(res.headers()["content-disposition"]).toContain("C0999");
  const body = await res.body();
  expect(body.subarray(0, 2).toString("latin1")).toBe("PK");
});

test("signed-out requests to data routes are refused", async ({ request }) => {
  const res = await request.get("/api/export/project/anything", { maxRedirects: 0 });
  expect(res.status()).toBe(401);
  const files = await request.post("/api/files", { maxRedirects: 0, multipart: { projectId: "x" } });
  expect(files.status()).toBe(401);
});
