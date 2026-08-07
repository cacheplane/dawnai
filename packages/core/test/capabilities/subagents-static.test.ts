import { agent } from "@dawn-ai/sdk"
import { describe, expect, it } from "vitest"
import { createSubagentsMarker } from "../../src/capabilities/built-in/subagents.js"
import type { CapabilityMarkerContext } from "../../src/capabilities/types.js"
import { resolveSubagentRegistry } from "../../src/subagents/registry.js"
import type { RouteDefinition, RouteManifest } from "../../src/types.js"

const parentRouteDir = "/app/src/app/chat"

function childRoute(): RouteDefinition {
  return {
    entryFile: "/nonexistent/src/app/chat/subagents/helper/index.ts",
    id: "/chat/subagents/helper",
    kind: "agent",
    pathname: "/chat/subagents/helper",
    routeDir: `${parentRouteDir}/subagents/helper`,
    segments: ["chat", "subagents", "helper"],
  }
}

function contextFor(
  routeManifest: RouteManifest,
  subagentRegistry: CapabilityMarkerContext["subagentRegistry"],
): CapabilityMarkerContext {
  return {
    appRoot: "/app",
    descriptor: undefined,
    routeManifest,
    ...(subagentRegistry !== undefined ? { subagentRegistry } : {}),
  }
}

describe("subagents marker — pre-resolved static registry", () => {
  it("renders descriptions loaded by the canonical registry resolver", async () => {
    const route = childRoute()
    const routeManifest = {
      appRoot: "/app",
      routes: [route],
    } satisfies RouteManifest
    const registry = await resolveSubagentRegistry({
      descriptor: agent({ model: "gpt-5-mini", systemPrompt: "Parent." }),
      descriptorRouteIndex: new Map(),
      parentRouteDir,
      parentRouteId: "/chat",
      routeManifest,
      loadDescription: async (descriptionRoute) => {
        expect(descriptionRoute).toBe(route)
        return "Echoes text back."
      },
    })

    const marker = createSubagentsMarker()
    const contribution = await marker.load(parentRouteDir, contextFor(routeManifest, registry))
    const rendered = contribution.promptFragment?.render({}) ?? ""

    expect(rendered).toContain("**helper** — Echoes text back.")
    expect(contribution.subagentRegistry).toBe(registry)
  })
})
