import type { SandboxProvider } from "@dawn-ai/workspace"
import { describe, expect, it } from "vitest"

import {
  collectRuntimeCapabilityGaps,
  formatRuntimeCapabilityViolations,
  type RuntimeCapabilityInput,
} from "../src/lib/runtime/edge-capability-report.js"

// ---------------------------------------------------------------------------
// THE REQUEST-TIME HALF OF THE EDGE CAPABILITY GATE.
//
// The build gate (`assertEdgeCapabilities`) only runs when the `hono` target
// does, and composing an entry by hand over `@dawn-ai/cli/fetch` is a supported
// way to deploy — so a `sandbox` block can reach a runtime that cannot serve it
// having never been gated. This probe is what stops that being a silent no-op.
//
// It has exactly one dangerous failure mode, and it is not "misses a gap": it
// is FIRING ON A NORMAL NODE APP, where every one of these features absent is a
// documented degrade, not a fault. `hasFilesystemFallback` is the whole defense
// — the "never fires on node" block below is the half of this file that
// protects existing users.
// ---------------------------------------------------------------------------

/** A sandbox provider handle. Never contacted — only its presence is read. */
const stubProvider = {} as SandboxProvider

const EDGE: Pick<RuntimeCapabilityInput, "hasFilesystemFallback" | "hasSandboxManager"> = {
  // The shape an edge runtime has: no node fallback bag.
  hasFilesystemFallback: false,
  hasSandboxManager: false,
}

function gaps(input: Partial<RuntimeCapabilityInput>) {
  return collectRuntimeCapabilityGaps({
    config: undefined,
    ...EDGE,
    routes: [],
    ...input,
  })
}

describe("collectRuntimeCapabilityGaps — fires when a feature is configured but unservable", () => {
  it("names `sandbox` and its config key when no provider could be resolved", () => {
    const found = gaps({ config: { sandbox: { provider: stubProvider } } })

    expect(found).toHaveLength(1)
    expect(found[0]?.capability).toBe("sandbox")
    // The config key, not just the feature: "sandbox is not supported" leaves a
    // user hunting for what turned it on.
    expect(found[0]?.source).toContain("`sandbox` in dawn.config.ts")
  })

  it("names `toolOutput` — offloading has nowhere to spill without a filesystem", () => {
    const found = gaps({ config: { toolOutput: { offloadThresholdChars: 1000 } } })

    expect(found).toHaveLength(1)
    expect(found[0]?.capability).toBe("tool-output offloading")
    expect(found[0]?.source).toContain("`toolOutput` in dawn.config.ts")
  })

  it("names the route's skills when the manifest records names but bundles no bodies", () => {
    // A hand-composed manifest, or one built before marker files were bundled:
    // the skills capability's `detect` would return false and the skills would
    // vanish from the prompt with nothing to report.
    const found = gaps({
      routes: [{ routeId: "/research", skills: ["synthesize-findings", "cite-sources"] }],
    })

    expect(found).toHaveLength(1)
    expect(found[0]?.capability).toContain("skills")
    expect(found[0]?.capability).toContain("cite-sources")
    expect(found[0]?.capability).toContain("synthesize-findings")
    expect(found[0]?.source).toContain("/research")
  })

  it("does not report skills whose bodies the manifest bundles", () => {
    const found = gaps({
      routes: [
        {
          markerFiles: { "/ns/src/app/research/skills/cite-sources/SKILL.md": "…" },
          routeId: "/research",
          skills: ["cite-sources"],
        },
      ],
    })

    expect(found).toEqual([])
  })

  it("still reports a skill whose body is missing even when other marker files are bundled", () => {
    const found = gaps({
      routes: [
        {
          markerFiles: {
            "/ns/src/app/research/plan.md": "- [ ] a\n",
            "/ns/src/app/research/skills/cite-sources/SKILL.md": "…",
          },
          routeId: "/research",
          skills: ["cite-sources", "synthesize-findings"],
        },
      ],
    })

    expect(found).toHaveLength(1)
    expect(found[0]?.capability).toBe("skills (synthesize-findings)")
  })

  it("reports every gap at once, so one deploy teaches the operator all of it", () => {
    const found = gaps({
      config: { sandbox: { provider: stubProvider }, toolOutput: { previewLines: 3 } },
      routes: [{ routeId: "/chat" }, { routeId: "/research", skills: ["cite-sources"] }],
    })

    expect(found.map((violation) => violation.capability)).toEqual([
      "sandbox",
      "tool-output offloading",
      "skills (cite-sources)",
    ])

    // And the report names all three, plus the one global instruction.
    const report = formatRuntimeCapabilityViolations(found)
    expect(report).toContain("3 feature(s)")
    expect(report).toContain("`sandbox` in dawn.config.ts")
    expect(report).toContain("`toolOutput` in dawn.config.ts")
    expect(report).toContain("cite-sources")
    expect(report).toContain('"node" build target')
  })
})

describe("collectRuntimeCapabilityGaps — NEVER fires for an ordinary Node app", () => {
  // This is the block that protects every existing user. A node app that
  // configures a sandbox and tool-output offloading and ships skills is a
  // COMPLETELY NORMAL app — all three work there. A guard that fired on it
  // would be worse than no guard at all.
  it("stays silent with all three configured, because node has the fallback bag", () => {
    const found = collectRuntimeCapabilityGaps({
      config: { sandbox: { provider: stubProvider }, toolOutput: { offloadThresholdChars: 10 } },
      // The one difference from every firing case above.
      hasFilesystemFallback: true,
      // Deliberately false as well: on node a `sandbox` config that resolved no
      // manager (a provider the daemon rejected, a config read that failed) is
      // still not this guard's business — it degrades, as it always has.
      hasSandboxManager: false,
      routes: [{ routeId: "/research", skills: ["cite-sources"] }],
    })

    expect(found).toEqual([])
  })

  it("stays silent for a fallback-less runtime that configured none of them", () => {
    // The ordinary edge app: nothing asked for, nothing to report. Absent
    // config must never be read as a gap, or every worker would 500.
    expect(gaps({ config: {}, routes: [{ routeId: "/chat" }] })).toEqual([])
    expect(gaps({ config: undefined, routes: [{ routeId: "/chat" }] })).toEqual([])
  })

  it("stays silent when the caller injected its own sandboxManager", () => {
    // `sandbox` is configured AND unservable by the runtime's own resolution —
    // but the caller took resolution over, so it is being served.
    expect(
      gaps({ config: { sandbox: { provider: stubProvider } }, hasSandboxManager: true }),
    ).toEqual([])
  })

  it("stays silent for an EMPTY toolOutput object, which configures nothing", () => {
    // The hono target's config stripping drops empty objects for the same
    // reason: `toolOutput: {}` expresses no intent to offload.
    expect(gaps({ config: { toolOutput: {} } })).toEqual([])
  })

  it("stays silent for a route whose skills list is absent or empty", () => {
    expect(gaps({ routes: [{ routeId: "/chat" }] })).toEqual([])
    expect(gaps({ routes: [{ routeId: "/chat", skills: [] }] })).toEqual([])
  })
})
