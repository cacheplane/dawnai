import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { __clearDawnConfigCacheForTests } from "@dawn-ai/core"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { resolvePermissionsStore } from "../src/lib/runtime/execute-route.js"

const cleanup: Array<() => Promise<void> | void> = []

type LoadMarker = { __dawnPermissionsLoads?: number }

// The config memo is process-global and shared with every other test in this
// worker — clear what we seed on both sides, as config-seam.test.ts does.
beforeEach(() => {
  __clearDawnConfigCacheForTests()
  delete (globalThis as LoadMarker).__dawnPermissionsLoads
  delete process.env.DAWN_PERMISSIONS_MODE
})

afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
  __clearDawnConfigCacheForTests()
  delete (globalThis as LoadMarker).__dawnPermissionsLoads
})

async function fixtureApp(configBody: string): Promise<string> {
  const appRoot = await mkdtemp(join(tmpdir(), "dawn-resolve-permissions-"))
  cleanup.push(() => rm(appRoot, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 }))
  await writeFile(join(appRoot, "dawn.config.ts"), configBody, "utf8")
  await writeFile(
    join(appRoot, "package.json"),
    '{ "name": "resolve-permissions-fixture", "type": "module" }\n',
    "utf8",
  )
  return appRoot
}

// A custom store whose decisions are distinguishable from the file store's:
// it denies everything, while the file store built from this same config's
// `allow: { bash: ["ls"] }` would allow "ls -la". It also counts its load()
// calls, and reports a mode that differs from the config's.
const CUSTOM_STORE_CONFIG =
  "const marker = globalThis as { __dawnPermissionsLoads?: number }\n" +
  "const store = {\n" +
  '  mode: "non-interactive" as const,\n' +
  "  load: async () => {\n" +
  "    marker.__dawnPermissionsLoads = (marker.__dawnPermissionsLoads ?? 0) + 1\n" +
  "  },\n" +
  '  match: () => "deny" as const,\n' +
  "  addAllow: async () => {},\n" +
  "}\n" +
  'export default { permissions: { mode: "interactive", allow: { bash: ["ls"] }, store } }\n'

const FILE_STORE_CONFIG =
  'export default { permissions: { mode: "interactive", allow: { bash: ["ls"] } } }\n'

describe("resolvePermissionsStore — config.permissions.store seam", () => {
  it("a config-supplied store wins over the file-backed store and is loaded once", async () => {
    const appRoot = await fixtureApp(CUSTOM_STORE_CONFIG)

    const store = await resolvePermissionsStore(appRoot)

    // The file store built from the same config would allow this.
    expect(store.match("bash", "ls -la")).toBe("deny")
    // Returned as-is: its own mode survives, not the config's "interactive".
    expect(store.mode).toBe("non-interactive")
    // The resolver owns hydration — a cache-backed store is empty until then.
    expect((globalThis as LoadMarker).__dawnPermissionsLoads).toBe(1)
  })

  it("without a config store, the file-backed store is used (negative control)", async () => {
    const appRoot = await fixtureApp(FILE_STORE_CONFIG)

    const store = await resolvePermissionsStore(appRoot)

    expect(store.match("bash", "ls -la")).toBe("allow")
    expect(store.mode).toBe("interactive")
  })
})
