import { mkdtempSync, rmSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { DAWN_CONFIG_FILE, loadDawnConfig } from "../src/config.js"

describe("loadDawnConfig", () => {
  let appRoot: string

  beforeEach(() => {
    appRoot = mkdtempSync(join(tmpdir(), "dawn-config-"))
  })

  afterEach(() => {
    rmSync(appRoot, { recursive: true, force: true })
  })

  async function writeConfig(source: string): Promise<void> {
    await writeFile(join(appRoot, DAWN_CONFIG_FILE), source, "utf8")
  }

  it("loads a config with just appDir", async () => {
    await writeConfig(`export default { appDir: "src/app" }\n`)
    const loaded = await loadDawnConfig({ appRoot })
    expect(loaded.config).toMatchObject({ appDir: "src/app" })
    expect(loaded.configPath).toBe(join(appRoot, DAWN_CONFIG_FILE))
  })

  it("loads a config with no fields (empty object)", async () => {
    await writeConfig(`export default {}\n`)
    const loaded = await loadDawnConfig({ appRoot })
    expect(loaded.config).toEqual({})
  })

  it("loads a config that uses a const binding for appDir", async () => {
    await writeConfig(`
      const APP_DIR = "src/app"
      export default { appDir: APP_DIR }
    `)
    const loaded = await loadDawnConfig({ appRoot })
    expect(loaded.config).toMatchObject({ appDir: "src/app" })
  })

  it("rejects missing default export", async () => {
    await writeConfig(`export const named = { appDir: "x" }\n`)
    await expect(loadDawnConfig({ appRoot })).rejects.toThrow(/must export default/i)
  })

  it("rejects non-object default export", async () => {
    await writeConfig(`export default "hello"\n`)
    await expect(loadDawnConfig({ appRoot })).rejects.toThrow(/must export default an object/i)
  })

  it("propagates TS syntax errors from the imported module", async () => {
    await writeConfig(`export default { appDir:\n`)
    await expect(loadDawnConfig({ appRoot })).rejects.toThrow()
  })
})
