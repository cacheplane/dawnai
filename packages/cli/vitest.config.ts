import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { defineConfig } from "vitest/config"

const rootDir = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      "@dawn-ai/core/node": resolve(rootDir, "../core/src/node-marker-fs.ts"),
      "@dawn-ai/core": resolve(rootDir, "../core/src/index.ts"),
      "@dawn-ai/langchain": resolve(rootDir, "../langchain/src/index.ts"),
      "@dawn-ai/langgraph": resolve(rootDir, "../langgraph/src/index.ts"),
      // Subpath aliases MUST precede the bare package alias — vitest matches
      // string aliases by prefix in declaration order, so a leading
      // "@dawn-ai/memory" entry would swallow "@dawn-ai/memory/namespace".
      "@dawn-ai/memory/namespace": resolve(rootDir, "../memory/src/namespace.ts"),
      "@dawn-ai/memory/reconcile": resolve(rootDir, "../memory/src/reconcile.ts"),
      "@dawn-ai/memory": resolve(rootDir, "../memory/src/index.ts"),
      "@dawn-ai/sandbox/testing": resolve(rootDir, "../sandbox/src/testing/index.ts"),
      "@dawn-ai/sdk/testing": resolve(rootDir, "../sdk/src/testing/index.ts"),
      "@dawn-ai/sdk": resolve(rootDir, "../sdk/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
})
