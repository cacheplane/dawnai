import { describe, expect, it } from "vitest"
import { createSubagentsMarker } from "../../src/capabilities/built-in/subagents.js"
import type { CapabilityMarkerContext } from "../../src/capabilities/types.js"
import type { ResolvedSubagent } from "../../src/subagents/types.js"

const predicate = () => true as const

const registry: readonly ResolvedSubagent[] = [
  {
    name: "zulu",
    routeId: "/zulu",
    source: "explicit",
    description: "Requires approval.",
    rule: { action: "approve", reason: "Review first." },
  },
  {
    name: "denied",
    routeId: "/denied",
    source: "convention",
    description: "Never exposed.",
    rule: { action: "deny", reason: "Disabled." },
  },
  {
    name: "alpha",
    routeId: "/alpha",
    source: "explicit",
    description: "Checks constraints.",
    rule: { action: "constrain", predicate },
  },
  {
    name: "middle",
    routeId: "/middle",
    source: "convention",
    description: "Always available.",
    rule: { action: "allow" },
  },
]

function context(subagentRegistry?: readonly ResolvedSubagent[]): CapabilityMarkerContext {
  return {
    routeManifest: { appRoot: "/app", routes: [] },
    descriptor: undefined,
    appRoot: "/app",
    ...(subagentRegistry !== undefined ? { subagentRegistry } : {}),
  }
}

describe("createSubagentsMarker", () => {
  it("detects only a supplied non-empty canonical registry", async () => {
    const marker = createSubagentsMarker()

    await expect(marker.detect("/unused", context())).resolves.toBe(false)
    await expect(marker.detect("/unused", context([]))).resolves.toBe(false)
    await expect(marker.detect("/unused", context(registry))).resolves.toBe(true)
  })

  it("exposes allow, approve, and constrain entries in sorted enum and prompt order", async () => {
    const marker = createSubagentsMarker()
    const contribution = await marker.load("/unused", context(registry))
    const task = contribution.tools?.[0]
    const schema = task?.schema as {
      readonly shape: { readonly subagent: { readonly options: readonly string[] } }
      safeParse(value: unknown): { readonly success: boolean }
    }

    expect(contribution.subagentRegistry).toBe(registry)
    expect(task?.name).toBe("task")
    expect(schema.shape.subagent.options).toEqual(["alpha", "middle", "zulu"])
    expect(schema.safeParse({ subagent: "denied", input: "x" }).success).toBe(false)
    expect(schema.safeParse({ subagent: "alpha", input: "x" }).success).toBe(true)

    const prompt = contribution.promptFragment?.render({}) ?? ""
    expect(prompt).toContain("# Subagents")
    expect(prompt).toContain("**alpha** — Checks constraints.")
    expect(prompt).toContain("**middle** — Always available.")
    expect(prompt).toContain("**zulu** — Requires approval.")
    expect(prompt).not.toContain("denied")
    expect(prompt.indexOf("**alpha**")).toBeLessThan(prompt.indexOf("**middle**"))
    expect(prompt.indexOf("**middle**")).toBeLessThan(prompt.indexOf("**zulu**"))
  })

  it("preserves an all-deny registry without contributing a tool or prompt", async () => {
    const marker = createSubagentsMarker()
    const denied = registry.filter(({ rule }) => rule.action === "deny")
    const contribution = await marker.load("/unused", context(denied))

    expect(contribution.subagentRegistry).toBe(denied)
    expect(contribution.tools).toBeUndefined()
    expect(contribution.promptFragment).toBeUndefined()
  })

  it("keeps the placeholder task failure until a runtime bridge is wired", async () => {
    const marker = createSubagentsMarker()
    const contribution = await marker.load("/unused", context(registry))
    const task = contribution.tools?.[0]

    await expect(
      task?.run({ subagent: "alpha", input: "x" }, { signal: new AbortController().signal }),
    ).rejects.toThrow(/dispatcher not wired/i)
  })
})
