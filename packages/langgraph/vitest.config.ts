import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { defineConfig } from "vitest/config"

const rootDir = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      "@dawn/langgraph": resolve(rootDir, "src/index.ts"),
      "@dawn/langgraph/define-entry": resolve(rootDir, "src/define-entry.ts"),
      "@dawn/langgraph/route-module": resolve(rootDir, "src/route-module.ts"),
      "@dawn/sdk": resolve(rootDir, "../sdk/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
})
