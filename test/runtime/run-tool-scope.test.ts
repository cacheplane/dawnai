/**
 * Tool-scoping e2e — proves the composition-seam scope filter end-to-end.
 *
 * The `research` coordinator route dispatches a `researcher` subagent via the
 * `task` tool. The subagent declares `tools: { allow: ["readFile"] }`. We assert
 * the TOOLS OFFERED TO THE MODEL on the subagent's LLM call are exactly
 * ["readFile", "search"]:
 *   - `search`   — authored route-local tool (subagents keep authored tools)
 *   - `readFile` — capability tool, withheld by default for subagents but
 *                  re-granted via the descriptor's allow-list
 *   - `writeFile`/`runBash` — capability tools, withheld (not in allow)
 *   - `task`     — capability tool, withheld (subagents don't dispatch further)
 *
 * This exercises BOTH halves of TS4: the compose-time filter
 * (resolveToolScope/toolOrigin in execute-route.ts) AND the isSubagent plumbing
 * that flags the child run as a subagent.
 *
 * Assertion path: OFFERED-TOOLS (read from the aimock journal's request body
 * `tools` array). We wire the harness internals inline (typegen → registry →
 * aimock → streamResolvedRoute) — exactly what createAgentHarness does — so we
 * retain the aimock handle and can inspect getRequests(). The subagent's LLM
 * request is identified by its RESEARCHER_SUBAGENT_MARKER system prompt.
 */
import { fileURLToPath } from "node:url"

import {
  __resetMaterializedAgentsForTests,
  createRuntimeRegistry,
  runTypegen,
  streamResolvedRoute,
} from "@dawn-ai/cli/runtime"
import { discoverRoutes } from "@dawn-ai/core"
import { type Aimock, collectRunResult, createAimock, script } from "@dawn-ai/testing"
import { afterAll, beforeAll, expect, it } from "vitest"

const appRoot = fileURLToPath(new URL("./fixtures/tool-scope-app", import.meta.url))

let aimock: Aimock
let resolved: { routeFile: string; routeId: string; routePath: string }
let prevBaseUrl: string | undefined
let prevKey: string | undefined

beforeAll(async () => {
  prevBaseUrl = process.env.OPENAI_BASE_URL
  prevKey = process.env.OPENAI_API_KEY

  aimock = await createAimock({ fixtures: [] })
  process.env.OPENAI_BASE_URL = aimock.baseUrl
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "test-not-used"

  // Generate tool schemas (dev-boot fidelity) so the authored `search` tool is
  // offered with a schema, then resolve the top route.
  const manifest = await discoverRoutes({ appRoot })
  await runTypegen({ appRoot, manifest })
  const registry = await createRuntimeRegistry(appRoot)
  const lookup = registry.lookup("/research#agent")
  if (!lookup) throw new Error("tool-scope-app: route /research#agent not found")
  resolved = lookup
}, 120_000)

afterAll(async () => {
  await aimock.close()
  if (prevBaseUrl === undefined) delete process.env.OPENAI_BASE_URL
  else process.env.OPENAI_BASE_URL = prevBaseUrl
  if (prevKey === undefined) delete process.env.OPENAI_API_KEY
  else process.env.OPENAI_API_KEY = prevKey
  __resetMaterializedAgentsForTests()
})

it("subagents are scoped at composition: researcher offered only authored + allowed tools", async () => {
  const parentInput = "research the workspace conventions"
  const childQuestion = "What conventions are documented?"

  // Parent dispatches the researcher subagent; researcher replies. The
  // dispatcher seeds the child's user message with the `input` passed to
  // task(), so the second fixture group matches on childQuestion.
  aimock.addFixtures(
    script()
      .user(parentInput)
      .callsTool("task", { subagent: "researcher", input: childQuestion })
      .replies("Research complete.")
      .user(childQuestion)
      .replies("Conventions: tools are camelCase.")
      .build(),
  )

  const stream = streamResolvedRoute({
    appRoot,
    input: { messages: [{ role: "user", content: parentInput }] },
    routeFile: resolved.routeFile,
    routeId: resolved.routeId,
    routePath: resolved.routePath,
    threadId: `t-tool-scope-${Date.now()}`,
  })
  const result = await collectRunResult(stream, "t-tool-scope")

  // Sanity: the subagent actually ran (proves dispatch happened).
  expect(result.subagents.map((s) => s.name)).toContain("researcher")

  const reqs = aimock.getRequests()
  // Identify the subagent's LLM request by its marker system prompt.
  const subReq = reqs.find((r) =>
    r.body?.messages?.some(
      (m) => m.role === "system" && String(m.content).includes("RESEARCHER_SUBAGENT_MARKER"),
    ),
  )
  expect(subReq).toBeDefined()

  const offered = (subReq?.body?.tools ?? [])
    .map((t) => t.function?.name)
    .filter((n): n is string => Boolean(n))
    .sort()

  expect(offered).toEqual(["readFile", "search"])
  expect(offered).not.toContain("writeFile")
  expect(offered).not.toContain("runBash")
  expect(offered).not.toContain("task")
}, 120_000)
