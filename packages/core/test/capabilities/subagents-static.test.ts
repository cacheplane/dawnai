// Static-path behavior of the subagents marker's description lookup: when
// `context.routeDescriptors` is present (the static-modules path) the map is
// authoritative and NO entry-file import ever happens — a route absent from
// the map provably cannot yield a description via import either, since the
// map holds every route whose entry passes isDawnAgent.
import { fileURLToPath } from "node:url"
import { agent } from "@dawn-ai/sdk"
import { describe, expect, it } from "vitest"
import { createSubagentsMarker } from "../../src/capabilities/built-in/subagents.js"
import type { CapabilityMarkerContext } from "../../src/capabilities/types.js"
import { nodeLoadRouteDescription } from "../../src/node-route-description.js"
import type { RouteDefinition, RouteManifest } from "../../src/types.js"

// A REAL, importable entry file default-exporting a DawnAgent WITH a
// description — the honest zero-import probe: if the marker imported it, its
// description would surface.
const describedEntryFile = fileURLToPath(
  new URL("./fixtures/described-agent/index.ts", import.meta.url),
)
const parentRouteDir = "/app/src/app/chat"

function childRoute(entryFile: string): RouteDefinition {
  return {
    entryFile,
    id: "/chat/subagents/helper",
    kind: "agent",
    pathname: "/chat/subagents/helper",
    routeDir: `${parentRouteDir}/subagents/helper`,
    segments: ["chat", "subagents", "helper"],
  }
}

function contextFor(
  route: RouteDefinition,
  routeDescriptors: CapabilityMarkerContext["routeDescriptors"],
): CapabilityMarkerContext {
  return {
    appRoot: "/app",
    descriptor: undefined,
    // The disk-reading loader is ALWAYS supplied here (as the node runtime
    // supplies it), so "no import happened" below is a claim about the
    // marker's own short-circuit, not about a missing seam.
    loadRouteDescription: nodeLoadRouteDescription,
    routeManifest: { appRoot: "/app", routes: [route] } satisfies RouteManifest,
    ...(routeDescriptors !== undefined ? { routeDescriptors } : {}),
  }
}

describe("subagents marker — static routeDescriptors path", () => {
  it("uses the descriptor from routeDescriptors for the description (no import)", async () => {
    // entryFile points at a NONEXISTENT path: only the map can produce this text.
    const route = childRoute("/nonexistent/src/app/chat/subagents/helper/index.ts")
    const child = agent({
      description: "Echoes text back.",
      model: "gpt-5-mini",
      systemPrompt: "You echo.",
    })
    const marker = createSubagentsMarker()
    const contribution = await marker.load(
      parentRouteDir,
      contextFor(route, new Map([[route.id, child]])),
    )
    const rendered = contribution.promptFragment?.render({}) ?? ""
    expect(rendered).toContain("**helper** — Echoes text back.")
  })

  it("map present but id absent ⇒ default text, without attempting the import", async () => {
    // The entryFile is REAL and its default export HAS a description — if the
    // marker fell back to importing it, that description would appear. The
    // default text proves no import happened.
    const route = childRoute(describedEntryFile)
    const marker = createSubagentsMarker()
    const contribution = await marker.load(parentRouteDir, contextFor(route, new Map()))
    const rendered = contribution.promptFragment?.render({}) ?? ""
    expect(rendered).toContain("**helper** — No description provided.")
    expect(rendered).not.toContain("Imported description that must never surface")
  })

  // The edge shape: no static map AND no injected loader. Core itself cannot
  // read the entry file (that needs node:url), so the marker must degrade to
  // the default text rather than throw — composing an agent never fails over a
  // missing description.
  it("no routeDescriptors and no loader ⇒ default text, no throw", async () => {
    const route = childRoute(describedEntryFile)
    const marker = createSubagentsMarker()
    const contribution = await marker.load(parentRouteDir, {
      appRoot: "/app",
      descriptor: undefined,
      routeManifest: { appRoot: "/app", routes: [route] } satisfies RouteManifest,
    })
    const rendered = contribution.promptFragment?.render({}) ?? ""
    expect(rendered).toContain("**helper** — No description provided.")
  })

  it("sanity: without routeDescriptors the dynamic import DOES find the description", async () => {
    // Proves the previous test's probe is live — the import, when allowed,
    // succeeds and yields the fixture's description.
    const route = childRoute(describedEntryFile)
    const marker = createSubagentsMarker()
    const contribution = await marker.load(parentRouteDir, contextFor(route, undefined))
    const rendered = contribution.promptFragment?.render({}) ?? ""
    expect(rendered).toContain(
      "**helper** — Imported description that must never surface on the static path.",
    )
  })
})
