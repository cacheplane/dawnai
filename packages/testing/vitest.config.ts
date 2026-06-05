import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    passWithNoTests: true,
    // Harness tests open the same probe-app SQLite DB; run sequentially to avoid
    // "database is locked" (ERR_SQLITE_ERROR) errors under concurrent workers.
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
})
