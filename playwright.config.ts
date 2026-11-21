import { defineConfig, devices } from "@playwright/test";

// The browser tests run against the built app in test mode. `./check` builds first.
const PORT = 3210;

export default defineConfig({
  testDir: "./e2e",
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npm run start -- -p ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      ADDS_UP_TEST: "1",
      ADDS_UP_READ_TIMEOUT_MS: "1200",
      NEXT_TELEMETRY_DISABLED: "1",
    },
  },
});
