import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { defineConfig } from "vitest/config"

const rootDir = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      "@dawn-ai/langchain": resolve(rootDir, "src/index.ts"),
      // Subpath aliases MUST precede the bare package alias — vitest matches
      // string aliases by prefix in declaration order.
      "@dawn-ai/sdk/pure": resolve(rootDir, "../sdk/src/pure/index.ts"),
      "@dawn-ai/sdk/testing": resolve(rootDir, "../sdk/src/testing/index.ts"),
      "@dawn-ai/sdk": resolve(rootDir, "../sdk/src/index.ts"),
      "@dawn-ai/workspace": resolve(rootDir, "../workspace/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
})
