import { defineConfig, devices } from "@playwright/test";
import os from "node:os";
import path from "node:path";

const PORT = Number(process.env.E2E_PORT ?? 3100);
export const E2E_PASSWORD = "e2e test password long enough";
/** Fake Notion data for the run: outside the project so the dev server's file watcher never sees it. */
export const E2E_FAKE_FILE = path.join(os.tmpdir(), "gunnebo-pm-e2e", "fake-notion.json");

/**
 * End-to-end tests run the real app against the fake Notion (no token), with a fresh data file per run.
 * `npm run test:e2e`
 */
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
    viewport: { width: 1440, height: 900 },
    locale: "en-GB",
    timezoneId: "Asia/Singapore",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } }],
  webServer: {
    // Own build folder, cleared every run (a stale dev cache can make pages reload in a loop).
    command: `rm -rf .next-e2e && npx next dev -H 127.0.0.1 -p ${PORT}`,
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      APP_PASSWORD: E2E_PASSWORD,
      FAKE_NOTION_FILE: E2E_FAKE_FILE,
      NEXT_DIST_DIR: ".next-e2e",
      NEXT_TELEMETRY_DISABLED: "1",
      NOTION_TOKEN: "",
    },
  },
});
