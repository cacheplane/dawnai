import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { __clearDawnConfigCacheForTests } from "@dawn-ai/core"
import { discoverRoutes } from "@dawn-ai/core/node"
import { __resetMaterializedAgentsForTests } from "@dawn-ai/langchain"
import { matchPermission, type PermissionsStore } from "@dawn-ai/permissions"
import { createThreadsStore, sqliteCheckpointer } from "@dawn-ai/sqlite-storage"
import { afterEach, describe, expect, it } from "vitest"

import { type AimockFixture, createAimock } from "../../testing/dist/index.js"
import {
  edgeAppNamespace,
  emitEdgeModulesFile,
} from "../src/lib/build/targets/edge-modules-emitter.js"
import {
  collectRouteStaticDiscovery,
  emitModulesFile,
  type RouteStaticDiscovery,
} from "../src/lib/build/targets/modules-emitter.js"
import { createRuntimeFetchHandler as createEdgeRuntimeFetchHandler } from "../src/lib/dev/runtime-fetch-core.js"
import { createRuntimeFetchHandler as createNodeRuntimeFetchHandler } from "../src/lib/dev/runtime-fetch-handler.js"
import type { RequestStores } from "../src/lib/dev/runtime-server.js"
import { __resetRouteLoadCachesForTests } from "../src/lib/runtime/execute-route.js"
import { loadStaticModules } from "../src/lib/runtime/static-modules.js"
import { ensureLinkedDistsFresh } from "./helpers/hono-edge-fixture.js"

// ---------------------------------------------------------------------------
// BUNDLED MARKER FILES — the node-versus-edge equivalence proof.
//
// `static-edge-equivalence.test.ts` proves the two manifests serve the same
// conversation. This file proves the same for the three marker FILES the edge
// has no filesystem to read: `skills/*/SKILL.md`, `plan.md` and `memory.md`.
// Their bodies are bundled into `modules.edge.mjs` and served back through
// `staticMarkerFs`, so the only honest check is to drive both manifests
// through their real fetch handlers with a replayed model and compare what the
// agent actually saw: the skills prompt fragment, the `readSkill` body, the
// route memory block, and the todos seeded from `plan.md`.
// ---------------------------------------------------------------------------

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..")
const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

const SKILL_BODY = "Always cite the corpus path in square brackets."
const MEMORY_BODY = "Prefer short answers."

async function fixtureApp(): Promise<string> {
  const appRoot = await realpath(await mkdtemp(join(tmpdir(), "dawn-static-edge-markers-")))
  cleanup.push(() => rm(appRoot, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 }))
  const files: Record<string, string> = {
    "dawn.config.ts": "export default {}\n",
    "package.json": '{ "name": "static-edge-markers-fixture", "type": "module" }\n',
    "src/app/chat/index.ts":
      'import { agent } from "@dawn-ai/sdk"\n' +
      'export default agent({ model: "gpt-5-mini", systemPrompt: "You are helpful." })\n',
    "src/app/chat/memory.md": `${MEMORY_BODY}\n`,
    "src/app/chat/plan.md": "- [ ] Restate the question\n- [ ] Answer it\n",
    "src/app/chat/skills/cite-sources/SKILL.md": `---\ndescription: How to cite.\n---\n\n${SKILL_BODY}\n`,
  }
  for (const [rel, body] of Object.entries(files)) {
    const filePath = join(appRoot, rel)
    await mkdir(join(filePath, ".."), { recursive: true })
    await writeFile(filePath, body, "utf8")
  }
  // The fixture's route imports `@dawn-ai/sdk`, which it resolves through the
  // linked CLI package the same way the edge suites' fixtures do.
  await mkdir(join(appRoot, "node_modules", "@dawn-ai"), { recursive: true })
  await symlink(
    join(repoRoot, "packages", "cli"),
    join(appRoot, "node_modules", "@dawn-ai", "cli"),
    "dir",
  )
  return appRoot
}

function fixtures(): AimockFixture[] {
  return [
    {
      match: { turnIndex: 0, userMessage: "use the skill" },
      response: {
        toolCalls: [{ arguments: { name: "cite-sources" }, id: "call-skill-1", name: "readSkill" }],
      },
    },
    { match: { turnIndex: 1, userMessage: "use the skill" }, response: { content: "Done." } },
  ]
}

