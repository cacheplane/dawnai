import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "vitest"

import { loadDawnConfig } from "../src/config"

const CONTRACT_FIXTURES_DIR = fileURLToPath(
  new URL("../../../test/fixtures/contracts/", import.meta.url),
)

function fixtureRoot(name: string) {
  return join(CONTRACT_FIXTURES_DIR, name)
}

describe("loadDawnConfig", () => {
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
})
