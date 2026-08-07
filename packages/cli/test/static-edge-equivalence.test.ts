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
import { collectEdgeCapabilityViolations } from "../src/lib/build/targets/edge-capabilities.js"
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
import { inMemoryFilesystem } from "./helpers/fetch-entry-fixture.js"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..")

const cleanup: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

// ---------------------------------------------------------------------------
// THE EDGE EQUIVALENCE E2E — the core proof of the `hono` target.
//
// `static-equivalence.test.ts` proved the NODE static manifest serves the same
// conversation as filesystem discovery. This proves the EDGE wiring serves the
// same conversation as that node static manifest — i.e. that the three lines
// `emitEdgeModulesFile` changes, plus the per-request store seam, cost nothing
// behaviorally.
//
// One fixture app, one identical multi-turn conversation, driven twice:
//
//   run 1 (node static): modules.mjs (emitModulesFile) → loadStaticModules →
//     the node handler, whose stores resolve from disk at boot exactly as
//     `dawn start` resolves them;
//   run 2 (edge static): modules.edge.mjs (emitEdgeModulesFile) →
//     loadStaticModules → the CORE handler (no node boot fallbacks), the
//     `/<app-dir>` namespace as appRoot, an inlined config, and stores built
//     PER REQUEST via `requestStores` and disposed when each request settles.
//
// Exactly three things differ between the runs, and they are the three that
// define an edge deploy: which emitter wrote the manifest, where the stores
// come from, and the client-chosen AG-UI thread id (the runs share one app, so
// reusing it would replay onto run 1's checkpointed history). Everything else —
// the fixture, the aimock script, the request sequence — is the same object
// graph, and the transcripts must match after normalizing only volatile ids.
//
// …with ONE forced fourth difference, which is a finding rather than a choice.
// `prepareRouteExecution` builds `createWorkspaceFs` EAGERLY for every route
// execution, so with no boot fallbacks and no `backends.filesystem` in config
// it throws "workspace filesystem backend: no instance provided and this
// runtime has no filesystem fallback" — a 500 on every agent turn. The emitted
// `app.mjs` inlines only the JSON-serializable half of `dawn.config.ts` and
// `assertEdgeCapabilities` REJECTS `backends.filesystem` (a live object cannot
// cross a build boundary), so a deployed worker cannot supply one either. The
// design spec says it should not have to: "createWorkspaceFs's
// localFilesystem() default … become[s] lazy (constructed only when a consuming
// capability/tool is active)" and "with no filesystem backend (edge), markers
// detect-false / render-empty cleanly". Until that lands, run 2 injects an
// in-memory backend the generated entry has no way to inject — and the test
// asserts that the gap is STILL a gap, so the workaround is deleted rather than
// inherited once the runtime goes lazy.
//
// NOTE ON DUPLICATION: the conversation driver, the SSE parser and the
// normalizer below are deliberate copies of `static-equivalence.test.ts`'s.
// Extracting them into a shared helper would mean editing that file, which is
// inherited from `main` and is the guard for a different (shipped) claim; a
// refactor of it is not in this PR's blast radius. The copies are marked, and
// the two suites are meant to stay line-for-line comparable.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Fixture app
//
// `static-equivalence.test.ts`'s fixture MINUS `src/app/chat/memory.ts`: route
// memory is gated OFF the `hono` target (`edge-capabilities.ts` — the emitted
// `stores.mjs` supplies no memory store, so the first `recall` would 500), so
// an app carrying it could not be deployed to the edge at all and comparing
// against it would prove nothing about a real deploy. The test asserts that
// gate agrees, below, rather than trusting this comment to stay true.
//
// Everything else is kept precisely because it is the full static-manifest
// input surface: an agent route, a shared tool, a route-local tool that
// updates state through the {result, state} envelope, a custom reducer plus an
// inferred append reducer, and typegen schemas in .dawn/routes/chat/tools.json.
// ---------------------------------------------------------------------------

