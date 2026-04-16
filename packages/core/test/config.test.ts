import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, test } from "vitest"

import { loadDawnConfig } from "../src/config"

const CONTRACT_FIXTURES_DIR = fileURLToPath(
  new URL("../../../test/fixtures/contracts/", import.meta.url),
)
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })))
})

function fixtureRoot(name: string) {
  return join(CONTRACT_FIXTURES_DIR, name)
}

async function createConfigFixture(source: string) {
  const appRoot = await mkdtemp(join(tmpdir(), "dawn-core-config-"))
  tempDirs.push(appRoot)

  await writeFile(join(appRoot, "package.json"), "{}\n")
  await writeFile(join(appRoot, "dawn.config.ts"), source)
  await mkdir(join(appRoot, "src", "app"), { recursive: true })

  return appRoot
}

describe("loadDawnConfig", () => {
  test("loads appDir from an inline string literal", async () => {
    const appRoot = await createConfigFixture('export default { appDir: "src/custom-app" }\n')

    await expect(loadDawnConfig({ appRoot })).resolves.toMatchObject({
      appRoot,
      config: { appDir: "src/custom-app" },
      configPath: join(appRoot, "dawn.config.ts"),
    })
  })

  test("loads appDir from the checked-in custom appDir fixture", async () => {
    const appRoot = fixtureRoot("valid-custom-app-dir")

    await expect(loadDawnConfig({ appRoot })).resolves.toMatchObject({
      appRoot,
      config: { appDir: "src/dawn-app" },
      configPath: join(appRoot, "dawn.config.ts"),
    })
  })

  test("rejects the checked-in invalid config fixture with a Dawn-specific parser error", async () => {
    const appRoot = fixtureRoot("invalid-config")

    await expect(loadDawnConfig({ appRoot })).rejects.toThrow("Unsupported dawn.config.ts syntax")
  })

  test("rejects unsupported config properties with a stable parser error", async () => {
    const appRoot = await createConfigFixture('export default { appDir: "src/app", mode: "dev" }\n')

    await expect(loadDawnConfig({ appRoot })).rejects.toThrow(
      'Unsupported dawn.config.ts syntax: unsupported property "mode". Supported subset: optional const string declarations followed by export default { appDir } or export default { appDir: "..." }.',
    )
  })

  test("rejects non-string const appDir bindings with a stable parser error", async () => {
    const appRoot = await createConfigFixture(
      "const appDir = getAppDir()\nexport default { appDir }\n",
    )

    await expect(loadDawnConfig({ appRoot })).rejects.toThrow(
      'Unsupported dawn.config.ts syntax: unexpected token "(". Supported subset: optional const string declarations followed by export default { appDir } or export default { appDir: "..." }.',
    )
  })
})
