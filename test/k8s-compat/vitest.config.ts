import { resolve } from "node:path"

import { defineConfig } from "vitest/config"

const repoRoot = resolve(__dirname, "../..")

export default defineConfig({
  root: repoRoot,
  test: {
    name: "k8s-compat",
    environment: "node",
    include: [resolve(repoRoot, "test/k8s-compat/**/*.test.ts")],
  },
})
