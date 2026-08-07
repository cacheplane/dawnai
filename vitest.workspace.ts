import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    projects: [
      "./apps/web/vitest.config.ts",
      "./packages/ag-ui/vitest.config.ts",
      "./packages/cli/vitest.config.ts",
      "./packages/core/vitest.config.ts",
      "./packages/create-dawn-app/vitest.config.ts",
      "./packages/devkit/vitest.config.ts",
      "./packages/evals/vitest.config.ts",
      "./packages/inspector/vitest.components.config.ts",
      "./packages/inspector/vitest.e2e.config.ts",
      "./packages/langchain/vitest.config.ts",
      "./packages/langgraph/vitest.config.ts",
      "./packages/memory-pgvector/vitest.config.ts",
      "./packages/memory/vitest.config.ts",
      "./packages/permissions/vitest.config.ts",
      "./packages/postgres-storage/vitest.config.ts",
      "./packages/sandbox/vitest.config.ts",
      "./packages/sdk/vitest.config.ts",
      "./packages/sqlite-storage/vitest.config.ts",
      "./packages/testing/vitest.config.ts",
      "./packages/vite-plugin/vitest.config.ts",
      "./packages/workspace/vitest.config.ts",
      "./examples/chat/server/vitest.config.ts",
      "./examples/research/server/vitest.config.ts",
    ],
  },
})
