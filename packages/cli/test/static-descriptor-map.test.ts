import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
  createSubagentsMarker,
  discoverRoutes,
  type RouteDefinition,
  type RouteManifest,
  resolveStateFields,
  toRouteSegments,
} from "@dawn-ai/core"
import { agent } from "@dawn-ai/sdk"
import { afterEach, describe, expect, it } from "vitest"

import { createAimock, script } from "../../testing/dist/index.js"
import { createRuntimeFetchHandler } from "../src/lib/dev/runtime-fetch-handler.js"
import {
  __resetDescriptorRouteMapCacheForTests,
  buildDescriptorMapsFromStaticModules,
  getCachedStaticDescriptorMaps,
} from "../src/lib/runtime/execute-route.js"
import { loadRouteMemory } from "../src/lib/runtime/load-memory.js"
import { normalizeRouteModule } from "../src/lib/runtime/load-route-kind.js"
import { createRouteAssistantId } from "../src/lib/runtime/route-identity.js"
import { discoverStateDefinition } from "../src/lib/runtime/state-discovery.js"
import type { DawnStaticModules, StaticRouteModule } from "../src/lib/runtime/static-modules.js"
import { discoverToolDefinitions } from "../src/lib/runtime/tool-discovery.js"

const cleanup: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

// ---------------------------------------------------------------------------
// Unit: buildDescriptorMapsFromStaticModules — both maps derived from the
// manifest with zero imports, agent routes only, memoized per manifest object.
// ---------------------------------------------------------------------------

function staticRoute(overrides: {
  readonly routeId: string
  readonly entry: unknown
  readonly kind: StaticRouteModule["kind"]
}): StaticRouteModule {
  return {
    assistantId: `${overrides.routeId}#${overrides.kind}`,
    kind: overrides.kind,
    memory: null,
    module: { config: {}, entry: overrides.entry, kind: overrides.kind },
    routeFile: `/app/src/app${overrides.routeId}/index.ts`,
    routeId: overrides.routeId,
    routePath: `src/app${overrides.routeId}/index.ts`,
    stateFields: undefined,
    tools: [],
  }
}

describe("buildDescriptorMapsFromStaticModules", () => {
  it("builds descriptor→routeId and routeId→descriptor maps for agent routes only", () => {
    __resetDescriptorRouteMapCacheForTests()
    const agentA = agent({ model: "gpt-5-mini", systemPrompt: "Agent A." })
    const agentB = agent({ model: "gpt-5-mini", systemPrompt: "Agent B." })
    const workflowEntry = async () => "done"
    const modules: DawnStaticModules = {
      routes: [
        staticRoute({ entry: agentA, kind: "agent", routeId: "/a" }),
        staticRoute({ entry: agentB, kind: "agent", routeId: "/a/subagents/b" }),
        staticRoute({ entry: workflowEntry, kind: "workflow", routeId: "/w" }),
      ],
    }

    const maps = buildDescriptorMapsFromStaticModules(modules)

    expect(maps.descriptorRouteMap.get(agentA)).toBe("/a")
    expect(maps.descriptorRouteMap.get(agentB)).toBe("/a/subagents/b")
    expect(maps.routeDescriptors.get("/a")).toBe(agentA)
    expect(maps.routeDescriptors.get("/a/subagents/b")).toBe(agentB)
    // Non-agent routes are excluded from both maps.
    expect(maps.descriptorRouteMap.size).toBe(2)
    expect(maps.routeDescriptors.size).toBe(2)
    expect(maps.routeDescriptors.has("/w")).toBe(false)
  })

  it("memoizes per manifest object identity, reset by __resetDescriptorRouteMapCacheForTests", () => {
    __resetDescriptorRouteMapCacheForTests()
    const modules: DawnStaticModules = {
      routes: [
        staticRoute({
          entry: agent({ model: "gpt-5-mini", systemPrompt: "Agent A." }),
          kind: "agent",
          routeId: "/a",
        }),
      ],
    }

    const first = getCachedStaticDescriptorMaps(modules)
    expect(getCachedStaticDescriptorMaps(modules)).toBe(first)

    // A different manifest object gets its own maps.
    const other: DawnStaticModules = { routes: [...modules.routes] }
    expect(getCachedStaticDescriptorMaps(other)).not.toBe(first)

    __resetDescriptorRouteMapCacheForTests()
    expect(getCachedStaticDescriptorMaps(modules)).not.toBe(first)
  })
})

// ---------------------------------------------------------------------------
// Unit: the subagents marker resolves child descriptions from
// context.routeDescriptors — no entry-file import. The child entryFile points
// at a nonexistent path, so the dynamic-import fallback could only ever
// produce "No description provided." — seeing the real description proves the
// static path was used.
// ---------------------------------------------------------------------------

