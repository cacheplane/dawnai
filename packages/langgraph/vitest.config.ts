import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { defineConfig } from "vitest/config"

const rootDir = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      "@dawnai.org/langgraph": resolve(rootDir, "src/index.ts"),
      "@dawnai.org/langgraph/define-entry": resolve(rootDir, "src/define-entry.ts"),
      "@dawnai.org/langgraph/route-module": resolve(rootDir, "src/route-module.ts"),
      "@dawnai.org/sdk": resolve(rootDir, "../sdk/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
})