async function startAimock() {
  const aimock = await createAimock({ fixtures: [] })
  aimock.addFixtures(fixtures())
  const prevBaseUrl = process.env.OPENAI_BASE_URL
  const prevKey = process.env.OPENAI_API_KEY
  process.env.OPENAI_BASE_URL = aimock.baseUrl
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "test-not-used"
  return {
    /** The system prompt the model saw on the Nth request (default: first).
     * `gpt-5*` models carry it as the `developer` role, not `system`. */
    systemPromptAt: (index = 0) => {
      const entry = aimock.getRequests()[index]?.body?.messages as
        | { role: string; content: string }[]
        | undefined
      return entry?.find((m) => m.role === "system" || m.role === "developer")?.content ?? ""
    },
    stop: async () => {
      await aimock.close()
      if (prevBaseUrl === undefined) delete process.env.OPENAI_BASE_URL
      else process.env.OPENAI_BASE_URL = prevBaseUrl
      if (prevKey === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = prevKey
    },
  }
}

function interactivePermissionsStore(): PermissionsStore {
  const runtimeAllow: Record<string, string[]> = {}
  return {
    addAllow: async (tool, pattern) => {
      const patterns = runtimeAllow[tool] ?? []
      patterns.push(pattern)
      runtimeAllow[tool] = patterns
    },
    load: async () => {},
    match: (tool, candidate) => matchPermission(tool, candidate, runtimeAllow, {}),
    mode: "interactive",
  }
}

/** Fresh sqlite-backed stores per request, over one shared pair of database
 * files — the deployed-worker shape, as `static-edge-equivalence.test.ts` uses. */
async function requestStoresFor(): Promise<(request: Request) => RequestStores> {
  const dbDir = await realpath(await mkdtemp(join(tmpdir(), "dawn-edge-marker-stores-")))
  cleanup.push(() => rm(dbDir, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 }))
  return () => ({
    checkpointer: sqliteCheckpointer({ path: join(dbDir, "checkpoints.sqlite") }),
    dispose: async () => {},
    permissionsStore: interactivePermissionsStore(),
    threadsStore: createThreadsStore({ path: join(dbDir, "threads.sqlite") }),
  })
}

interface Observed {
  readonly systemPrompt: string
  readonly readSkillResult: string
  readonly todos: unknown
}

interface Handler {
  fetch: (request: Request) => Promise<Response>
}

