import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createPermissionsStore } from "@dawn-ai/permissions/node"
import { afterAll, describe } from "vitest"
import { runPermissionsStoreConformance } from "../src/permissions-conformance.js"

// Co-located with the kit rather than in @dawn-ai/permissions/test: that
// package is an (indirect) dependency of @dawn-ai/testing, so depending back on
// testing would make the turbo build graph cyclic.
const dirs: string[] = []

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

runPermissionsStoreConformance({
  name: "createPermissionsStore (file)",
  makeStore: (init) => {
    // A fresh appRoot per store: the file backend keeps runtime grants in
    // <appRoot>/.dawn/permissions.json, and the kit requires an empty store.
    const appRoot = mkdtempSync(join(tmpdir(), "dawn-perms-conf-"))
    dirs.push(appRoot)
    return createPermissionsStore({ appRoot, config: init.config, mode: init.mode })
  },
  describe,
})
