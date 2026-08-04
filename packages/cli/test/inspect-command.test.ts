import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { resolveInspectorServer, runInspectCommand } from "../src/commands/inspect.js"

describe("resolveInspectorServer", () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  it("returns null when @dawn-ai/inspector is not installed", () => {
    const appRoot = mkdtempSync(join(tmpdir(), "dawn-inspect-"))
    dirs.push(appRoot)
    expect(resolveInspectorServer(appRoot)).toBeNull()
  })

  it("resolves the standalone server path from the package's dawnInspector field", () => {
    const appRoot = mkdtempSync(join(tmpdir(), "dawn-inspect-"))
    dirs.push(appRoot)
    const pkgDir = join(appRoot, "node_modules", "@dawn-ai", "inspector")
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({
        name: "@dawn-ai/inspector",
        dawnInspector: { server: ".next/standalone/packages/inspector/server.js" },
      }),
    )
    expect(resolveInspectorServer(appRoot)).toBe(
      join(pkgDir, ".next/standalone/packages/inspector/server.js"),
    )
  })

  it("returns null when the package lacks the dawnInspector field", () => {
    const appRoot = mkdtempSync(join(tmpdir(), "dawn-inspect-"))
    dirs.push(appRoot)
    const pkgDir = join(appRoot, "node_modules", "@dawn-ai", "inspector")
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "@dawn-ai/inspector" }))
    expect(resolveInspectorServer(appRoot)).toBeNull()
  })
})

describe("runInspectCommand", () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  it("prints the install hint and returns when the package is absent", async () => {
    const appRoot = mkdtempSync(join(tmpdir(), "dawn-inspect-"))
    dirs.push(appRoot)

    const lines: string[] = []
    await runInspectCommand({ cwd: appRoot }, { stdout: (m) => lines.push(m), stderr: () => {} })

    const output = lines.join("")
    expect(output).toContain("not installed")
    expect(output).toContain("npm i -D @dawn-ai/inspector")
    expect(output).toContain("dawn inspect")
  })
})
