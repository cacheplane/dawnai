import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    name: "inspector-e2e",
    environment: "node",
    include: ["test/**/*.e2e.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // e2e files boot standalone servers against the SAME fixture app (and
    // its .dawn sqlite dir) — parallel files would clobber each other's
    // seeds.
    fileParallelism: false,
  },
})
