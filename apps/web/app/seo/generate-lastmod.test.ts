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
const generatedManifest = join(appRoot, "app", "seo", "lastmod.generated.json")
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
  it("runs a freshness check using today's production visibility", () => {
    const result = runGenerator("--check")

    expect(result.status).toBe(0)
  })

  it("checks an unchanged manifest without consulting Git history", () => {
    const result = spawnSync(process.execPath, [generator, "--check"], {
      cwd: appRoot,
      encoding: "utf8",
      env: { ...process.env, PATH: "" },
    })

    expect(result.status).toBe(0)
  })

  it("generates timestamps for new content state without consulting Git history", () => {
    const directory = mkdtempSync(join(tmpdir(), "dawn-lastmod-"))
    temporaryDirectories.push(directory)
    const output = join(directory, "lastmod.generated.json")
    const startedAt = Date.now()
    const result = spawnSync(process.execPath, [generator, "--output", output], {
      cwd: appRoot,
      encoding: "utf8",
      env: { ...process.env, PATH: "" },
    })
    const finishedAt = Date.now()

    expect(result.status).toBe(0)

    const manifest = JSON.parse(readFileSync(output, "utf8"))
    const generatedTimestamp = Date.parse(manifest.routes["/"].lastModified)

    expect(generatedTimestamp).toBeGreaterThanOrEqual(startedAt)
    expect(generatedTimestamp).toBeLessThanOrEqual(finishedAt)
  })

  it("normalizes Windows-style relative paths before deriving manifest keys", () => {
    expect(generatorModule.normalizeRelativePath("content\\docs\\api\\sdk.mdx")).toBe(
      "content/docs/api/sdk.mdx",
    )
  })

  it("preserves a generated timestamp when the source digest still matches", () => {
    expect(
      generatorModule.selectLastModified(
        {
          lastModified: "2026-08-26T20:23:52.000Z",
          sourceDigest: "same-content",
          recordDigest: generatorModule.recordDigest(
            "/docs/example",
            "2026-08-26T20:23:52.000Z",
            "same-content",
          ),
        },
        "/docs/example",
        "same-content",
        "2026-08-31T23:34:54.000Z",
      ),
    ).toBe("2026-08-26T20:23:52.000Z")
  })

  it("uses the current generation timestamp when the source digest changes", () => {
    expect(
      generatorModule.selectLastModified(
        {
          lastModified: "2026-08-26T20:23:52.000Z",
          sourceDigest: "old-content",
          recordDigest: generatorModule.recordDigest(
            "/docs/example",
            "2026-08-26T20:23:52.000Z",
            "old-content",
          ),
        },
        "/docs/example",
        "new-content",
        "2026-08-31T23:34:54.000Z",
      ),
    ).toBe("2026-08-31T23:34:54.000Z")
  })

  it("uses the current generation timestamp when the preserved timestamp is malformed", () => {
    expect(
      generatorModule.selectLastModified(
        {
          lastModified: "not-a-date",
          sourceDigest: "same-content",
          recordDigest: "invalid",
        },
        "/docs/example",
        "same-content",
        "2026-08-31T23:34:54.000Z",
      ),
    ).toBe("2026-08-31T23:34:54.000Z")
  })

  it("recognizes a symlinked direct invocation of the generator", () => {
    const directory = mkdtempSync(join(tmpdir(), "dawn-lastmod-"))
    temporaryDirectories.push(directory)
    const symlink = join(directory, "generate-seo-lastmod.mjs")
    symlinkSync(generator, symlink)

    expect(generatorModule.isDirectExecution(symlink, generator)).toBe(true)
  })

  it("fails check mode for a stale target without changing the checked-in manifest", () => {
    const originalManifest = readFileSync(generatedManifest, "utf8")
    const directory = mkdtempSync(join(tmpdir(), "dawn-lastmod-"))
    temporaryDirectories.push(directory)
    const staleManifest = join(directory, "lastmod.generated.json")
    writeFileSync(staleManifest, "stale\n")

    const result = runGenerator("--as-of", "2026-08-26", "--check", "--output", staleManifest)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain("SEO last-modified manifest is stale")
    expect(result.stderr).toContain("pnpm --dir apps/web seo:lastmod --as-of 2026-08-26")
    expect(readFileSync(generatedManifest, "utf8")).toBe(originalManifest)
  })

  it("fails check mode when a preserved timestamp is moved into the future", () => {
    const directory = mkdtempSync(join(tmpdir(), "dawn-lastmod-"))
    temporaryDirectories.push(directory)
    const tamperedManifest = join(directory, "lastmod.generated.json")
    const manifest = JSON.parse(readFileSync(generatedManifest, "utf8"))
    manifest.routes["/"].lastModified = "2099-01-01T00:00:00.000Z"
    manifest.routes["/"].recordDigest = generatorModule.recordDigest(
      "/",
      manifest.routes["/"].lastModified,
      manifest.routes["/"].sourceDigest,
    )
    writeFileSync(tamperedManifest, `${JSON.stringify(manifest, null, 2)}\n`)

    const result = runGenerator("--check", "--output", tamperedManifest)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain("SEO last-modified manifest is stale")
  })

  it("uses the explicit as-of date when checking the checked-in manifest", () => {
    const beforeJune = runGenerator("--as-of", "2026-05-18", "--check")

    expect(beforeJune.status).toBe(1)
    expect(beforeJune.stderr).toContain("SEO last-modified manifest is stale")
  })
})
