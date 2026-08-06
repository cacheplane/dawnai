import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import { __clearDawnConfigCacheForTests, loadDawnConfig } from "../src/config.js"

describe("loadDawnConfig memoization", () => {
  test("returns the identical result object for repeated calls on one appRoot", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "dawn-config-memo-"))
    await writeFile(join(appRoot, "dawn.config.ts"), "export default { }\n", "utf8")
    const a = await loadDawnConfig({ appRoot })
    const b = await loadDawnConfig({ appRoot })
    expect(b).toBe(a) // same promise result — no re-import, no re-access()
  })

  test("distinct appRoots are cached independently", async () => {
    const r1 = await mkdtemp(join(tmpdir(), "dawn-config-memo-"))
    const r2 = await mkdtemp(join(tmpdir(), "dawn-config-memo-"))
    await writeFile(join(r1, "dawn.config.ts"), "export default { }\n", "utf8")
    await writeFile(join(r2, "dawn.config.ts"), "export default { }\n", "utf8")
    expect(await loadDawnConfig({ appRoot: r1 })).not.toBe(await loadDawnConfig({ appRoot: r2 }))
  })

  test("test-only cache clear forces a fresh load", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "dawn-config-memo-"))
    await writeFile(join(appRoot, "dawn.config.ts"), "export default { }\n", "utf8")
    const a = await loadDawnConfig({ appRoot })
    __clearDawnConfigCacheForTests()
    const b = await loadDawnConfig({ appRoot })
    expect(b).not.toBe(a)
  })
})
