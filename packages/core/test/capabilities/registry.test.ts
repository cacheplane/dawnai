import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  type CapabilityMarker,
  applyCapabilities,
  createCapabilityRegistry,
} from "../../src/capabilities/registry.js"

describe("CapabilityRegistry + applyCapabilities", () => {
  let routeDir: string

  beforeEach(() => {
    routeDir = mkdtempSync(join(tmpdir(), "dawn-cap-"))
  })

  afterEach(() => {
    rmSync(routeDir, { recursive: true, force: true })
  })

  it("returns no contributions when no markers detect", async () => {
    const registry = createCapabilityRegistry([
      {
        name: "never",
        detect: async () => false,
        load: async () => ({ tools: [{ name: "x", run: () => undefined }] }),
      } satisfies CapabilityMarker,
    ])
    const result = await applyCapabilities(registry, routeDir)
    expect(result.contributions).toEqual([])
  })

  it("returns contributions from each detecting marker, in registration order", async () => {
    const registry = createCapabilityRegistry([
      {
        name: "first",
        detect: async () => true,
        load: async () => ({ tools: [{ name: "alpha", run: () => undefined }] }),
      } satisfies CapabilityMarker,
      {
        name: "second",
        detect: async () => true,
        load: async () => ({ tools: [{ name: "beta", run: () => undefined }] }),
      } satisfies CapabilityMarker,
    ])
    const result = await applyCapabilities(registry, routeDir)
    expect(result.contributions.map((c) => c.markerName)).toEqual(["first", "second"])
    expect(result.contributions[0]?.contribution.tools?.[0]?.name).toBe("alpha")
    expect(result.contributions[1]?.contribution.tools?.[0]?.name).toBe("beta")
  })

  it("skips markers whose detect throws", async () => {
    writeFileSync(join(routeDir, "marker.txt"), "")
    const registry = createCapabilityRegistry([
      {
        name: "throwing",
        detect: async () => {
          throw new Error("boom")
        },
        load: async () => ({}),
      } satisfies CapabilityMarker,
      {
        name: "ok",
        detect: async () => true,
        load: async () => ({ tools: [{ name: "ok-tool", run: () => undefined }] }),
      } satisfies CapabilityMarker,
    ])
    const result = await applyCapabilities(registry, routeDir)
    expect(result.contributions.map((c) => c.markerName)).toEqual(["ok"])
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]?.markerName).toBe("throwing")
  })

  it("propagates load errors as result errors, not exceptions", async () => {
    const registry = createCapabilityRegistry([
      {
        name: "bad-load",
        detect: async () => true,
        load: async () => {
          throw new Error("load failed")
        },
      } satisfies CapabilityMarker,
    ])
    const result = await applyCapabilities(registry, routeDir)
    expect(result.contributions).toEqual([])
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]?.markerName).toBe("bad-load")
    expect(result.errors[0]?.message).toContain("load failed")
  })
})
