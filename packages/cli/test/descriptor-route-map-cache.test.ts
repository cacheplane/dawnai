import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { RouteManifest } from "@dawn-ai/core"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  __resetDescriptorRouteMapCacheForTests,
  getCachedDescriptorRouteMap,
} from "../src/lib/runtime/execute-route.js"

function manifest(routes: { id: string; entryFile: string; routeDir: string }[]): RouteManifest {
  return {
    appRoot: "/tmp",
    routes: routes.map((r) => ({
      ...r,
      pathname: r.id,
      kind: "agent" as const,
      segments: r.id
        .split("/")
        .filter(Boolean)
        .map((seg) => ({ kind: "static" as const, raw: seg })),
    })),
  }
}

describe("getCachedDescriptorRouteMap", () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "dawn-cache-test-"))
    __resetDescriptorRouteMapCacheForTests()
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it("returns the same Map instance for the same manifest object (cache hit)", async () => {
    const entryFile = join(tmp, "a.ts")
    writeFileSync(entryFile, `export default { __dawn: true }`)
    const m = manifest([{ id: "/a", entryFile, routeDir: tmp }])

    const first = await getCachedDescriptorRouteMap(m)
    const second = await getCachedDescriptorRouteMap(m)

    expect(second).toBe(first)
  })

  it("builds a fresh map for a different manifest object (cache miss)", async () => {
    const entryFile = join(tmp, "b.ts")
    writeFileSync(entryFile, `export default { __dawn: true }`)
    const m1 = manifest([{ id: "/b", entryFile, routeDir: tmp }])
    const m2 = manifest([{ id: "/b", entryFile, routeDir: tmp }])

    const map1 = await getCachedDescriptorRouteMap(m1)
    const map2 = await getCachedDescriptorRouteMap(m2)

    expect(map2).not.toBe(map1)
  })

  it("populates descriptor entries for routes whose default export is a DawnAgent", async () => {
    const entryFile = join(tmp, "agent.ts")
    writeFileSync(
      entryFile,
      `import { agent } from "@dawn-ai/sdk"\nexport default agent({ model: "gpt-5", systemPrompt: "x" })\n`,
    )
    const m = manifest([{ id: "/a", entryFile, routeDir: tmp }])
    const map = await getCachedDescriptorRouteMap(m)
    expect(map).toBeInstanceOf(Map)
  })
})
