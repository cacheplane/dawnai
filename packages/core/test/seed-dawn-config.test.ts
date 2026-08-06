import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import { __clearDawnConfigCacheForTests, loadDawnConfig, seedDawnConfig } from "../src/config.js"

afterEach(() => __clearDawnConfigCacheForTests())

describe("seedDawnConfig", () => {
  test("primes the memo so loadDawnConfig never touches disk", async () => {
    // A nonexistent appRoot: the disk path would reject on access() — success
    // here proves the seed satisfied the load without any filesystem read.
    seedDawnConfig("/nonexistent/edge-app", { memory: { recall: {} } })
    const loaded = await loadDawnConfig({ appRoot: "/nonexistent/edge-app" })
    expect(loaded.config.memory?.recall).toEqual({})
    expect(loaded.configPath).toBe("<seeded>")
  })

  test("a seeded config wins over a real config file (explicit beats disk)", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "dawn-seed-config-"))
    await writeFile(
      join(appRoot, "dawn.config.ts"),
      'export default { permissions: { mode: "bypass" } }\n',
      "utf8",
    )
    // Load from disk first so the memo holds the disk entry, then seed: an
    // explicit seed overwrites a cached disk load, not just an empty memo.
    const fromDisk = await loadDawnConfig({ appRoot })
    expect(fromDisk.configPath).toBe(join(appRoot, "dawn.config.ts"))

    seedDawnConfig(appRoot, { permissions: { mode: "non-interactive" } })
    const loaded = await loadDawnConfig({ appRoot })
    expect(loaded.configPath).toBe("<seeded>")
    expect(loaded.config.permissions?.mode).toBe("non-interactive")
  })
})
