import { defineConfig } from "vitest/config"

// The two projects live in their own leaf config FILES rather than inline
// objects: the root `vitest.workspace.ts` enrolls them individually, and a
// project entry that itself declares `projects` is flattened by vitest —
// silently dropping the nested plugins and environment.
export default defineConfig({
  test: {
    projects: ["./vitest.e2e.config.ts", "./vitest.components.config.ts"],
  },
})
