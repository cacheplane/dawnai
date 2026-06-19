import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    globalSetup: ["test/harness/registry-global-setup.ts"],
    include: ["test/smoke/**/*.test.ts"],
  },
})
