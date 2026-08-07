import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sqliteCheckpointer } from "@dawn-ai/sqlite-storage"
import { afterAll, describe } from "vitest"
import { runCheckpointerConformance } from "../src/checkpointer-conformance.js"

// Co-located with the kit rather than in @dawn-ai/sqlite-storage/test: that
// package is an (indirect) dependency of @dawn-ai/testing, so depending back on
// testing would make the turbo build graph cyclic.
const dirs: string[] = []

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

runCheckpointerConformance({
  name: "sqliteCheckpointer",
  makeSaver: () => {
    const dir = mkdtempSync(join(tmpdir(), "dawn-ckpt-conf-"))
    dirs.push(dir)
    return sqliteCheckpointer({ path: join(dir, "ckpt.sqlite") })
  },
  describe,
  // Dawn's SQLite saver deliberately yields lightweight tuples from list() and
  // ignores options.filter; both are declared capabilities, not contract.
  supports: { listPendingWrites: false, listFilter: false },
})
