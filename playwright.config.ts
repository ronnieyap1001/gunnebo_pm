import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 3100);
export const E2E_PASSWORD = "e2e test password long enough";

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
    command: `npx next dev -H 127.0.0.1 -p ${PORT}`,
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      APP_PASSWORD: E2E_PASSWORD,
      FAKE_NOTION_FILE: "test-results/e2e-fake-notion.json",
      NEXT_TELEMETRY_DISABLED: "1",
      NOTION_TOKEN: "",
    },
  },
});