async function fixtureApp(): Promise<string> {
  // realpath: macOS tmpdir sits behind a /var → /private/var symlink and the
  // loader resolves module URLs to real paths — keep every path resolved.
  const appRoot = await realpath(await mkdtemp(join(tmpdir(), "dawn-static-edge-equivalence-")))
  cleanup.push(() =>
    rm(appRoot, {
      force: true,
      maxRetries: 5,
      recursive: true,
      retryDelay: 100,
    }),
  )
  const files: Record<string, string> = {
    ".dawn/routes/chat/tools.json": `${JSON.stringify(
      {
        echo: {
          description: "Echoes the input back",
          parameters: {
            properties: { text: { type: "string" } },
            required: ["text"],
            type: "object",
          },
        },
        note: {
          description: "Records a note and bumps the counter",
          parameters: {
            properties: { note: { type: "string" } },
            required: ["note"],
            type: "object",
          },
        },
      },
      null,
      2,
    )}\n`,
    "dawn.config.ts": "export default {}\n",
    "package.json": '{ "name": "static-edge-equivalence-fixture", "type": "module" }\n',
    "src/app/chat/index.ts":
      'import { agent } from "@dawn-ai/sdk"\n' +
      'export default agent({ model: "gpt-5-mini", systemPrompt: "You are helpful." })\n',
    "src/app/chat/reducers/count.ts":
      "export default (current: unknown, incoming: unknown) =>\n" +
      '  (typeof current === "number" ? current : 0) + (typeof incoming === "number" ? incoming : 0)\n',
    "src/app/chat/state.ts":
      "export default {\n" +
      "  parse: (input: unknown) => ({ count: 0, notes: [] as string[], ...((input as object) ?? {}) }),\n" +
      "}\n",
    "src/app/chat/tools/note.ts":
      'export const description = "Records a note and bumps the counter"\n' +
      "export default async (input: { note: string }) => ({\n" +
      '  result: "noted: " + input.note,\n' +
      "  state: { count: 1, notes: [input.note] },\n" +
      "})\n",
    "src/tools/echo.ts":
      'export const description = "Echoes the input back"\n' +
      'export default async (input: { text: string }) => "echo: " + input.text\n',
  }
  for (const [rel, body] of Object.entries(files)) {
    const filePath = join(appRoot, rel)
    await mkdir(join(filePath, ".."), { recursive: true })
    await writeFile(filePath, body, "utf8")
  }
  return appRoot
}

// ---------------------------------------------------------------------------
// Aimock scripting — copied from `static-equivalence.test.ts`.
//
// script()'s hasToolResult convenience breaks on MULTI-turn tool
// conversations: it matches "any tool message anywhere in the thread", and by
// turn 2 the thread already carries turn 1's tool result. Exact turnIndex
// (= number of assistant messages already in the request) disambiguates every
// LLM call of the conversation instead. Tool-call ids are fixed literals so
// they are deterministic across runs (and preserved by the normalizer).
// ---------------------------------------------------------------------------

function conversationFixtures(): AimockFixture[] {
  return [
    // AP thread — turn 1: "add apples" → note tool → reply.
    {
      match: { turnIndex: 0, userMessage: "add apples" },
      response: {
        toolCalls: [{ arguments: { note: "apples" }, id: "call-note-1", name: "note" }],
      },
    },
    {
      match: { turnIndex: 1, userMessage: "add apples" },
      response: { content: "Noted apples." },
    },
    // AP thread — turn 2: "add pears" → note tool again → reply "using" the
    // accumulated state.
    {
      match: { turnIndex: 2, userMessage: "add pears" },
      response: {
        toolCalls: [{ arguments: { note: "pears" }, id: "call-note-2", name: "note" }],
      },
    },
    {
      match: { turnIndex: 3, userMessage: "add pears" },
      response: { content: "Noted pears — that makes 2 notes so far." },
    },
    // AG-UI thread (fresh): "echo hello" → shared echo tool → reply.
    {
      match: { turnIndex: 0, userMessage: "echo hello" },
      response: {
        toolCalls: [{ arguments: { text: "hello" }, id: "call-echo-1", name: "echo" }],
      },
    },
    {
      match: { turnIndex: 1, userMessage: "echo hello" },
      response: { content: "Echoed it for you." },
    },
  ]
}

/** Start a fresh aimock pointed at by OPENAI_BASE_URL; returns a stop() that
 * closes the mock and restores the previous env. */
