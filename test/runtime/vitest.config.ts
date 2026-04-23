import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { defineConfig } from "vitest/config"

const rootDir = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  root: resolve(rootDir, "../.."),
  resolve: {
    alias: {
      "@dawnai.org/core": resolve(rootDir, "../../packages/core/src/index.ts"),
      "@dawnai.org/langgraph": resolve(rootDir, "../../packages/langgraph/src/index.ts"),
      "@dawnai.org/sdk": resolve(rootDir, "../../packages/sdk/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    hookTimeout: 60_000,
    include: ["test/runtime/run-runtime-contract.test.ts"],
    testTimeout: 240_000,
  },
})
