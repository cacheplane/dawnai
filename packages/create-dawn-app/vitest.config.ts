import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { defineConfig } from "vitest/config"

const rootDir = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      "@dawn-ai/devkit": resolve(rootDir, "../devkit/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    // The packaged-scaffolder tests install create-dawn-ai-app at the candidate
    // version, whose @dawn-ai/* deps aren't on npmjs until this release
    // publishes. Start an ephemeral Verdaccio registry with the whole workspace
    // published (same globalSetup as the generated lane) so installPackagedScaffolder
    // can resolve them locally. Absolute path: a project's globalSetup resolves
    // relative to the project root, not the repo root.
    globalSetup: [resolve(rootDir, "../../test/harness/registry-global-setup.ts")],
    hookTimeout: 180_000,
    include: ["test/**/*.test.ts"],
  },
})
