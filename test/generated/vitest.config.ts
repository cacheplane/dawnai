import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    exclude: ["test/generated/fixtures/**"],
    fileParallelism: false,
    hookTimeout: 180_000,
    include: ["test/generated/**/*.test.ts"],
    testTimeout: 180_000,
  },
})
