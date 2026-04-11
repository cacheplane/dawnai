import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"

import { loadDawnConfig } from "../src/config"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })))
})

async function createConfigFixture(source: string) {
  const appRoot = await mkdtemp(join(tmpdir(), "dawn-core-config-"))
  tempDirs.push(appRoot)

  const configPath = join(appRoot, "dawn.config.ts")
  await mkdir(dirname(configPath), { recursive: true })
  await writeFile(configPath, source)

  return appRoot
}

describe("loadDawnConfig", () => {
  test("supports const-backed appDir exports", async () => {
    const appRoot = await createConfigFixture(
      'const appDir = "src/custom-app";\nexport default { appDir };\n',
    )

    await expect(loadDawnConfig({ appRoot })).resolves.toMatchObject({
      appRoot,
      config: { appDir: "src/custom-app" },
      configPath: join(appRoot, "dawn.config.ts"),
    })
  })

  test("rejects unsupported config shapes with a Dawn-specific error", async () => {
    const appRoot = await createConfigFixture(
      'export default defineConfig({ appDir: "src/custom-app" });\n',
    )

    await expect(loadDawnConfig({ appRoot })).rejects.toThrow("Unsupported dawn.config.ts syntax")
  })
})
