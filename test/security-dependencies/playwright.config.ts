import { resolve } from "node:path"

import { defineConfig } from "@playwright/test"

const testDirectory = resolve(process.cwd(), "test/security-dependencies")

export default defineConfig({
  expect: {
    timeout: 15_000,
  },
  fullyParallel: false,
  reporter: "line",
  testDir: testDirectory,
  testMatch: "mermaid-browser.spec.ts",
  timeout: 45_000,
  use: {
    actionTimeout: 10_000,
    browserName: "chromium",
    headless: true,
    navigationTimeout: 10_000,
    screenshot: "off",
    trace: "off",
    video: "off",
  },
  workers: 1,
})
