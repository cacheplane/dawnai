import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { defineConfig } from "vitest/config"

const rootDir = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      "@dawn-ai/langgraph": resolve(rootDir, "src/index.ts"),
      "@dawn-ai/langgraph/define-entry": resolve(rootDir, "src/define-entry.ts"),
      "@dawn-ai/langgraph/route-module": resolve(rootDir, "src/route-module.ts"),
      "@dawn-ai/sdk": resolve(rootDir, "../sdk/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
})
