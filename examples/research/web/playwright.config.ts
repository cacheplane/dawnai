import { defineConfig } from "@playwright/test"

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  reporter: "line",
  use: {
    baseURL: "http://127.0.0.1:3010",
    browserName: "chromium",
    headless: true,
    trace: "retain-on-failure",
  },
  webServer: {
    command: "pnpm exec next dev --hostname 127.0.0.1 -p 3010",
    url: "http://127.0.0.1:3010",
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      COPILOTKIT_TELEMETRY_DISABLED: "true",
      DO_NOT_TRACK: "1",
    },
  },
})
