import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import type { RouteManifest } from "@dawn-ai/core"
import type { DawnAgent } from "@dawn-ai/sdk"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  __resetDescriptorRouteIndexCacheForTests,
  getCachedDescriptorRouteIndex,
} from "../src/lib/runtime/descriptor-route-index.js"

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

describe("getCachedDescriptorRouteIndex", () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "dawn-cache-test-"))
    __resetDescriptorRouteIndexCacheForTests()
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it("returns the same Map instance for the same manifest object (cache hit)", async () => {
    const entryFile = join(tmp, "a.ts")
    writeFileSync(entryFile, `export default { __dawn: true }`)
    const m = manifest([{ id: "/a", entryFile, routeDir: tmp }])

    const first = await getCachedDescriptorRouteIndex(m)
    const second = await getCachedDescriptorRouteIndex(m)

    expect(second).toBe(first)
  })

  it("builds a fresh map for a different manifest object (cache miss)", async () => {
    const entryFile = join(tmp, "b.ts")
    writeFileSync(entryFile, `export default { __dawn: true }`)
    const m1 = manifest([{ id: "/b", entryFile, routeDir: tmp }])
    const m2 = manifest([{ id: "/b", entryFile, routeDir: tmp }])

    const map1 = await getCachedDescriptorRouteIndex(m1)
    const map2 = await getCachedDescriptorRouteIndex(m2)

    expect(map2).not.toBe(map1)
  })

  it("populates descriptor entries for routes whose default export is a DawnAgent", async () => {
    const entryFile = join(tmp, "agent.ts")
    writeFileSync(
      entryFile,
      `import { agent } from "@dawn-ai/sdk"\nexport default agent({ model: "gpt-5", systemPrompt: "x" })\n`,
    )
    const m = manifest([{ id: "/a", entryFile, routeDir: tmp }])
    const map = await getCachedDescriptorRouteIndex(m)
    expect(map).toBeInstanceOf(Map)
  })

  it("stores every descriptor route candidate in stable sorted order", async () => {
    const descriptorFile = join(tmp, "shared.ts")
    const routeA = join(tmp, "route-a.ts")
    const routeB = join(tmp, "route-b.ts")
    writeFileSync(
      descriptorFile,
      `import { agent } from "@dawn-ai/sdk"\nexport default agent({ model: "gpt-5-mini" })\n`,
    )
    writeFileSync(routeA, `export { default } from "./shared.js"\n`)
    writeFileSync(routeB, `export { default } from "./shared.js"\n`)
    const m = manifest([
      { id: "/z-route", entryFile: routeA, routeDir: tmp },
      { id: "/a-route", entryFile: routeB, routeDir: tmp },
    ])

    const descriptor = (
      (await import(pathToFileURL(descriptorFile).href)) as { default: DawnAgent }
    ).default
    const map = await getCachedDescriptorRouteIndex(m)

    expect(map.get(descriptor)).toEqual(["/a-route", "/z-route"])
  })
})