describe("subagents marker with routeDescriptors", () => {
  const parentRouteDir = "/nonexistent/src/app/chat"
  const childRoute: RouteDefinition = {
    entryFile: "/nonexistent/src/app/chat/subagents/helper/index.ts",
    id: "/chat/subagents/helper",
    kind: "agent",
    pathname: "/chat/subagents/helper",
    routeDir: "/nonexistent/src/app/chat/subagents/helper",
    segments: toRouteSegments(["chat", "subagents", "helper"]),
  }
  const routeManifest: RouteManifest = { appRoot: "/nonexistent", routes: [childRoute] }

  it("uses the descriptor from routeDescriptors for the description (no import)", async () => {
    const child = agent({
      description: "Echoes text back.",
      model: "gpt-5-mini",
      systemPrompt: "You echo.",
    })
    const marker = createSubagentsMarker()
    const contribution = await marker.load(parentRouteDir, {
      appRoot: "/nonexistent",
      descriptor: undefined,
      routeDescriptors: new Map([[childRoute.id, child]]),
      routeManifest,
    })
    const rendered = contribution.promptFragment?.render({}) ?? ""
    expect(rendered).toContain("**helper** — Echoes text back.")
  })

  it("falls back to the default text when routeDescriptors lacks the id and the import fails", async () => {
    const marker = createSubagentsMarker()
    const contribution = await marker.load(parentRouteDir, {
      appRoot: "/nonexistent",
      descriptor: undefined,
      routeDescriptors: new Map(),
      routeManifest,
    })
    const rendered = contribution.promptFragment?.render({}) ?? ""
    expect(rendered).toContain("**helper** — No description provided.")
  })
})

// ---------------------------------------------------------------------------
// Integration: pruned-source proof for subagent dispatch. The static manifest
// is built from an intact fixture, then every route file path is relocated to
// a pruned root where NO route sources exist (and were never imported — the
// module cache cannot mask a disk read). A turn that dispatches the
// descriptor-override subagent must succeed purely from the manifest: before
// this change the descriptor-route map dynamic-imported every entry file
// (ENOENT → empty map → helper unresolvable → no task tool), failing the run.
// ---------------------------------------------------------------------------

async function subagentFixtureApp(): Promise<string> {
  const appRoot = await mkdtemp(join(tmpdir(), "dawn-static-descriptor-"))
  cleanup.push(() => rm(appRoot, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 }))
  const files: Record<string, string> = {
    "dawn.config.ts": "export default {}\n",
    "package.json": '{ "name": "static-descriptor-fixture", "type": "module" }\n',
    "src/app/chat/index.ts":
      'import { agent } from "@dawn-ai/sdk"\n' +
      'import helper from "../helper/index.js"\n' +
      "export default agent({\n" +
      '  model: "gpt-5-mini",\n' +
      '  systemPrompt: "You coordinate work by dispatching subagents.",\n' +
      "  subagents: [helper],\n" +
      "})\n",
    "src/app/helper/index.ts":
      'import { agent } from "@dawn-ai/sdk"\n' +
      "export default agent({\n" +
      '  description: "Echoes text back verbatim.",\n' +
      '  model: "gpt-5-mini",\n' +
      '  systemPrompt: "You echo whatever the user says.",\n' +
      "})\n",
  }
  for (const [rel, body] of Object.entries(files)) {
    const filePath = join(appRoot, rel)
    await mkdir(join(filePath, ".."), { recursive: true })
    await writeFile(filePath, body, "utf8")
  }
  return appRoot
}

/** Same honest manifest builder as static-route-execution.test.ts — runs the
 * real dynamic loaders once against the intact fixture. */
async function buildStaticModulesForFixture(appRoot: string): Promise<DawnStaticModules> {
  const manifest = await discoverRoutes({ appRoot })

  const routes: StaticRouteModule[] = []
  for (const route of manifest.routes) {
    const routeDir = dirname(route.entryFile)
    const module = await normalizeRouteModule(route.entryFile, appRoot)
    const tools = await discoverToolDefinitions({ appRoot, routeDir })

    let stateFields: StaticRouteModule["stateFields"]
    if (route.kind === "agent") {
      const stateDefinition = await discoverStateDefinition({ routeDir })
      stateFields = stateDefinition
        ? resolveStateFields({
            defaults: stateDefinition.defaults,
            reducerOverrides: stateDefinition.reducerOverrides,
          })
        : undefined
    }

    const memoryFile = join(routeDir, "memory.ts")
    const memory =
      route.kind === "agent" && existsSync(memoryFile) ? await loadRouteMemory(memoryFile) : null

    routes.push({
      assistantId: createRouteAssistantId(route.id, route.kind),
      kind: route.kind,
      memory,
      module,
      routeFile: route.entryFile,
      routeId: route.id,
      routePath: route.entryFile
        .slice(manifest.appRoot.length + 1)
        .split("\\")
        .join("/"),
      stateFields,
      tools,
    })
  }

  return { routes }
}

