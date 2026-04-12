import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    projects: [
      "./packages/core/vitest.config.ts",
      "./packages/cli/vitest.config.ts",
      "./packages/create-dawn-app/vitest.config.ts",
      "./test/generated/vitest.config.ts",
    ],
  },
})
