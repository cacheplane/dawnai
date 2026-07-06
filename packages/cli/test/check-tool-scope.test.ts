import { expect, test } from "vitest"

import { collectToolScopeIssues } from "../src/lib/runtime/collect-tool-scope-errors.js"

const manifest = {
  appRoot: "/app",
  routes: [
    {
      kind: "agent",
      pathname: "/research",
      entryFile: "/app/src/app/research/index.ts",
      routeDir: "/app/src/app/research",
    },
  ],
} as never

test("flags an unknown tool name in a route's scope", async () => {
  const result = await collectToolScopeIssues(manifest, {
    loadScope: async () => ({ allow: ["serch"] }),
    routeLocalToolNames: async () => ["search"],
  })
  expect(result.errors.join("\n")).toMatch(/\/research.*unknown tool.*serch/s)
})

test("accepts a built-in capability tool name", async () => {
  const result = await collectToolScopeIssues(manifest, {
    loadScope: async () => ({ allow: ["readFile"] }),
    routeLocalToolNames: async () => ["search"],
  })
  expect(result.errors).toEqual([])
})

test("ignores routes with no scope", async () => {
  const result = await collectToolScopeIssues(manifest, {
    loadScope: async () => undefined,
    routeLocalToolNames: async () => ["search"],
  })
  expect(result.errors).toEqual([])
})

test("flags an unknown tool name in approve", async () => {
  const result = await collectToolScopeIssues(manifest, {
    loadScope: async () => ({ approve: ["deployPord"] }),
    routeLocalToolNames: async () => ["deployProd"],
  })
  expect(result.errors.join("\n")).toMatch(/\/research.*unknown tool.*deployPord/s)
})

test("warns when approve names an internally-gated workspace tool", async () => {
  const result = await collectToolScopeIssues(manifest, {
    loadScope: async () => ({ approve: ["runBash"] }),
    routeLocalToolNames: async () => [],
  })
  expect(result.errors).toEqual([])
  expect(result.warnings.join("\n")).toMatch(/\/research.*runBash.*already gated/s)
})

test("warns when approve intersects deny (dead entry)", async () => {
  const result = await collectToolScopeIssues(manifest, {
    loadScope: async () => ({ deny: ["deployProd"], approve: ["deployProd"] }),
    routeLocalToolNames: async () => ["deployProd"],
  })
  expect(result.errors).toEqual([])
  expect(result.warnings.join("\n")).toMatch(/\/research.*deployProd.*deny/s)
})

test("warns that approve on task has no effect", async () => {
  const result = await collectToolScopeIssues(manifest, {
    loadScope: async () => ({ approve: ["task"] }),
    routeLocalToolNames: async () => [],
  })
  expect(result.errors).toEqual([])
  expect(result.warnings.join("\n")).toMatch(/\/research.*task.*no effect/s)
})

test("clean approve produces no issues", async () => {
  const result = await collectToolScopeIssues(manifest, {
    loadScope: async () => ({ approve: ["deployProd"] }),
    routeLocalToolNames: async () => ["deployProd"],
  })
  expect(result.errors).toEqual([])
  expect(result.warnings).toEqual([])
})

const subagentManifest = {
  appRoot: "/app",
  routes: [
    {
      kind: "agent",
      pathname: "/research/subagents/researcher",
      entryFile: "/app/src/app/research/subagents/researcher/index.ts",
      routeDir: "/app/src/app/research/subagents/researcher",
    },
  ],
} as never

test("warns when a subagent route approves a withheld capability tool", async () => {
  const result = await collectToolScopeIssues(subagentManifest, {
    loadScope: async () => ({ approve: ["writeTodos"] }),
    routeLocalToolNames: async () => [],
  })
  expect(result.errors).toEqual([])
  expect(result.warnings.join("\n")).toMatch(
    /\/research\/subagents\/researcher.*writeTodos.*withhold capability tools/s,
  )
})

test("does not warn when a subagent route both allows and approves a capability tool", async () => {
  const result = await collectToolScopeIssues(subagentManifest, {
    loadScope: async () => ({ allow: ["writeTodos"], approve: ["writeTodos"] }),
    routeLocalToolNames: async () => [],
  })
  expect(result.errors).toEqual([])
  expect(result.warnings).toEqual([])
})

test("subagent approving task draws ONLY the no-effect warning", async () => {
  // The withheld-capability warning's "add it to allow" advice would
  // contradict the task warning's "has no effect regardless".
  const result = await collectToolScopeIssues(subagentManifest, {
    loadScope: async () => ({ approve: ["task"] }),
    routeLocalToolNames: async () => [],
  })
  expect(result.errors).toEqual([])
  expect(result.warnings).toHaveLength(1)
  expect(result.warnings[0]).toMatch(/no effect/)
})

test("subagent approving an internally-gated tool draws ONLY the already-gated warning", async () => {
  // Warning 1 (redundant, already gated) and the subagent-withheld warning must
  // not co-fire with contradictory advice: "add it to allow" is wrong for a
  // tool whose approve entry is redundant either way.
  const result = await collectToolScopeIssues(subagentManifest, {
    loadScope: async () => ({ approve: ["runBash"] }),
    routeLocalToolNames: async () => [],
  })
  expect(result.errors).toEqual([])
  expect(result.warnings).toHaveLength(1)
  expect(result.warnings[0]).toMatch(/already gated/)
})
