import { defineConfig } from "@playwright/test"

const port = process.env.INSPECTOR_E2E_PORT ?? "3919"

export default defineConfig({
  testDir: "./e2e",
  // One worker, always: every spec drives the SAME seeded store and several of them
  // mutate it. Parallel workers would make scenario 9 (concurrent write) delete a row
  // scenario 5 is counting.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: "retain-on-failure",
  },
  webServer: {
    command: `node e2e/serve.ts`,
    url: `http://127.0.0.1:${port}/healthz`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
  },
})
