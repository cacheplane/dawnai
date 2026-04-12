import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    projects: [
      "./packages/cli/vitest.config.ts",
      "./packages/core/vitest.config.ts",
      "./packages/create-dawn-app/vitest.config.ts",
      "./packages/devkit/vitest.config.ts",
      "./packages/langgraph/vitest.config.ts",
    ],
  },
})
