import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { defineConfig } from "vitest/config"

const rootDir = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      "@dawnai.org/core": resolve(rootDir, "../core/src/index.ts"),
      "@dawnai.org/langchain": resolve(rootDir, "../langchain/src/index.ts"),
      "@dawnai.org/langgraph": resolve(rootDir, "../langgraph/src/index.ts"),
      "@dawnai.org/sdk": resolve(rootDir, "../sdk/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
})
