import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { defineConfig } from "vitest/config"

const rootDir = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  root: resolve(rootDir, "../.."),
  resolve: {
    alias: {
      "@dawn-ai/cli/runtime": resolve(rootDir, "../../packages/cli/src/runtime-exports.ts"),
      "@dawn-ai/core": resolve(rootDir, "../../packages/core/src/index.ts"),
      "@dawn-ai/langchain": resolve(rootDir, "../../packages/langchain/src/index.ts"),
      "@dawn-ai/langgraph": resolve(rootDir, "../../packages/langgraph/src/index.ts"),
      "@dawn-ai/sdk/testing": resolve(rootDir, "../../packages/sdk/src/testing/index.ts"),
      "@dawn-ai/sdk": resolve(rootDir, "../../packages/sdk/src/index.ts"),
      "@dawn-ai/testing": resolve(rootDir, "../../packages/testing/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    // These suites each spin up real dev servers (pnpm install + tsc + bound
    // ports + SQLite files). Running the files in parallel on a constrained CI
    // runner causes server-boot timeouts and port/disk contention. Serialize
    // them — integration parity is the goal here, not raw speed.
    fileParallelism: false,
    globalSetup: ["test/harness/registry-global-setup.ts"],
    hookTimeout: 180_000,
    include: [
      "test/runtime/run-runtime-contract.test.ts",
      "test/runtime/run-agent-protocol.test.ts",
      "test/runtime/dawn-testing/agent-behavior.test.ts",
    ],
    testTimeout: 240_000,
  },
})
