import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createThreadsStore } from "@dawn-ai/sqlite-storage"
import { afterAll, describe } from "vitest"
import { runThreadsStoreConformance } from "../src/threads-conformance.js"

// The kit lives here rather than in @dawn-ai/sqlite-storage/test because
// sqlite-storage is an (indirect) dependency of @dawn-ai/testing — depending
// back on testing makes the turbo build graph cyclic.
const dirs: string[] = []

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

runThreadsStoreConformance({
  name: "createThreadsStore (sqlite)",
  makeStore: () => {
    const dir = mkdtempSync(join(tmpdir(), "dawn-threads-conf-"))
    dirs.push(dir)
    return createThreadsStore({ path: join(dir, "threads.sqlite") })
  },
  describe,
})
