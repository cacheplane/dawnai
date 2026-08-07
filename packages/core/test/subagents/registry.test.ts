import type { DawnAgent } from "@dawn-ai/sdk"
import { agent } from "@dawn-ai/sdk"
import { describe, expect, it } from "vitest"
import { dispatchableSubagents, resolveSubagentRegistry } from "../../src/subagents/registry.ts"
import type { DescriptorRouteIndex } from "../../src/subagents/types.ts"
import type { RouteDefinition, RouteManifest } from "../../src/types.ts"

const parentRouteDir = "/app/src/app/parent"
const parentRouteId = "/parent"

function route(id: string, routeDir: string): RouteDefinition {
  return {
    id,
    pathname: id,
    kind: "agent",
    entryFile: `${routeDir}/index.ts`,
    routeDir,
    segments: id.split("/").filter(Boolean),
  }
}

function manifest(...routes: RouteDefinition[]): RouteManifest {
  return { appRoot: "/app", routes }
}

function parent(overrides: Record<string, unknown> = {}): DawnAgent {
  return {
    ...agent({ model: "gpt-5-mini", systemPrompt: "Parent." }),
    ...overrides,
  } as DawnAgent
}

function descriptions(route: RouteDefinition): Promise<string> {
  return Promise.resolve(`Description for ${route.id}`)
}

