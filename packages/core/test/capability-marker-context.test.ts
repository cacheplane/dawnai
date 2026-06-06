import { describe, expect, it } from "vitest"
import type { CapabilityMarker, CapabilityMarkerContext } from "../src/capabilities/types.js"
import { applyCapabilities, createCapabilityRegistry } from "../src/index.js"

describe("CapabilityMarkerContext is threaded into detect() and load()", () => {
  it("passes the routes manifest and descriptor to both phases", async () => {
    let seenDetectContext: CapabilityMarkerContext | undefined
    let seenLoadContext: CapabilityMarkerContext | undefined
    const marker: CapabilityMarker = {
      name: "test-marker",
      detect: async (_routeDir, context) => {
        seenDetectContext = context
        return true
      },
      load: async (_routeDir, context) => {
        seenLoadContext = context
        return {}
      },
    }
    const registry = createCapabilityRegistry([marker])
    const fakeContext: CapabilityMarkerContext = {
      routeManifest: { appRoot: "/tmp", routes: [] },
      descriptor: undefined,
      appRoot: "/tmp",
    }
    await applyCapabilities(registry, "/tmp/route", fakeContext)
    expect(seenDetectContext).toEqual(fakeContext)
    expect(seenLoadContext).toEqual(fakeContext)
  })
})
