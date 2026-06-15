import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { CliError } from "../src/lib/output.js"
import { importModule } from "../src/lib/runtime/import-module.js"

describe("importModule", () => {
  let appRoot: string
  beforeEach(() => {
    appRoot = mkdtempSync(join(tmpdir(), "dawn-importmod-"))
  })
  afterEach(() => {
    rmSync(appRoot, { recursive: true, force: true })
  })

  it("returns the module on success", async () => {
    const file = join(appRoot, "ok.mjs")
    writeFileSync(file, "export const value = 42\n", "utf8")
    const mod = (await importModule(pathToFileURL(file).href, { kind: "route", appRoot })) as {
      value: number
    }
    expect(mod.value).toBe(42)
  })

  it("rethrows a diagnosable failure as an enriched CliError with cause", async () => {
    // Install a CommonJS package so diagnose() classifies the failure as a
    // CJS-named-export problem. The module under test throws the Node-ESM-shaped
    // SyntaxError at evaluation time — this is the exact error production hits
    // (Node's ESM resolver / tsx) and is reproduced directly rather than relying
    // on the test runner's CJS interop, which permissively resolves the named
    // import to undefined instead of throwing.
    const dep = join(appRoot, "node_modules", "legacy-dep")
    mkdirSync(dep, { recursive: true })
    writeFileSync(
      join(dep, "package.json"),
      JSON.stringify({ name: "legacy-dep", version: "1.0.0", type: "commonjs", main: "index.js" }),
      "utf8",
    )
    writeFileSync(join(dep, "index.js"), "module.exports = { present: 1 }\n", "utf8")
    const route = join(appRoot, "route.mjs")
    writeFileSync(
      route,
      `throw new SyntaxError("The requested module 'legacy-dep' does not provide an export named 'absent'")\n`,
      "utf8",
    )

    const err = await importModule(pathToFileURL(route).href, {
      kind: "route",
      appRoot,
      sourcePath: route,
    }).catch((e) => e)
    expect(err).toBeInstanceOf(CliError)
    expect((err as CliError).message).toMatch(/CommonJS/i)
    expect((err as CliError).message).toContain("route")
    expect((err as CliError).cause).toBeInstanceOf(Error)
  })

  it("rethrows a non-diagnosable error untouched", async () => {
    const file = join(appRoot, "throws.mjs")
    writeFileSync(file, 'throw new Error("plain boom")\n', "utf8")
    await expect(importModule(pathToFileURL(file).href, { kind: "tool", appRoot })).rejects.toThrow(
      /plain boom/,
    )
  })
})
