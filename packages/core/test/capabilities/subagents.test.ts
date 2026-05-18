import { describe, expect, it } from "vitest"
import { agent } from "@dawn-ai/sdk"
import type { DawnAgent } from "@dawn-ai/sdk"
import { createSubagentsMarker } from "../../src/capabilities/built-in/subagents.js"
import type { CapabilityMarkerContext } from "../../src/capabilities/types.js"
import type { RouteManifest } from "../../src/types.js"

function manifest(routes: Array<{ id: string; routeDir: string }>): RouteManifest {
  return {
    appRoot: "/app",
    routes: routes.map((r) => ({
      id: r.id,
      pathname: r.id,
      kind: "agent" as const,
      entryFile: `${r.routeDir}/index.ts`,
      routeDir: r.routeDir,
      segments: r.id.split("/").filter(Boolean),
    })),
  }
}

function ctx(routes: Array<{ id: string; routeDir: string }>): CapabilityMarkerContext {
  return { routeManifest: manifest(routes), descriptor: undefined }
}

describe("createSubagentsMarker — convention discovery", () => {
  it("detect returns false when there are no nested subagents", async () => {
    const marker = createSubagentsMarker()
    const context = ctx([{ id: "/leaf", routeDir: "/app/src/app/leaf" }])
    const detected = await marker.detect("/app/src/app/leaf", context)
    expect(detected).toBe(false)
  })

  it("detect returns true when /subagents/* entries exist for this route", async () => {
    const marker = createSubagentsMarker()
    const context = ctx([
      { id: "/coordinator", routeDir: "/app/src/app/coordinator" },
      {
        id: "/coordinator/subagents/research",
        routeDir: "/app/src/app/coordinator/subagents/research",
      },
    ])
    const detected = await marker.detect("/app/src/app/coordinator", context)
    expect(detected).toBe(true)
  })

  it("load contributes a task tool with a zod enum and a # Subagents prompt fragment", async () => {
    const marker = createSubagentsMarker()
    const context = ctx([
      { id: "/coordinator", routeDir: "/app/src/app/coordinator" },
      {
        id: "/coordinator/subagents/research",
        routeDir: "/app/src/app/coordinator/subagents/research",
      },
    ])
    const contribution = await marker.load("/app/src/app/coordinator", context)
    expect(contribution.tools).toBeDefined()
    expect(contribution.tools![0]!.name).toBe("task")
    expect(contribution.promptFragment).toBeDefined()
    const rendered = contribution.promptFragment!.render({})
    expect(rendered).toMatch(/# Subagents/)
    expect(rendered).toMatch(/\bresearch\b/)
  })

  it("load contributes nothing when no subagents are discovered", async () => {
    const marker = createSubagentsMarker()
    const context = ctx([{ id: "/leaf", routeDir: "/app/src/app/leaf" }])
    const contribution = await marker.load("/app/src/app/leaf", context)
    expect(contribution.tools).toBeUndefined()
    expect(contribution.promptFragment).toBeUndefined()
  })

  it("task tool's run throws (dispatcher not wired yet)", async () => {
    const marker = createSubagentsMarker()
    const context = ctx([
      { id: "/coordinator", routeDir: "/app/src/app/coordinator" },
      {
        id: "/coordinator/subagents/research",
        routeDir: "/app/src/app/coordinator/subagents/research",
      },
    ])
    const contribution = await marker.load("/app/src/app/coordinator", context)
    const taskTool = contribution.tools![0]!
    await expect(
      taskTool.run({ subagent: "research", input: "x" }, { signal: new AbortController().signal }),
    ).rejects.toThrow(/dispatcher not wired/i)
  })
})

describe("createSubagentsMarker — descriptor override", () => {
  it("detects subagents from agent({subagents:[...]}) even without a /subagents folder", async () => {
    const shared = agent({
      model: "gpt-5",
      systemPrompt: "shared",
      description: "Shared specialist",
    })
    const parent = agent({
      model: "gpt-5",
      systemPrompt: "parent",
      subagents: [shared],
    })

    const marker = createSubagentsMarker()
    const context: CapabilityMarkerContext = {
      routeManifest: manifest([
        { id: "/parent", routeDir: "/app/src/app/parent" },
        { id: "/shared", routeDir: "/app/src/app/shared" },
      ]),
      descriptor: parent,
      descriptorRouteMap: new Map<DawnAgent, string>([[shared, "/shared"]]),
    }
    const detected = await marker.detect("/app/src/app/parent", context)
    expect(detected).toBe(true)
  })

  it("includes override routes in the task enum and prompt fragment", async () => {
    const shared = agent({
      model: "gpt-5",
      systemPrompt: "shared",
      description: "Shared specialist",
    })
    const parent = agent({
      model: "gpt-5",
      systemPrompt: "parent",
      subagents: [shared],
    })

    const marker = createSubagentsMarker()
    const context: CapabilityMarkerContext = {
      routeManifest: manifest([
        { id: "/parent", routeDir: "/app/src/app/parent" },
        { id: "/shared", routeDir: "/app/src/app/shared" },
      ]),
      descriptor: parent,
      descriptorRouteMap: new Map<DawnAgent, string>([[shared, "/shared"]]),
    }
    const contribution = await marker.load("/app/src/app/parent", context)
    expect(contribution.tools).toBeDefined()
    const rendered = contribution.promptFragment!.render({})
    expect(rendered).toMatch(/shared/)
  })

  it("throws on leaf-name collision between convention and override", async () => {
    const shared = agent({
      model: "gpt-5",
      systemPrompt: "shared",
      description: "Shared",
    })
    const parent = agent({
      model: "gpt-5",
      systemPrompt: "parent",
      subagents: [shared],
    })

    const marker = createSubagentsMarker()
    const context: CapabilityMarkerContext = {
      routeManifest: manifest([
        { id: "/parent", routeDir: "/app/src/app/parent" },
        {
          id: "/parent/subagents/research",
          routeDir: "/app/src/app/parent/subagents/research",
        },
        { id: "/research", routeDir: "/app/src/app/research" }, // same leaf name!
      ]),
      descriptor: parent,
      descriptorRouteMap: new Map<DawnAgent, string>([[shared, "/research"]]),
    }
    await expect(marker.load("/app/src/app/parent", context)).rejects.toThrow(/duplicate.*leaf.*research/i)
  })
})
