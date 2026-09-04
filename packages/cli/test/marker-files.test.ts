import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { MAX_MEMORY_BYTES, MAX_PLAN_BYTES, type RouteDefinition } from "@dawn-ai/core"
import { afterEach, describe, expect, it } from "vitest"

import {
  assertRouteMarkerFileLimits,
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

/** `<tmp>/src/app/chat` route dir under `<tmp>` app root, with the given files. */
async function appRouteDir(
  files: Readonly<Record<string, string>>,
): Promise<{ appRoot: string; routeDir: string }> {
  const appRoot = await realpath(await mkdtemp(join(tmpdir(), "dawn-marker-files-")))
  cleanup.push(() => rm(appRoot, { force: true, maxRetries: 5, recursive: true }))
  const routeDir = join(appRoot, "src/app/chat")
  for (const [rel, body] of Object.entries(files)) {
    const filePath = join(routeDir, rel)
    await mkdir(join(filePath, ".."), { recursive: true })
    await writeFile(filePath, body, "utf8")
  }
  return { appRoot, routeDir }
}

describe("collectRouteMarkerFiles", () => {
  it("returns undefined for a route with no marker files", async () => {
    const dir = await routeDir({ "index.ts": "export default {}\n" })
    expect(await collectRouteMarkerFiles({ appRoot: dir, routeDir: dir })).toBeUndefined()
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
    expect(await collectRouteMarkerFiles({ appRoot: dir, routeDir: dir })).toEqual([
      { content: "mem", relativePath: "memory.md" },
      { content: "- [ ] one\n", relativePath: "plan.md" },
      { content: "---\ndescription: A.\n---\nA", relativePath: "skills/a-skill/SKILL.md" },
      { content: "---\ndescription: B.\n---\nB", relativePath: "skills/b-skill/SKILL.md" },
    ])
  })

  it("fails by name when a file exceeds its marker's limit", async () => {
    const { appRoot, routeDir: dir } = await appRouteDir({
      "skills/big/SKILL.md": "x".repeat(MARKER_FILE_LIMITS["SKILL.md"] + 1),
    })
    const error = await collectRouteMarkerFiles({ appRoot, routeDir: dir }).catch((e: unknown) => e)
    expect(String(error)).toContain("src/app/chat/skills/big/SKILL.md")
    expect(String(error)).toContain(String(MARKER_FILE_LIMITS["SKILL.md"] + 1))
    expect((error as { code?: string }).code).toBe("DAWN_E1005")
  })

  it("counts bytes, not characters: a multi-byte memory.md one byte over fails", async () => {
    // "é" is 2 bytes in UTF-8. 16383 of them = 32766 bytes; plus "abc" = 32769 > 32768.
    const { appRoot, routeDir: dir } = await appRouteDir({
      "memory.md": `${"é".repeat(16383)}abc`,
    })
    const error = await collectRouteMarkerFiles({ appRoot, routeDir: dir }).catch((e: unknown) => e)
    expect(String(error)).toContain("src/app/chat/memory.md")
    expect(String(error)).toContain("32769")
    expect((error as { code?: string }).code).toBe("DAWN_E1005")
  })

  it("allows a file exactly at its limit", async () => {
    const dir = await routeDir({ "plan.md": "x".repeat(MARKER_FILE_LIMITS["plan.md"]) })
    const found = await collectRouteMarkerFiles({ appRoot: dir, routeDir: dir })
    expect(found?.[0]?.relativePath).toBe("plan.md")
  })

  it("uses the per-kind limits the markers enforce at runtime", () => {
    expect(MARKER_FILE_LIMITS["memory.md"]).toBe(MAX_MEMORY_BYTES)
    expect(MARKER_FILE_LIMITS["plan.md"]).toBe(MAX_PLAN_BYTES)
    expect(MARKER_FILE_LIMITS["SKILL.md"]).toBe(32 * 1024)
  })

  it("reports every oversized file in one error", async () => {
    const { appRoot, routeDir: dir } = await appRouteDir({
      "plan.md": "x".repeat(MARKER_FILE_LIMITS["plan.md"] + 1),
      "skills/big/SKILL.md": "x".repeat(MARKER_FILE_LIMITS["SKILL.md"] + 1),
    })
    const error = await collectRouteMarkerFiles({ appRoot, routeDir: dir }).catch((e: unknown) => e)
    const message = String(error)
    expect(message).toContain("src/app/chat/plan.md")
    expect(message).toContain("src/app/chat/skills/big/SKILL.md")
    expect(message).toContain(String(MARKER_FILE_LIMITS["plan.md"]))
    expect(message).toContain(String(MARKER_FILE_LIMITS["SKILL.md"]))
    expect(
      message.match(/Marker file\(s\) too large for the static module manifest/g),
    ).toHaveLength(1)
    // Same order the collector walks: plan.md before any skill.
    expect(message.indexOf("src/app/chat/plan.md")).toBeLessThan(
      message.indexOf("src/app/chat/skills/big/SKILL.md"),
    )
    expect((error as { code?: string }).code).toBe("DAWN_E1005")
  })

  it("counts re-encoded bytes for invalid UTF-8", async () => {
    const { appRoot, routeDir: dir } = await appRouteDir({})
    const filePath = join(dir, "memory.md")
    await mkdir(dir, { recursive: true })
    await writeFile(
      filePath,
      Buffer.concat([
        Buffer.from("x".repeat(32760), "ascii"),
        Buffer.from([0xff, 0xfe, 0xff, 0xfe]),
      ]),
    )
    const error = await collectRouteMarkerFiles({ appRoot, routeDir: dir }).catch((e: unknown) => e)
    expect(String(error)).toContain("memory.md")
    expect(String(error)).toContain(
      "32772 bytes after UTF-8 re-encoding, over the 32768-byte limit for memory.md",
    )
    expect((error as { code?: string }).code).toBe("DAWN_E1005")
  })
})

describe("assertRouteMarkerFileLimits", () => {
  it("reports oversized files from every route in one error", async () => {
    const appRoot = await realpath(await mkdtemp(join(tmpdir(), "dawn-marker-files-")))
    cleanup.push(() => rm(appRoot, { force: true, maxRetries: 5, recursive: true }))
    const routes: RouteDefinition[] = []
    for (const name of ["chat", "support"]) {
      const dir = join(appRoot, "src/app", name)
      const filePath = join(dir, "plan.md")
      await mkdir(dir, { recursive: true })
      await writeFile(filePath, "x".repeat(MARKER_FILE_LIMITS["plan.md"] + 1), "utf8")
      routes.push({
        entryFile: join(dir, "route.ts"),
        id: name,
        kind: "agent",
        pathname: `/${name}`,
        routeDir: dir,
        segments: [{ kind: "static", raw: name }],
      })
    }

    const error = await assertRouteMarkerFileLimits({
      appRoot,
      manifest: { appRoot, routes },
    }).catch((e: unknown) => e)

    const message = String(error)
    expect(message).toContain("src/app/chat/plan.md")
    expect(message).toContain("src/app/support/plan.md")
    // One error for the whole app, not one per route.
    expect(
      message.match(/Marker file\(s\) too large for the static module manifest/g),
    ).toHaveLength(1)
    expect((error as { code?: string }).code).toBe("DAWN_E1005")
  })

  it("resolves for an app whose markers are all within their limits", async () => {
    const { appRoot, routeDir: dir } = await appRouteDir({ "plan.md": "- [ ] one\n" })
    await expect(
      assertRouteMarkerFileLimits({
        appRoot,
        manifest: {
          appRoot,
          routes: [
            {
              entryFile: join(dir, "route.ts"),
              id: "chat",
              kind: "agent",
              pathname: "/chat",
              routeDir: dir,
              segments: [{ kind: "static", raw: "chat" }],
            },
          ],
        },
      }),
    ).resolves.toBeUndefined()
  })
})
