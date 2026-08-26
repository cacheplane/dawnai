import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import * as generatorModule from "../../scripts/generate-seo-lastmod.mjs"

const testDirectory = dirname(fileURLToPath(import.meta.url))
const appRoot = resolve(testDirectory, "..", "..")
const generator = join(appRoot, "scripts", "generate-seo-lastmod.mjs")
const generatedManifest = join(appRoot, "app", "seo", "lastmod.generated.ts")
const ciWorkflow = resolve(appRoot, "..", "..", ".github", "workflows", "ci.yml")
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
  it("runs a freshness check for the checked-in manifest using today's production visibility", () => {
    const result = runGenerator("--check")

    expect(result.status).toBe(0)
  }, 15_000) // Git history traversal can exceed Vitest's default timeout under parallel suite load.

  it("uses a full-history checkout for the canonical source-test job", () => {
    const workflow = readFileSync(ciWorkflow, "utf8")
    const validateJob = workflow.slice(
      workflow.indexOf("  validate:"),
      workflow.indexOf("  testing-windows:"),
    )

    expect(validateJob).toContain("fetch-depth: 0")
  })

  it("normalizes Windows-style relative paths before deriving manifest keys", () => {
    expect(generatorModule.normalizeRelativePath("content\\docs\\api\\sdk.mdx")).toBe(
      "content/docs/api/sdk.mdx",
    )
  })

  it("recognizes a symlinked direct invocation of the generator", () => {
    const directory = mkdtempSync(join(tmpdir(), "dawn-lastmod-"))
    temporaryDirectories.push(directory)
    const symlink = join(directory, "generate-seo-lastmod.mjs")
    symlinkSync(generator, symlink)

    expect(generatorModule.isDirectExecution(symlink, generator)).toBe(true)
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
    expect(result.stderr).toContain("pnpm --dir apps/web seo:lastmod --as-of 2026-08-26")
    expect(readFileSync(generatedManifest, "utf8")).toBe(originalManifest)
  })

  it("uses the explicit as-of date when checking the checked-in manifest", () => {
    const beforeJune = runGenerator("--as-of", "2026-05-18", "--check")

    expect(beforeJune.status).toBe(1)
    expect(beforeJune.stderr).toContain("SEO last-modified manifest is stale")
  })
})