async function startAimock(): Promise<{
  getModelRequests: () => unknown
  stop: () => Promise<void>
}> {
  const aimock = await createAimock({ fixtures: [] })
  aimock.addFixtures(conversationFixtures())
  const prevBaseUrl = process.env.OPENAI_BASE_URL
  const prevKey = process.env.OPENAI_API_KEY
  process.env.OPENAI_BASE_URL = aimock.baseUrl
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "test-not-used"
  return {
    getModelRequests: () =>
      aimock.getRequests().map((entry) => ({
        messages: entry.body?.messages,
        tools: entry.body?.tools,
      })),
    stop: async () => {
      await aimock.close()
      if (prevBaseUrl === undefined) delete process.env.OPENAI_BASE_URL
      else process.env.OPENAI_BASE_URL = prevBaseUrl
      if (prevKey === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = prevKey
    },
  }
}

// ---------------------------------------------------------------------------
// Per-request stores — the edge shape, exercised for real
//
// A deployed worker builds a Postgres pool per request over ONE shared
// database and closes it when the response settles. The analogue here is a
// fresh set of sqlite-backed stores per request over one shared pair of
// database files: same lifetime, same "durable state outlives the connection"
// property, no container. The point is that run 2 gets its stores through
// `requestStores` — nothing is resolved at boot, and nothing is reused.
//
// Each store is wrapped so a call arriving AFTER its request's `dispose()` is
// recorded rather than silently tolerated: that is the shape of the bug the
// seam exists to prevent (a pool ended while an SSE body is still streaming).
// `dispose` only FLAGS the bag rather than closing the sqlite handles — a real
// close would turn a recorded violation into a crash, and the point is to see
// the whole list, not the first one.
// ---------------------------------------------------------------------------

interface RequestStoreProbe {
  /** One label per request the factory was asked to serve, in order. */
  readonly built: string[]
  /** One label per request whose stores were torn down, in order. */
  readonly disposed: string[]
  /** Any store call that arrived after that request's stores were disposed. */
  readonly useAfterDispose: string[]
  readonly requestStores: (request: Request) => RequestStores
}

function perRequestStores(dbDir: string): RequestStoreProbe {
  const built: string[] = []
  const disposed: string[] = []
  const useAfterDispose: string[] = []

  let seq = 0
  const requestStores = (request: Request): RequestStores => {
    // Sequence-numbered: two `/runs/wait` turns share a path, and "which bag"
    // is the whole question when a call arrives after a disposal.
    const label = `#${++seq} ${request.method} ${new URL(request.url).pathname}`
    built.push(label)
    let isDisposed = false

    /** Delegates every method to the real store, flagging post-dispose use. */
    const guard = <T extends object>(store: T, name: string): T =>
      new Proxy(store, {
        get(target, property) {
          // `this` is bound to the real store below, so private class fields
          // (the sqlite handle) resolve as they would without the proxy.
          const value = Reflect.get(target, property, target)
          if (typeof value !== "function") return value
          return (...args: unknown[]) => {
            if (isDisposed) useAfterDispose.push(`${label} → ${name}.${String(property)}`)
            return (value as (...rest: unknown[]) => unknown).apply(target, args)
          }
        },
      })

    return {
      checkpointer: guard(
        sqliteCheckpointer({ path: join(dbDir, "checkpoints.sqlite") }),
        "checkpointer",
      ),
      dispose: async () => {
        isDisposed = true
        disposed.push(label)
      },
      permissionsStore: interactivePermissionsStore(),
      threadsStore: guard(
        createThreadsStore({ path: join(dbDir, "threads.sqlite") }),
        "threadsStore",
      ),
      // No memoryStore, matching the emitted `stores.mjs` exactly: route
      // memory is gated off this target, so nothing may ask for one. If
      // anything did, the request would 500 with DAWN_E5301 and the
      // comparison below would fail loudly rather than quietly.
    }
  }

  return { built, disposed, requestStores, useAfterDispose }
}

/**
 * The permissions store the node run resolves, minus the disk.
 *
 * The node path builds `createPermissionsStore({ appRoot, config: undefined,
 * mode: "interactive" })` per request and loads a `.dawn/permissions.json` the
 * fixture does not have — i.e. interactive mode over empty allow/deny lists.
 * Reproducing that (rather than reaching for the always-"allow" fake) keeps
 * permissions from being a fourth difference between the runs: were a tool to
 * consult it, both runs would take the same branch.
 */
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

// ---------------------------------------------------------------------------
// Conversation driver — the identical request sequence for both runs
// (copied from `static-equivalence.test.ts`)
// ---------------------------------------------------------------------------

interface ConversationTranscript {
  /** POST /threads response body. */
  readonly createThread: unknown
  /** POST /threads/:id/runs/wait bodies for turns 1 and 2. */
  readonly turn1: unknown
  readonly turn2: unknown
  /** GET /threads/:id/state body. */
  readonly state: unknown
  /** Parsed AG-UI SSE event payloads, in stream order. */
  readonly aguiEvents: readonly unknown[]
  /** The AG-UI event-type sequence (compared separately for clear failures). */
  readonly aguiEventTypes: readonly string[]
  /** Every model-request payload aimock observed ({messages, tools} each). */
  readonly modelRequests: unknown
}

/** Requests `driveConversation` issues — the expected per-request store count. */
const REQUESTS_PER_CONVERSATION = 5

async function driveConversation(
  handler: Awaited<ReturnType<typeof createEdgeRuntimeFetchHandler>>,
  options: {
    /** Client-chosen AG-UI thread id — MUST differ between the two runs (the
     * runs share one appRoot, so reusing it would replay onto run 1's
     * checkpointed history). Normalized before comparison. */
    readonly aguiThreadId: string
    readonly getModelRequests: () => unknown
  },
): Promise<ConversationTranscript> {
  const postJson = async (path: string, body: unknown): Promise<Response> =>
    handler.fetch(
      new Request(`http://localhost${path}`, {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    )

  // 1. Create a thread (server-generated id — volatile).
  const createResponse = await postJson("/threads", {})
  expect(createResponse.status).toBe(200)
  const createThread = (await createResponse.json()) as { thread_id?: string }
  const threadId = createThread.thread_id
  if (typeof threadId !== "string") throw new Error("expected POST /threads to return thread_id")

  // 2. Turn 1: tool call + state update.
  const turn1Response = await postJson(`/threads/${encodeURIComponent(threadId)}/runs/wait`, {
    input: { messages: [{ content: "add apples", role: "user" }] },
    route: "/chat#agent",
  })
  expect(turn1Response.status).toBe(200)
  const turn1 = await turn1Response.json()

  // 3. Turn 2: second tool call, reducers accumulate over turn 1's state.
  const turn2Response = await postJson(`/threads/${encodeURIComponent(threadId)}/runs/wait`, {
    input: { messages: [{ content: "add pears", role: "user" }] },
    route: "/chat#agent",
  })
  expect(turn2Response.status).toBe(200)
  const turn2 = await turn2Response.json()

  // 4. Final checkpoint state.
  const stateResponse = await handler.fetch(
    new Request(`http://localhost/threads/${encodeURIComponent(threadId)}/state`),
  )
  expect(stateResponse.status).toBe(200)
  const state = await stateResponse.json()

  // 5. One AG-UI request (fresh thread), full SSE stream collected.
  const routeKey = encodeURIComponent("/chat#agent")
  const aguiResponse = await handler.fetch(
    new Request(`http://localhost/agui/${routeKey}`, {
      body: JSON.stringify({
        context: [],
        forwardedProps: {},
        messages: [{ content: "echo hello", id: "u1", role: "user" }],
        runId: "rn-agui",
        state: {},
        threadId: options.aguiThreadId,
        tools: [],
      }),
      headers: {
        accept: "text/event-stream",
        "content-type": "application/json",
      },
      method: "POST",
    }),
  )
  expect(aguiResponse.status).toBe(200)
  const reader = aguiResponse.body?.getReader()
  if (!reader) throw new Error("expected a streaming AG-UI response body")
  const chunks: string[] = []
  for (;;) {
    const next = await reader.read()
    if (next.done) break
    chunks.push(new TextDecoder().decode(next.value))
  }
  const aguiEvents = parseSseEvents(chunks.join(""))
  const aguiEventTypes = aguiEvents.map((event) =>
    typeof (event as { type?: unknown }).type === "string"
      ? ((event as { type: string }).type ?? "")
      : "<no-type>",
  )

  return {
    aguiEvents,
    aguiEventTypes,
    createThread,
    modelRequests: options.getModelRequests(),
    state,
    turn1,
    turn2,
  }
}

/** Parse an SSE body (`data: <json>\n\n` frames) into event payloads. */
function parseSseEvents(text: string): unknown[] {
  return text
    .split("\n\n")
    .map((block) =>
      block
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice("data: ".length))
        .join(""),
    )
    .filter((data) => data.length > 0)
    .map((data) => JSON.parse(data) as unknown)
}

// ---------------------------------------------------------------------------
// Normalization — ONLY genuinely volatile fields.
// (copied from `static-equivalence.test.ts`, including its reasoning)
//
// Volatile = values that legitimately differ between two runs of the same
// conversation: thread ids, run ids, message ids, checkpoint ids (all
// process-generated uuids/chatcmpl ids) and timestamps. NOTHING else — not
// content, not tool names/args/results, not state values, not event types or
// order.
//
//   - Id-bearing keys: values are replaced with placeholders assigned in order
//     of first appearance, so cross-references (e.g. checkpoint_id in config
//     AND parent_config) must agree between runs — an edge-path id plumbed to
//     the wrong place still fails the comparison.
//   - Deterministic ids the TEST supplies (fixture tool-call ids, the client
//     message id, the client runId) are preserved verbatim so the comparison
//     proves they round-trip — they are never normalized away.
//   - Timestamps: replaced with a flat "<ts>" placeholder (NOT
//     first-appearance mapping: two wall-clock reads can coincide in one run
//     and differ in the other, which would make identity mapping flaky).
// ---------------------------------------------------------------------------

const ID_KEYS = new Set([
  "checkpoint_id",
  "checkpointId",
  "id",
  "message_id",
  "messageId",
  "run_id",
  "runId",
  "thread_id",
  "threadId",
  // AG-UI translator-generated per-run uuid (the MODEL's tool-call id, e.g.
  // "call-echo-1", is deterministic, preserved, and compared verbatim — this
  // key only ever normalizes the translator's own uuids).
  "toolCallId",
])

const TIMESTAMP_KEYS = new Set(["created", "created_at", "timestamp", "ts", "updated_at"])

/** Test-supplied deterministic ids that must compare VERBATIM across runs. */
const PRESERVED_IDS = new Set(["call-echo-1", "call-note-1", "call-note-2", "rn-agui", "u1"])

function normalizeTranscript(transcript: ConversationTranscript): unknown {
  const assigned = new Map<string, string>()
  const normalizeValue = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(normalizeValue)
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => {
          if (TIMESTAMP_KEYS.has(key) && (typeof entry === "string" || typeof entry === "number")) {
            return [key, "<ts>"]
          }
          if (ID_KEYS.has(key) && typeof entry === "string" && !PRESERVED_IDS.has(entry)) {
            let placeholder = assigned.get(entry)
            if (placeholder === undefined) {
              placeholder = `<id-${assigned.size + 1}>`
              assigned.set(entry, placeholder)
            }
            return [key, placeholder]
          }
          return [key, normalizeValue(entry)]
        }),
      )
    }
    return value
  }
  return normalizeValue({
    aguiEvents: transcript.aguiEvents,
    createThread: transcript.createThread,
    modelRequests: transcript.modelRequests,
    state: transcript.state,
    turn1: transcript.turn1,
    turn2: transcript.turn2,
  })
}

