import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    passWithNoTests: true,
    // The capability e2e suites boot in-process agents + a real dawn dev
    // subprocess and mutate process-global OPENAI_BASE_URL — run files
    // sequentially to avoid cross-file env/port races.
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
})
