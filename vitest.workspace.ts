import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    projects: [
      "./apps/web/vitest.config.ts",
      "./packages/cli/vitest.config.ts",
      "./packages/core/vitest.config.ts",
      "./packages/create-dawn-app/vitest.config.ts",
      "./packages/devkit/vitest.config.ts",
      "./packages/langchain/vitest.config.ts",
      "./packages/langgraph/vitest.config.ts",
      "./packages/sdk/vitest.config.ts",
      "./packages/vite-plugin/vitest.config.ts",
    ],
  },
})