function deferred<T>(): {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

describe("resolveSubagentRegistry", () => {
  it("discovers only immediate convention children", async () => {
    const result = await resolveSubagentRegistry({
      descriptor: parent(),
      descriptorRouteIndex: new Map(),
      parentRouteDir,
      parentRouteId,
      routeManifest: manifest(
        route("/parent/subagents/research", `${parentRouteDir}/subagents/research`),
        route("/parent/subagents/team/research", `${parentRouteDir}/subagents/team/research`),
        route("/other/subagents/writer", "/app/src/app/other/subagents/writer"),
      ),
      loadDescription: descriptions,
    })

    expect(result).toEqual([
      {
        description: "Description for /parent/subagents/research",
        name: "research",
        routeId: "/parent/subagents/research",
        source: "convention",
        rule: { action: "allow" },
      },
    ])
  })

  it("discovers only immediate convention children from Windows-style paths", async () => {
    const windowsParentRouteDir = String.raw`C:\app\src\app\parent`
    const result = await resolveSubagentRegistry({
      descriptor: parent(),
      descriptorRouteIndex: new Map(),
      parentRouteDir: windowsParentRouteDir,
      parentRouteId,
      routeManifest: manifest(
        route(
          "/parent/subagents/Research_1",
          String.raw`C:\app\src\app\parent\subagents\Research_1`,
        ),
        route(
          "/parent/subagents/team/research",
          String.raw`C:\app\src\app\parent\subagents\team\research`,
        ),
        route("/other/subagents/writer", String.raw`C:\app\src\app\other\subagents\writer`),
      ),
      loadDescription: descriptions,
    })

    expect(result.map(({ name }) => name)).toEqual(["Research_1"])
  })

  it("discovers only immediate convention children from UNC paths", async () => {
    const uncParentRouteDir = String.raw`\\server\share\app\src\app\parent`
    const result = await resolveSubagentRegistry({
      descriptor: parent(),
      descriptorRouteIndex: new Map(),
      parentRouteDir: uncParentRouteDir,
      parentRouteId,
      routeManifest: manifest(
        route(
          "/parent/subagents/research",
          String.raw`\\server\share\app\src\app\parent\subagents\research`,
        ),
        route(
          "/parent/subagents/team/writer",
          String.raw`\\server\share\app\src\app\parent\subagents\team\writer`,
        ),
        route(
          "/other/subagents/imposter",
          String.raw`\\server\share\app\src\app\other\subagents\imposter`,
        ),
      ),
      loadDescription: descriptions,
    })

    expect(result.map(({ name }) => name)).toEqual(["research"])
  })

  it("keeps POSIX semantics when the parent contains a literal backslash", async () => {
    const posixParentRouteDir = String.raw`/app/src/app/parent\literal`
    const result = await resolveSubagentRegistry({
      descriptor: parent(),
      descriptorRouteIndex: new Map(),
      parentRouteDir: posixParentRouteDir,
      parentRouteId,
      routeManifest: manifest(
        route("/parent/subagents/real", `${posixParentRouteDir}/subagents/real`),
        route("/unrelated/subagents/imposter", "/app/src/app/parent/literal/subagents/imposter"),
      ),
      loadDescription: descriptions,
    })

    expect(result.map(({ name }) => name)).toEqual(["real"])
  })

  it("defaults convention and explicit registrations to allow when delegation is omitted", async () => {
    const researcher = agent({ model: "gpt-5-mini", systemPrompt: "Research." })
    const result = await resolveSubagentRegistry({
      descriptor: parent({ subagents: { analyst: researcher } }),
      descriptorRouteIndex: new Map([[researcher, ["/shared/research"]]]),
      parentRouteDir,
      parentRouteId,
      routeManifest: manifest(
        route("/parent/subagents/writer", `${parentRouteDir}/subagents/writer`),
        route("/shared/research", "/app/src/app/shared/research"),
      ),
      loadDescription: descriptions,
    })

    expect(result.map(({ name, rule }) => ({ name, rule }))).toEqual([
      { name: "analyst", rule: { action: "allow" } },
      { name: "writer", rule: { action: "allow" } },
    ])
  })

  it.each(["deny", "approve"] as const)(
    "applies the %s default to convention and unruled explicit registrations",
    async (action) => {
      const researcher = agent({ model: "gpt-5-mini", systemPrompt: "Research." })
      const result = await resolveSubagentRegistry({
        descriptor: parent({
          subagents: { analyst: researcher },
          delegation: { default: action },
        }),
        descriptorRouteIndex: new Map([[researcher, ["/shared/research"]]]),
        parentRouteDir,
        parentRouteId,
        routeManifest: manifest(
          route("/parent/subagents/writer", `${parentRouteDir}/subagents/writer`),
          route("/shared/research", "/app/src/app/shared/research"),
        ),
        loadDescription: descriptions,
      })

      expect(result.map(({ rule }) => rule)).toEqual([{ action }, { action }])
    },
  )

  it("uses explicit aliases and replaces the route's convention identity", async () => {
    const researcher = agent({ model: "gpt-5-mini", systemPrompt: "Research." })
    const index: DescriptorRouteIndex = new Map([[researcher, ["/parent/subagents/research"]]])
    const result = await resolveSubagentRegistry({
      descriptor: agent({
        model: "gpt-5-mini",
        systemPrompt: "Parent.",
        subagents: { analyst: researcher },
        delegation: { default: "deny", rules: { analyst: { action: "allow" } } },
      }),
      descriptorRouteIndex: index,
      parentRouteDir,
      parentRouteId,
      routeManifest: manifest(
        route("/parent/subagents/research", `${parentRouteDir}/subagents/research`),
      ),
      loadDescription: async () => "Research deeply.",
    })

    expect(result).toEqual([
      {
        description: "Research deeply.",
        name: "analyst",
        routeId: "/parent/subagents/research",
        source: "explicit",
        rule: { action: "allow" },
      },
    ])
    expect(result.some(({ name }) => name === "research")).toBe(false)
  })

  it("keeps denied entries canonical and filters them from dispatchable entries", async () => {
    const researcher = agent({ model: "gpt-5-mini", systemPrompt: "Research." })
    const result = await resolveSubagentRegistry({
      descriptor: parent({
        subagents: { analyst: researcher },
        delegation: {
          rules: { analyst: { action: "deny", reason: "Not from this route." } },
        },
      }),
      descriptorRouteIndex: new Map([[researcher, ["/shared/research"]]]),
      parentRouteDir,
      parentRouteId,
      routeManifest: manifest(route("/shared/research", "/app/src/app/shared/research")),
      loadDescription: descriptions,
    })

    expect(result).toHaveLength(1)
    expect(result[0]?.rule).toEqual({ action: "deny", reason: "Not from this route." })
    expect(dispatchableSubagents(result)).toEqual([])
  })

  it("sorts the canonical result by model-facing name", async () => {
    const alpha = agent({ model: "gpt-5-mini", systemPrompt: "Alpha." })
    const zulu = agent({ model: "gpt-5-mini", systemPrompt: "Zulu." })
    const result = await resolveSubagentRegistry({
      descriptor: parent({ subagents: { zulu, alpha } }),
      descriptorRouteIndex: new Map([
        [zulu, ["/zulu"]],
        [alpha, ["/alpha"]],
      ]),
      parentRouteDir,
      parentRouteId,
      routeManifest: manifest(
        route("/parent/subagents/middle", `${parentRouteDir}/subagents/middle`),
        route("/zulu", "/app/src/app/zulu"),
        route("/alpha", "/app/src/app/alpha"),
      ),
      loadDescription: descriptions,
    })

    expect(result.map(({ name }) => name)).toEqual(["alpha", "middle", "zulu"])
  })

  it("starts all description loads before waiting for any result", async () => {
    const alphaDescription = deferred<string>()
    const zuluDescription = deferred<string>()
    const pendingDescriptions = new Map([
      ["/parent/subagents/alpha", alphaDescription],
      ["/parent/subagents/zulu", zuluDescription],
    ])
    const started: string[] = []
    const resolving = resolveSubagentRegistry({
      descriptor: parent(),
      descriptorRouteIndex: new Map(),
      parentRouteDir,
      parentRouteId,
      routeManifest: manifest(
        route("/parent/subagents/zulu", `${parentRouteDir}/subagents/zulu`),
        route("/parent/subagents/alpha", `${parentRouteDir}/subagents/alpha`),
      ),
      loadDescription: (descriptionRoute) => {
        started.push(descriptionRoute.id)
        const pending = pendingDescriptions.get(descriptionRoute.id)
        if (pending === undefined) throw new Error(`Unexpected route ${descriptionRoute.id}`)
        return pending.promise
      },
    })

    try {
      expect(started).toEqual(["/parent/subagents/alpha", "/parent/subagents/zulu"])
    } finally {
      alphaDescription.resolve("Alpha description.")
      zuluDescription.resolve("Zulu description.")
    }

    const result = await resolving
    expect(result.map(({ name, description }) => ({ name, description }))).toEqual([
      { name: "alpha", description: "Alpha description." },
      { name: "zulu", description: "Zulu description." },
    ])
  })

  it.each(["bad name", "_hidden", "-dash", "slash/name"])(
    "rejects invalid explicit name %s",
    async (name) => {
      const researcher = agent({ model: "gpt-5-mini", systemPrompt: "Research." })
      await expect(
        resolveSubagentRegistry({
          descriptor: parent({ subagents: { [name]: researcher } }),
          descriptorRouteIndex: new Map([[researcher, ["/research"]]]),
          parentRouteDir,
          parentRouteId,
          routeManifest: manifest(route("/research", "/app/src/app/research")),
          loadDescription: descriptions,
        }),
      ).rejects.toThrow(/\[DAWN_E1004\].*\/parent.*name/i)
    },
  )

  it("rejects invalid convention names", async () => {
    await expect(
      resolveSubagentRegistry({
        descriptor: parent(),
        descriptorRouteIndex: new Map(),
        parentRouteDir,
        parentRouteId,
        routeManifest: manifest(
          route("/parent/subagents/bad.name", `${parentRouteDir}/subagents/bad.name`),
        ),
        loadDescription: descriptions,
      }),
    ).rejects.toThrow(/\[DAWN_E1004\].*\/parent.*bad\.name/i)
  })

  it("rejects named rules for convention-only names and lists explicit names", async () => {
    const researcher = agent({ model: "gpt-5-mini", systemPrompt: "Research." })
    await expect(
      resolveSubagentRegistry({
        descriptor: parent({
          subagents: { analyst: researcher },
          delegation: { rules: { writer: { action: "deny" } } },
        }),
        descriptorRouteIndex: new Map([[researcher, ["/research"]]]),
        parentRouteDir,
        parentRouteId,
        routeManifest: manifest(
          route("/parent/subagents/writer", `${parentRouteDir}/subagents/writer`),
          route("/research", "/app/src/app/research"),
        ),
        loadDescription: descriptions,
      }),
    ).rejects.toThrow(
      /\[DAWN_E1004\].*\/parent.*unknown rule.*writer.*available explicit names: analyst/i,
    )
  })

  it("rejects an explicit descriptor that resolves to no route", async () => {
    const researcher = agent({ model: "gpt-5-mini", systemPrompt: "Research." })
    await expect(
      resolveSubagentRegistry({
        descriptor: parent({ subagents: { analyst: researcher } }),
        descriptorRouteIndex: new Map(),
        parentRouteDir,
        parentRouteId,
        routeManifest: manifest(),
        loadDescription: descriptions,
      }),
    ).rejects.toThrow(/\[DAWN_E1004\].*\/parent.*analyst.*no route/i)
  })

  it("rejects an explicit descriptor with ambiguous candidate routes", async () => {
    const researcher = agent({ model: "gpt-5-mini", systemPrompt: "Research." })
    await expect(
      resolveSubagentRegistry({
        descriptor: parent({ subagents: { analyst: researcher } }),
        descriptorRouteIndex: new Map([[researcher, ["/research-a", "/research-b"]]]),
        parentRouteDir,
        parentRouteId,
        routeManifest: manifest(),
        loadDescription: descriptions,
      }),
    ).rejects.toThrow(/\[DAWN_E1004\].*\/parent.*analyst.*ambiguous.*\/research-a.*\/research-b/i)
  })

  it("rejects an index route that is absent from the manifest", async () => {
    const researcher = agent({ model: "gpt-5-mini", systemPrompt: "Research." })
    await expect(
      resolveSubagentRegistry({
        descriptor: parent({ subagents: { analyst: researcher } }),
        descriptorRouteIndex: new Map([[researcher, ["/missing"]]]),
        parentRouteDir,
        parentRouteId,
        routeManifest: manifest(),
        loadDescription: descriptions,
      }),
    ).rejects.toThrow(/\[DAWN_E1004\].*\/parent.*analyst.*\/missing.*manifest/i)
  })

  it("rejects duplicate explicit keys pointing to the same route", async () => {
    const researcher = agent({ model: "gpt-5-mini", systemPrompt: "Research." })
    await expect(
      resolveSubagentRegistry({
        descriptor: parent({ subagents: { analyst: researcher, investigator: researcher } }),
        descriptorRouteIndex: new Map([[researcher, ["/research"]]]),
        parentRouteDir,
        parentRouteId,
        routeManifest: manifest(route("/research", "/app/src/app/research")),
        loadDescription: descriptions,
      }),
    ).rejects.toThrow(
      /\[DAWN_E1004\].*\/parent.*\/research.*analyst.*investigator|\[DAWN_E1004\].*\/parent.*\/research.*investigator.*analyst/i,
    )
  })

  it("rejects model-facing name collisions remaining after convention replacement", async () => {
    const researcher = agent({ model: "gpt-5-mini", systemPrompt: "Research." })
    await expect(
      resolveSubagentRegistry({
        descriptor: parent({ subagents: { research: researcher } }),
        descriptorRouteIndex: new Map([[researcher, ["/shared/research"]]]),
        parentRouteDir,
        parentRouteId,
        routeManifest: manifest(
          route("/parent/subagents/research", `${parentRouteDir}/subagents/research`),
          route("/shared/research", "/app/src/app/shared/research"),
        ),
        loadDescription: descriptions,
      }),
    ).rejects.toThrow(/\[DAWN_E1004\].*\/parent.*collision.*research/i)
  })

  it.each([
    ["subagents array", { subagents: [] }],
    ["null subagents", { subagents: null }],
    ["non-agent registration", { subagents: { analyst: "researcher" } }],
    ["null delegation", { delegation: null }],
    ["delegation array", { delegation: [] }],
    ["invalid default", { delegation: { default: "sometimes" } }],
    ["bigint default", { delegation: { default: 1n } }],
    ["null rules", { delegation: { rules: null } }],
    ["rules array", { delegation: { rules: [] } }],
    [
      "null rule",
      {
        subagents: { analyst: agent({ model: "gpt-5-mini", systemPrompt: "A" }) },
        delegation: { rules: { analyst: null } },
      },
    ],
    [
      "invalid action",
      {
        subagents: { analyst: agent({ model: "gpt-5-mini", systemPrompt: "A" }) },
        delegation: { rules: { analyst: { action: "sometimes" } } },
      },
    ],
    [
      "bigint action",
      {
        subagents: { analyst: agent({ model: "gpt-5-mini", systemPrompt: "A" }) },
        delegation: { rules: { analyst: { action: 1n } } },
      },
    ],
    [
      "invalid reason",
      {
        subagents: { analyst: agent({ model: "gpt-5-mini", systemPrompt: "A" }) },
        delegation: { rules: { analyst: { action: "deny", reason: 42 } } },
      },
    ],
    [
      "missing predicate",
      {
        subagents: { analyst: agent({ model: "gpt-5-mini", systemPrompt: "A" }) },
        delegation: { rules: { analyst: { action: "constrain" } } },
      },
    ],
    [
      "invalid predicate",
      {
        subagents: { analyst: agent({ model: "gpt-5-mini", systemPrompt: "A" }) },
        delegation: { rules: { analyst: { action: "constrain", predicate: "no" } } },
      },
    ],
    [
      "predicate on deny",
      {
        subagents: { analyst: agent({ model: "gpt-5-mini", systemPrompt: "A" }) },
        delegation: { rules: { analyst: { action: "deny", predicate: () => true } } },
      },
    ],
    [
      "reason on allow",
      {
        subagents: { analyst: agent({ model: "gpt-5-mini", systemPrompt: "A" }) },
        delegation: { rules: { analyst: { action: "allow", reason: "no" } } },
      },
    ],
  ] as const)("fails closed for malformed untyped %s", async (_label, overrides) => {
    await expect(
      resolveSubagentRegistry({
        descriptor: parent(overrides),
        descriptorRouteIndex: new Map(),
        parentRouteDir,
        parentRouteId,
        routeManifest: manifest(),
        loadDescription: descriptions,
      }),
    ).rejects.toThrow(/\[DAWN_E1004\].*\/parent/i)
  })

  it("falls back only when loading a valid route description fails", async () => {
    const result = await resolveSubagentRegistry({
      descriptor: parent(),
      descriptorRouteIndex: new Map(),
      parentRouteDir,
      parentRouteId,
      routeManifest: manifest(
        route("/parent/subagents/research", `${parentRouteDir}/subagents/research`),
      ),
      loadDescription: async () => {
        throw new Error("module load failed")
      },
    })

    expect(result[0]?.description).toBe("No description provided.")
  })
})
