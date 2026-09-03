import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import {
  collectRouteMarkerFiles,
  MARKER_FILE_LIMITS,
} from "../src/lib/build/targets/marker-files.js"

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

async function routeDir(files: Readonly<Record<string, string>>): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "dawn-marker-files-")))
  cleanup.push(() => rm(dir, { force: true, maxRetries: 5, recursive: true }))
  for (const [rel, body] of Object.entries(files)) {
    const filePath = join(dir, rel)
    await mkdir(join(filePath, ".."), { recursive: true })
    await writeFile(filePath, body, "utf8")
  }
  return dir
}

describe("collectRouteMarkerFiles", () => {
  it("returns undefined for a route with no marker files", async () => {
    const dir = await routeDir({ "index.ts": "export default {}\n" })
    expect(await collectRouteMarkerFiles(dir)).toBeUndefined()
  })

  it("reads plan.md, memory.md, and every discovered SKILL.md, keyed route-relative", async () => {
    const dir = await routeDir({
      "memory.md": "mem",
      "plan.md": "- [ ] one\n",
      "skills/b-skill/SKILL.md": "---\ndescription: B.\n---\nB",
      "skills/a-skill/SKILL.md": "---\ndescription: A.\n---\nA",
      "skills/not-a-skill/README.md": "ignored",
      "skills/.hidden/SKILL.md": "ignored: not identifier-shaped",
    })
    expect(await collectRouteMarkerFiles(dir)).toEqual([
      { content: "mem", relativePath: "memory.md" },
      { content: "- [ ] one\n", relativePath: "plan.md" },
      { content: "---\ndescription: A.\n---\nA", relativePath: "skills/a-skill/SKILL.md" },
      { content: "---\ndescription: B.\n---\nB", relativePath: "skills/b-skill/SKILL.md" },
    ])
  })

  it("fails by name when a file exceeds its marker's limit", async () => {
    const dir = await routeDir({
      "skills/big/SKILL.md": "x".repeat(MARKER_FILE_LIMITS["SKILL.md"] + 1),
    })
    const error = await collectRouteMarkerFiles(dir).catch((e: unknown) => e)
    expect(String(error)).toContain("skills/big/SKILL.md")
    expect(String(error)).toContain(String(MARKER_FILE_LIMITS["SKILL.md"] + 1))
    expect((error as { code?: string }).code).toBe("DAWN_E1005")
  })

  it("counts bytes, not characters: a multi-byte memory.md one byte over fails", async () => {
    // "é" is 2 bytes in UTF-8. 16383 of them = 32766 bytes; plus "abc" = 32769 > 32768.
    const dir = await routeDir({ "memory.md": `${"é".repeat(16383)}abc` })
    const error = await collectRouteMarkerFiles(dir).catch((e: unknown) => e)
    expect(String(error)).toContain("memory.md")
    expect(String(error)).toContain("32769")
    expect((error as { code?: string }).code).toBe("DAWN_E1005")
  })

  it("allows a file exactly at its limit", async () => {
    const dir = await routeDir({ "plan.md": "x".repeat(MARKER_FILE_LIMITS["plan.md"]) })
    const found = await collectRouteMarkerFiles(dir)
    expect(found?.[0]?.relativePath).toBe("plan.md")
  })

  it("uses the per-kind limits the markers enforce at runtime", () => {
    expect(MARKER_FILE_LIMITS).toEqual({
      "SKILL.md": 32 * 1024,
      "memory.md": 32 * 1024,
      "plan.md": 64 * 1024,
    })
  })
})
