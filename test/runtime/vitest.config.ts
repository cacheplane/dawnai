import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { defineConfig } from "vitest/config"

const rootDir = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  root: resolve(rootDir, "../.."),
  resolve: {
    alias: {
      "@dawn-ai/core": resolve(rootDir, "../../packages/core/src/index.ts"),
      "@dawn-ai/langgraph": resolve(rootDir, "../../packages/langgraph/src/index.ts"),
      "@dawn-ai/sdk": resolve(rootDir, "../../packages/sdk/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    hookTimeout: 60_000,
    include: ["test/runtime/run-runtime-contract.test.ts"],
    testTimeout: 240_000,
  },
})
