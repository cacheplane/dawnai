import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { loadEnvFiles } from "../src/lib/dev/load-env.js"
import { resolveEnvPath } from "../src/lib/dev/resolve-env-path.js"

describe("env loading (monorepo integration)", () => {
  let root: string
  const saved = { ...process.env }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "dawn-env-int-"))
    mkdirSync(join(root, "app"), { recursive: true })
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
  })

  it("config.env '../.env' loads the workspace-root .env from a nested app", () => {
    writeFileSync(join(root, ".env"), "DAWN_ROOT_VAR=root\n")
    delete process.env.DAWN_ROOT_VAR
    const appRoot = join(root, "app")
    const r = resolveEnvPath({ appRoot, configEnv: "../.env" })
    expect(r.source).toBe("config")
    loadEnvFiles([r.absPath])
    expect(process.env.DAWN_ROOT_VAR).toBe("root")
  })

  it("--env-file overrides config.env", () => {
    writeFileSync(join(root, ".env"), "DAWN_PICK=root\n")
    writeFileSync(join(root, "app", "custom.env"), "DAWN_PICK=custom\n")
    delete process.env.DAWN_PICK
    const appRoot = join(root, "app")
    const r = resolveEnvPath({ appRoot, configEnv: "../.env", flag: "custom.env" })
    loadEnvFiles([r.absPath])
    expect(process.env.DAWN_PICK).toBe("custom")
  })

  it("regression: plain app/.env with no config/flag still loads", () => {
    writeFileSync(join(root, "app", ".env"), "DAWN_LOCAL=local\n")
    delete process.env.DAWN_LOCAL
    const appRoot = join(root, "app")
    const r = resolveEnvPath({ appRoot })
    expect(r.source).toBe("default")
    loadEnvFiles([r.absPath])
    expect(process.env.DAWN_LOCAL).toBe("local")
  })
})
