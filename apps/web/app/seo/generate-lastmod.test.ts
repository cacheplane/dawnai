import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import * as generatorModule from "../../scripts/generate-seo-lastmod.mjs"

const appRoot = resolve(process.cwd())
const generator = join(appRoot, "scripts", "generate-seo-lastmod.mjs")
const generatedManifest = join(appRoot, "app", "seo", "lastmod.generated.ts")
const temporaryDirectories: string[] = []

function runGenerator(...args: string[]) {
  return spawnSync(process.execPath, [generator, ...args], {
    cwd: appRoot,
    encoding: "utf8",
  })
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true })
})

describe("generate-seo-lastmod", () => {
  it("normalizes Windows-style relative paths before deriving manifest keys", () => {
    expect(generatorModule.normalizeRelativePath("content\\docs\\api\\sdk.mdx")).toBe(
      "content/docs/api/sdk.mdx",
    )
  })

  it("fails check mode when a target manifest is stale without changing the checked-in manifest", () => {
    const originalManifest = readFileSync(generatedManifest, "utf8")
    const directory = mkdtempSync(join(tmpdir(), "dawn-lastmod-"))
    temporaryDirectories.push(directory)
    const staleManifest = join(directory, "lastmod.generated.ts")
    writeFileSync(staleManifest, "stale\n")

    const result = runGenerator("--as-of", "2026-08-26", "--check", "--output", staleManifest)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain("SEO last-modified manifest is stale")
    expect(readFileSync(generatedManifest, "utf8")).toBe(originalManifest)
  })

  it("uses the explicit as-of date when checking the checked-in manifest", () => {
    const beforeJune = runGenerator("--as-of", "2026-05-18", "--check")

    expect(beforeJune.status).toBe(1)
    expect(beforeJune.stderr).toContain("SEO last-modified manifest is stale")
  })
})