async function drive(handler: Handler, systemPrompt: () => string): Promise<Observed> {
  const post = (path: string, body: unknown) =>
    handler.fetch(
      new Request(`http://localhost${path}`, {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    )
  const created = (await (await post("/threads", {})).json()) as { thread_id: string }
  const turn = await post(`/threads/${encodeURIComponent(created.thread_id)}/runs/wait`, {
    input: { messages: [{ content: "use the skill", role: "user" }] },
    route: "/chat#agent",
  })
  expect(turn.status).toBe(200)
  // Messages come back in LangChain's serialized form: the tool result is a
  // `ToolMessage` whose name and content sit under `kwargs`.
  const turnBody = (await turn.json()) as {
    messages?: { id?: unknown; kwargs?: { name?: string; content?: unknown } }[]
    todos?: unknown
  }
  const toolMessage = turnBody.messages?.find(
    (m) => Array.isArray(m.id) && m.id.includes("ToolMessage") && m.kwargs?.name === "readSkill",
  )

  // The seeded todos live on the checkpointed state, which the run response
  // does not necessarily carry — read them back the way a client would.
  const stateResponse = await handler.fetch(
    new Request(`http://localhost/threads/${encodeURIComponent(created.thread_id)}/state`),
  )
  expect(stateResponse.status).toBe(200)
  const state = (await stateResponse.json()) as { values?: Record<string, unknown> }

  return {
    readSkillResult: String(toolMessage?.kwargs?.content ?? ""),
    systemPrompt: systemPrompt(),
    todos: turnBody.todos ?? state.values?.todos,
  }
}

describe("bundled marker files — node vs edge", () => {
  it("serves the same skills prompt, readSkill body, route memory, and seeded todos", async () => {
    await ensureLinkedDistsFresh()
    const appRoot = await fixtureApp()
    const manifest = await discoverRoutes({ appRoot })
    const buildDir = join(appRoot, ".dawn", "build")
    await mkdir(buildDir, { recursive: true })

    // The node manifest reads its markers off disk; the edge manifest cannot,
    // so `markerFiles: true` bundles their bodies. That flag is the ONLY
    // difference between the two discovery passes.
    const nodeDiscoveries: RouteStaticDiscovery[] = []
    const edgeDiscoveries: RouteStaticDiscovery[] = []
    for (const route of manifest.routes) {
      nodeDiscoveries.push(await collectRouteStaticDiscovery({ appRoot, route }))
      edgeDiscoveries.push(await collectRouteStaticDiscovery({ appRoot, markerFiles: true, route }))
    }
    const nodePath = join(buildDir, "modules.mjs")
    const edgePath = join(buildDir, "modules.edge.mjs")
    await writeFile(
      nodePath,
      emitModulesFile({ appRoot, buildDir, discoveries: nodeDiscoveries }),
      "utf8",
    )
    await writeFile(
      edgePath,
      emitEdgeModulesFile({ appRoot, buildDir, discoveries: edgeDiscoveries }),
      "utf8",
    )

    // ---- Run 1: NODE STATIC (markers read from the real filesystem) --------
    const nodeModules = await loadStaticModules(pathToFileURL(nodePath))
    const nodeAimock = await startAimock()
    const nodeHandler = await createNodeRuntimeFetchHandler({ appRoot, modules: nodeModules })
    let nodeRun: Observed
    try {
      nodeRun = await drive(nodeHandler, nodeAimock.systemPromptAt)
    } finally {
      await nodeHandler.close()
      await nodeAimock.stop()
    }

    __resetRouteLoadCachesForTests()
    __clearDawnConfigCacheForTests()
    __resetMaterializedAgentsForTests()

    // ---- Run 2: EDGE STATIC (markers served from the bundle) ---------------
    const edgeModules = await loadStaticModules(pathToFileURL(edgePath))
    const namespace = edgeAppNamespace(appRoot)
    // It really is the edge manifest: no build-machine path survives in it.
    expect(JSON.stringify(edgeModules.routes)).not.toContain(appRoot)

    const edgeAimock = await startAimock()
    const edgeHandler = await createEdgeRuntimeFetchHandler({
      appRoot: namespace,
      config: {},
      modules: edgeModules,
      requestStores: await requestStoresFor(),
    })
    let edgeRun: Observed
    try {
      edgeRun = await drive(edgeHandler, edgeAimock.systemPromptAt)
    } finally {
      await edgeHandler.close()
      await edgeAimock.stop()
    }

    // The node run proves the fixture exercises every marker — without these
    // the equality below could pass on two equally-empty runs.
    expect(nodeRun.systemPrompt).toContain("# Skills")
    expect(nodeRun.systemPrompt).toContain("- **cite-sources** — How to cite.")
    expect(nodeRun.systemPrompt).toContain("# Route Memory")
    expect(nodeRun.systemPrompt).toContain(MEMORY_BODY)
    expect(nodeRun.readSkillResult).toContain(SKILL_BODY)
    expect(JSON.stringify(nodeRun.todos)).toContain("Restate the question")

    // And the edge run is indistinguishable.
    expect(edgeRun).toEqual(nodeRun)
  }, 120_000)

  it("keeps the bundled marker facade across runs on one edge handler", async () => {
    // The edge markers are served by a `MarkerFs` built over the bundle. A
    // facade built once and then dropped (or a cache that only survives the
    // first route load) would serve run 1 and leave run 2 with no skills at
    // all. The `MarkerFs` instance is not reachable from a test, so this is
    // asserted BEHAVIOURALLY: two independent threads on ONE handler must both
    // see the skills prompt and the same readSkill body.
    await ensureLinkedDistsFresh()
    const appRoot = await fixtureApp()
    const manifest = await discoverRoutes({ appRoot })
    const buildDir = join(appRoot, ".dawn", "build")
    await mkdir(buildDir, { recursive: true })
    const discoveries: RouteStaticDiscovery[] = []
    for (const route of manifest.routes) {
      discoveries.push(await collectRouteStaticDiscovery({ appRoot, markerFiles: true, route }))
    }
    const edgePath = join(buildDir, "modules.edge.mjs")
    await writeFile(edgePath, emitEdgeModulesFile({ appRoot, buildDir, discoveries }), "utf8")

    __resetRouteLoadCachesForTests()
    __clearDawnConfigCacheForTests()
    __resetMaterializedAgentsForTests()

    const edgeModules = await loadStaticModules(pathToFileURL(edgePath))
    const aimock = await startAimock()
    const handler = await createEdgeRuntimeFetchHandler({
      appRoot: edgeAppNamespace(appRoot),
      config: {},
      modules: edgeModules,
      requestStores: await requestStoresFor(),
    })
    try {
      // Two separate threads, same handler — the second must not be degraded.
      const first = await drive(handler, () => aimock.systemPromptAt(0))
      const second = await drive(handler, () => aimock.systemPromptAt(2))

      for (const run of [first, second]) {
        expect(run.systemPrompt).toContain("# Skills")
        expect(run.systemPrompt).toContain("- **cite-sources** — How to cite.")
        expect(run.readSkillResult).toContain(SKILL_BODY)
      }
      expect(second.systemPrompt).toBe(first.systemPrompt)
    } finally {
      await handler.close()
      await aimock.stop()
    }
  }, 120_000)
})