// ---------------------------------------------------------------------------
// The test
// ---------------------------------------------------------------------------

describe("node-static vs edge-static equivalence", () => {
  it("serves the identical conversation from modules.edge.mjs with per-request stores", async () => {
    const appRoot = await fixtureApp()

    // The emitted manifests import `@dawn-ai/cli/runtime` and
    // `@dawn-ai/cli/fetch`; the fixture resolves both through this symlink.
    await mkdir(join(appRoot, "node_modules", "@dawn-ai"), { recursive: true })
    await symlink(
      join(repoRoot, "packages", "cli"),
      join(appRoot, "node_modules", "@dawn-ai", "cli"),
      "dir",
    )

    const manifest = await discoverRoutes({ appRoot })
    // The fixture must be an app the `hono` target would actually build: an
    // equivalence proof about an app the gate rejects proves nothing about a
    // deploy. This also pins the fixture to the gate — if a future capability
    // is gated, this fails here rather than silently comparing a dead shape.
    expect(
      collectEdgeCapabilityViolations({ appRoot, config: {}, manifest }).map((v) => v.capability),
    ).toEqual([])

    // ---- Both manifests, from the REAL emitters, over ONE discovery pass ----
    // A single `collectRouteStaticDiscovery` result feeds both: the emitters
    // are the only difference under test, so the input they are given must be
    // the same object graph, not two walks that could themselves diverge.
    const discoveries: RouteStaticDiscovery[] = []
    for (const route of manifest.routes) {
      discoveries.push(await collectRouteStaticDiscovery({ appRoot, route }))
    }
    const buildDir = join(appRoot, ".dawn", "build")
    await mkdir(buildDir, { recursive: true })
    const nodeModulesPath = join(buildDir, "modules.mjs")
    const edgeModulesPath = join(buildDir, "modules.edge.mjs")
    await writeFile(nodeModulesPath, emitModulesFile({ appRoot, buildDir, discoveries }), "utf8")
    await writeFile(
      edgeModulesPath,
      emitEdgeModulesFile({ appRoot, buildDir, discoveries }),
      "utf8",
    )

    // ---- Run 1: NODE STATIC (modules.mjs + boot-resolved, disk-backed stores)
    const nodeModules = await loadStaticModules(pathToFileURL(nodeModulesPath))
    expect(nodeModules.routes.map((route) => route.assistantId)).toEqual(["/chat#agent"])

    const nodeAimock = await startAimock()
    const nodeHandler = await createNodeRuntimeFetchHandler({ appRoot, modules: nodeModules })
    let nodeRun: ConversationTranscript
    try {
      nodeRun = await driveConversation(nodeHandler, {
        aguiThreadId: "th-agui-node",
        getModelRequests: nodeAimock.getModelRequests,
      })
    } finally {
      await nodeHandler.close()
      await nodeAimock.stop()
    }

    // Anchor assertions BEFORE any normalization: the node baseline really ran
    // tools and reducers (custom sum reducer → count 2; inferred append
    // reducer → both notes), so the equivalence below cannot trivially pass on
    // two equally-broken runs.
    const nodeState = nodeRun.state as { values?: Record<string, unknown> }
    expect(nodeState.values?.count).toBe(2)
    expect(nodeState.values?.notes).toEqual(["apples", "pears"])
    expect(JSON.stringify(nodeRun.turn1)).toContain("noted: apples")
    expect(JSON.stringify(nodeRun.aguiEvents)).toContain("echo: hello")
    expect(nodeRun.aguiEventTypes[0]).toBe("RUN_STARTED")
    expect(nodeRun.aguiEventTypes.at(-1)).toBe("RUN_FINISHED")

    // ---- Reset every relevant per-process cache so the edge run cannot
    // inherit the node run's loaded modules, config, or materialized agents
    // (which also capture the now-closed aimock's base URL). ----
    __resetRouteLoadCachesForTests()
    __clearDawnConfigCacheForTests()
    __resetMaterializedAgentsForTests()

    // ---- Run 2: EDGE STATIC (modules.edge.mjs + per-request stores) --------
    const edgeModules = await loadStaticModules(pathToFileURL(edgeModulesPath))
    expect(edgeModules.routes.map((route) => route.assistantId)).toEqual(["/chat#agent"])
    // …and it really is the EDGE manifest: its paths are the `/<app-dir>`
    // namespace, with no build-machine path anywhere in them. If this ever
    // matched the node manifest, run 2 would be re-proving run 1.
    const namespace = edgeAppNamespace(appRoot)
    expect(edgeModules.routes[0]?.routeFile).toBe(`${namespace}/src/app/chat/index.ts`)
    expect(JSON.stringify(edgeModules.routes)).not.toContain(appRoot)

    // A separate database, as a deployed worker has: run 1's sqlite files live
    // under the app root, which the edge runtime cannot see at all.
    const dbDir = await realpath(await mkdtemp(join(tmpdir(), "dawn-edge-stores-")))
    cleanup.push(() => rm(dbDir, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 }))
    const probe = perRequestStores(dbDir)

    const edgeAimock = await startAimock()
    // The CORE handler, exactly as the emitted `app.mjs` calls it: no node
    // boot fallbacks (nothing may reach for a filesystem), the namespace as
    // appRoot, the inlined config, and stores per request.
    //
    // `backends.filesystem` is the one thing here `app.mjs` does NOT do — see
    // the KNOWN GAP in the header, and the assertion below that it is still a
    // gap. It cannot skew the comparison: the fixture has no `workspace/`
    // directory, so `hasWorkspaceDir` is false on the node run and the
    // fallback is absent entirely on the edge run — neither run contributes a
    // workspace tool, and nothing ever reads through this backend.
    const edgeHandler = await createEdgeRuntimeFetchHandler({
      appRoot: namespace,
      config: { backends: { filesystem: inMemoryFilesystem() } },
      modules: edgeModules,
      requestStores: probe.requestStores,
    })
    let edgeRun: ConversationTranscript
    try {
      edgeRun = await driveConversation(edgeHandler, {
        aguiThreadId: "th-agui-edge",
        getModelRequests: edgeAimock.getModelRequests,
      })
    } finally {
      await edgeHandler.close()
      await edgeAimock.stop()
    }

    // ---- The KNOWN GAP, pinned ----
    // Exactly the shape the emitted `app.mjs` produces — inlined config, no
    // backends — still cannot execute a route. When the eager
    // `createWorkspaceFs` goes lazy this assertion fails, which is the signal
    // to drop the `backends.filesystem` injection above.
    const gapProbe = perRequestStores(dbDir)
    const gapHandler = await createEdgeRuntimeFetchHandler({
      appRoot: namespace,
      config: {},
      modules: edgeModules,
      requestStores: gapProbe.requestStores,
    })
    try {
      const gapResponse = await gapHandler.fetch(
        new Request("http://localhost/threads/edge-gap-probe/runs/wait", {
          body: JSON.stringify({
            input: { messages: [{ content: "add apples", role: "user" }] },
            route: "/chat#agent",
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        }),
      )
      expect(gapResponse.status).toBe(500)
      expect(await gapResponse.text()).toContain("workspace filesystem backend")
    } finally {
      await gapHandler.close()
    }

    // The per-request seam did its job at the HANDLER boundary: one store bag
    // built and torn down for every request, in order. None of this is implied
    // by the transcript comparison — a run that quietly reused one boot
    // instance would produce the same conversation.
    expect(probe.built).toHaveLength(REQUESTS_PER_CONVERSATION)
    expect(probe.disposed).toEqual(probe.built)

    // ---- KNOWN BUG, pinned: the seam stops at the graph ----
    // `materializeAgent` (langchain/src/agent-adapter.ts) memoizes the compiled
    // graph in a process-wide `WeakMap<DawnAgent, AgentLike>` and bypasses that
    // cache only when the checkpointer is `undefined`. The compiled graph
    // EMBEDS the checkpointer, so every request after the one that materialized
    // the route runs its graph against THAT request's checkpointer — which by
    // then has been disposed. Invisible on node (one boot instance, disposed
    // never) and invisible here in the transcript (both bags address the same
    // sqlite files), but on workerd request N+1 would write through request N's
    // ended pool: precisely the dead-I/O-context failure `requestStores` exists
    // to prevent.
    //
    // Pinned rather than asserted-empty so this suite can be green while the
    // fix lands elsewhere. Both assertions fail the moment the cache honors the
    // per-request checkpointer — which is the signal to replace this whole
    // block with `expect(probe.useAfterDispose).toEqual([])`.
    const staleBags = [...new Set(probe.useAfterDispose.map((entry) => entry.split(" → ")[0]))]
    // Only the checkpointer, and only the bag belonging to request #2 — the
    // first route execution, i.e. the one that populated the cache.
    expect(probe.useAfterDispose.every((entry) => entry.includes("→ checkpointer."))).toBe(true)
    expect(staleBags).toEqual([probe.built[1]])
    expect(probe.useAfterDispose.length).toBeGreaterThan(0)

    // ---- Compare ----
    // Event-type sequence first: a drift here gives the clearest signal.
    expect(edgeRun.aguiEventTypes).toEqual(nodeRun.aguiEventTypes)

    // Full transcripts (all AP bodies + AG-UI payloads + model requests),
    // deep-equal after normalizing only volatile ids and timestamps.
    expect(normalizeTranscript(edgeRun)).toEqual(normalizeTranscript(nodeRun))
  }, 120_000)
})
