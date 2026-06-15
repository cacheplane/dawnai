import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { diagnose } from "../src/lib/diagnostics.js"

function esmError(specifier: string, name: string): SyntaxError {
  return new SyntaxError(
    `The requested module '${specifier}' does not provide an export named '${name}'`,
  )
}

describe("diagnose", () => {
  let appRoot: string
  beforeEach(() => {
    appRoot = mkdtempSync(join(tmpdir(), "dawn-diag-"))
  })
  afterEach(() => {
    rmSync(appRoot, { recursive: true, force: true })
  })

  function installPkg(name: string, pkgJson: Record<string, unknown>): void {
    const dir = join(appRoot, "node_modules", ...name.split("/"))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "package.json"), JSON.stringify(pkgJson), "utf8")
  }

  it("returns null for an unrelated error", () => {
    expect(diagnose(new Error("boom"), { appRoot })).toBeNull()
  })

  it("classifies @langchain/core as a version-floor issue, naming installed version", () => {
    installPkg("@langchain/core", { name: "@langchain/core", version: "1.1.40", type: "module" })
    const d = diagnose(esmError("@langchain/core", "tool"), { appRoot })
    expect(d).not.toBeNull()
    expect(d?.summary).toContain("@langchain/core")
    expect(d?.hint).toContain("1.1.40")
    expect(d?.hint).toMatch(/npm ls @langchain\/core/)
  })

  it("includes Dawn's required @langchain/core range in the #3 hint", () => {
    installPkg("@langchain/core", { name: "@langchain/core", version: "1.1.40", type: "module" })
    const d = diagnose(esmError("@langchain/core", "tool"), { appRoot })
    // requiredCoreRange resolves @dawn-ai/langchain from the cli package location,
    // independent of the temp appRoot. Expect the real floor, e.g. "^1.1.47".
    expect(d?.hint).toMatch(/satisfying \^?1\.1\.\d+/)
  })

  it("treats a CommonJS-typed @langchain package as a version issue, not a module-format issue", () => {
    installPkg("@langchain/core", { name: "@langchain/core", version: "1.1.40", type: "commonjs" })
    const d = diagnose(esmError("@langchain/core", "tool"), { appRoot })
    expect(d?.hint).toMatch(/npm ls @langchain\/core/) // #3 hint
    expect(d?.hint).not.toMatch(/default import and destructure/i) // not the #4 hint
  })

  it("classifies a subpath specifier to its package", () => {
    installPkg("@langchain/core", { name: "@langchain/core", version: "1.1.40", type: "module" })
    const d = diagnose(esmError("@langchain/core/messages", "AIMessage"), { appRoot })
    expect(d?.summary).toContain("@langchain/core")
  })

  it("classifies a CommonJS dependency as a module-format issue", () => {
    installPkg("legacy-dep", { name: "legacy-dep", version: "2.0.0", type: "commonjs" })
    const d = diagnose(esmError("legacy-dep", "doThing"), { appRoot })
    expect(d?.summary).toContain("legacy-dep")
    expect(d?.hint).toMatch(/CommonJS/i)
    expect(d?.hint).toContain("doThing")
  })

  it('treats a package with no "type" field as CommonJS', () => {
    installPkg("untyped-dep", { name: "untyped-dep", version: "1.0.0" })
    const d = diagnose(esmError("untyped-dep", "x"), { appRoot })
    expect(d?.hint).toMatch(/CommonJS/i)
  })

  it("falls back to a generic named message for an ESM package missing the export", () => {
    installPkg("modern-dep", { name: "modern-dep", version: "1.0.0", type: "module" })
    const d = diagnose(esmError("modern-dep", "missingThing"), { appRoot })
    expect(d).not.toBeNull()
    expect(d?.summary).toContain("modern-dep")
    expect(d?.summary).toContain("missingThing")
    expect(d?.hint).toMatch(/version|format/i)
  })

  it("falls back to generic when the package.json can't be read", () => {
    const d = diagnose(esmError("ghost-dep", "x"), { appRoot })
    expect(d).not.toBeNull()
    expect(d?.summary).toContain("ghost-dep")
  })

  it("finds the error through a cause chain", () => {
    installPkg("legacy-dep", { name: "legacy-dep", version: "2.0.0", type: "commonjs" })
    const wrapped = new Error("Validation failed", { cause: esmError("legacy-dep", "y") })
    expect(diagnose(wrapped, { appRoot })?.hint).toMatch(/CommonJS/i)
  })

  it("returns null for a relative-specifier failure (no package to inspect)", () => {
    expect(diagnose(esmError("./local.js", "x"), { appRoot })).toBeNull()
  })
})
