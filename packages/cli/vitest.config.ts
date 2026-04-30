import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { defineConfig } from "vitest/config"

const rootDir = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      "@dawn-ai/core": resolve(rootDir, "../core/src/index.ts"),
      "@dawn-ai/langchain": resolve(rootDir, "../langchain/src/index.ts"),
      "@dawn-ai/langgraph": resolve(rootDir, "../langgraph/src/index.ts"),
      "@dawn-ai/sdk": resolve(rootDir, "../sdk/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
})
