import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

import { loadRouteMemory } from "../src/lib/runtime/load-memory.js"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..")

async function makeRouteDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dawn-memory-"))

  // Make `@dawn-ai/sdk` resolvable from the temp dir by symlinking the
  // workspace package into the temp dir's node_modules (same pattern as
  // load-evals.test.ts uses for @dawn-ai/evals).
  await mkdir(join(root, "node_modules", "@dawn-ai"), { recursive: true })
  await symlink(
    join(repoRoot, "packages", "sdk"),
    join(root, "node_modules", "@dawn-ai", "sdk"),
    "dir",
  )

  // Symlink zod so the memory.ts file can import from @dawn-ai/sdk's re-exports.
  await symlink(
    join(repoRoot, "node_modules", ".pnpm", "zod@4.4.3", "node_modules", "zod"),
    join(root, "node_modules", "zod"),
    "dir",
  )

  // Write a memory.ts that uses defineMemory from the sdk.
  await writeFile(
    join(root, "memory.ts"),
    [
      'import { z } from "zod"',
      'import { defineMemory } from "@dawn-ai/sdk"',
      'export default defineMemory({ kind: "semantic", scope: ["route"], schema: z.object({ subject: z.string() }) })',
    ].join("\n"),
  )

  return root
}

describe("loadRouteMemory", () => {
  it("loads a memory.ts and returns the defineMemory descriptor", async () => {
    const routeDir = await makeRouteDir()
    const def = await loadRouteMemory(join(routeDir, "memory.ts"))
    expect(def.kind).toBe("semantic")
    expect(def.scope).toEqual(["route"])
  })
})
