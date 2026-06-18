import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    exclude: ["test/generated/fixtures/**"],
    fileParallelism: false,
    hookTimeout: 180_000,
    // test/harness holds the shared scaffolding helpers the framework lane
    // exercises; include their unit tests here so they actually run in CI
    // (they were previously orphaned — no config picked them up).
    include: ["test/generated/**/*.test.ts", "test/harness/**/*.test.ts"],
    testTimeout: 180_000,
  },
})
