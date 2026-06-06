import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    passWithNoTests: true,
    // Several suites boot real servers / share the probe app's SQLite file —
    // run files sequentially to avoid "database is locked" + port races.
    fileParallelism: false,
  },
})
