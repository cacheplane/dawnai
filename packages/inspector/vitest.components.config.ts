import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import react from "@vitejs/plugin-react"
import { defineConfig } from "vitest/config"

const rootDir = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Subpath alias only — the bare "@dawn-ai/memory" specifier must stay resolving
      // to the built package (its barrel pulls node:sqlite and has no business in a
      // jsdom project). Mirrors packages/cli/vitest.config.ts:18-20.
      "@dawn-ai/memory/browse": resolve(rootDir, "../memory/src/browse.ts"),
    },
  },
  test: {
    name: "inspector-components",
    environment: "jsdom",
    // `.ts` too: not every component-side unit is JSX — the filter mapping is
    // pure logic that would otherwise have to pretend to be a component file.
    include: ["test/components/**/*.test.{ts,tsx}"],
  },
})