/** Rewrite every routeFile path from `fromRoot` to `toRoot` — the deploy-
 * elsewhere shape: modules built on one machine, served from another where
 * the sources do not exist (and were never imported into the module cache). */
function relocateModules(
  modules: DawnStaticModules,
  fromRoot: string,
  toRoot: string,
): DawnStaticModules {
  return {
    routes: modules.routes.map((route) => ({
      ...route,
      routeFile: toRoot + route.routeFile.slice(fromRoot.length),
    })),
  }
}

async function withAimock(fixtures: ReturnType<ReturnType<typeof script>["build"]>): Promise<void> {
  const aimock = await createAimock({ fixtures: [] })
  cleanup.push(() => aimock.close())
  const prevBaseUrl = process.env.OPENAI_BASE_URL
  const prevKey = process.env.OPENAI_API_KEY
  process.env.OPENAI_BASE_URL = aimock.baseUrl
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "test-not-used"
  cleanup.push(() => {
    if (prevBaseUrl === undefined) delete process.env.OPENAI_BASE_URL
    else process.env.OPENAI_BASE_URL = prevBaseUrl
    if (prevKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = prevKey
  })
  aimock.addFixtures(fixtures)
}

async function runChatTurn(
  handler: Awaited<ReturnType<typeof createRuntimeFetchHandler>>,
  threadId: string,
  userMessage: string,
): Promise<string> {
  const routeKey = encodeURIComponent("/chat#agent")
  const response = await handler.fetch(
    new Request(`http://localhost/agui/${routeKey}`, {
      body: JSON.stringify({
        context: [],
        forwardedProps: {},
        messages: [{ id: "1", role: "user", content: userMessage }],
        runId: `rn-${threadId}`,
        state: {},
        threadId,
        tools: [],
      }),
      headers: { accept: "text/event-stream", "content-type": "application/json" },
      method: "POST",
    }),
  )
  expect(response.status).toBe(200)
  const reader = response.body?.getReader()
  if (!reader) throw new Error("expected a streaming response body")
  const chunks: string[] = []
  for (;;) {
    const next = await reader.read()
    if (next.done) break
    chunks.push(new TextDecoder().decode(next.value))
  }
  return chunks.join("")
}

describe("subagent dispatch from static modules (pruned-source proof)", () => {
  it("dispatches an override subagent with all route sources deleted", async () => {
    const intactRoot = await subagentFixtureApp()
    const intactModules = await buildStaticModulesForFixture(intactRoot)

    // Sanity: the manifest captured both agent routes.
    expect(intactModules.routes.map((r) => r.assistantId).sort()).toEqual([
      "/chat#agent",
      "/helper#agent",
    ])

    // Pruned root: config + package.json + empty src/app only. Route file
    // paths in the manifest are relocated here, where they do not exist.
    const prunedRoot = await mkdtemp(join(tmpdir(), "dawn-static-descriptor-pruned-"))
    cleanup.push(() =>
      rm(prunedRoot, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 }),
    )
    await writeFile(join(prunedRoot, "dawn.config.ts"), "export default {}\n", "utf8")
    await writeFile(
      join(prunedRoot, "package.json"),
      '{ "name": "static-descriptor-fixture", "type": "module" }\n',
      "utf8",
    )
    await mkdir(join(prunedRoot, "src/app"), { recursive: true })
    const modules = relocateModules(intactModules, intactRoot, prunedRoot)
    expect(existsSync(join(prunedRoot, "src/app/chat"))).toBe(false)
    expect(existsSync(join(prunedRoot, "src/app/helper"))).toBe(false)

    const childInput = "echo hi"
    await withAimock(
      script()
        // Parent: dispatch to the helper subagent, then wrap up.
        .user("ask the helper to echo hi")
        .callsTool("task", { input: childInput, subagent: "helper" })
        .replies("Helper finished.")
        // Child: the dispatcher seeds the child's user message with the task
        // `input` value, so the child fixture matches on that text.
        .user(childInput)
        .replies("hi right back")
        .build(),
    )

    const handler = await createRuntimeFetchHandler({ appRoot: prunedRoot, modules })
    cleanup.push(() => handler.close())

    const body = await runChatTurn(handler, "th-subagent-pruned", "ask the helper to echo hi")
    expect(body).toContain("RUN_STARTED")
    // The child actually ran: its scripted reply surfaces through the parent
    // stream's subagent envelopes, and the parent completed its own turn.
    expect(body).toContain("hi right back")
    expect(body).toContain("Helper finished.")
    expect(body).toContain("RUN_FINISHED")
  }, 30_000)
})
