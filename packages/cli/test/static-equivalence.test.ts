import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { __clearDawnConfigCacheForTests, discoverRoutes } from "@dawn-ai/core"
import { __resetMaterializedAgentsForTests } from "@dawn-ai/langchain"
import { afterEach, describe, expect, it } from "vitest"

import { type AimockFixture, createAimock } from "../../testing/dist/index.js"
import {
  collectRouteStaticDiscovery,
  emitModulesFile,
  type RouteStaticDiscovery,
} from "../src/lib/build/targets/modules-emitter.js"
import { createRuntimeFetchHandler } from "../src/lib/dev/runtime-fetch-handler.js"
import { __resetRouteLoadCachesForTests } from "../src/lib/runtime/execute-route.js"
import { loadStaticModules } from "../src/lib/runtime/static-modules.js"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..")

const cleanup: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

// ---------------------------------------------------------------------------
// THE EQUIVALENCE E2E — the core proof of the static-wiring PR.
//
// One fixture app exercising the full static-manifest input surface:
//   - agent route (/chat)
//   - shared tool (src/tools/echo.ts)
//   - route-local tool (src/app/chat/tools/note.ts) that updates state via the
//     {result, state} envelope
//   - state.ts with a custom reducer (reducers/count.ts sums) and an inferred
//     append reducer (notes: [])
//   - memory.ts (semantic route memory — adds memory tools/prompt plumbing)
//   - .dawn/routes/chat/tools.json (typegen schemas to inject/inline)
//
// The IDENTICAL multi-turn conversation is driven twice against the SAME
// fixture: first dynamically (filesystem discovery), then statically (real
// emitter → modules.mjs → loadStaticModules → boot with `modules`), with every
// relevant per-process cache reset in between. All response bodies — plus the
// full AG-UI SSE event stream and the model-request payloads aimock observed —
// must be deep-equal after normalizing ONLY genuinely volatile fields.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Fixture app
// ---------------------------------------------------------------------------

async function fixtureApp(): Promise<string> {
  // realpath: macOS tmpdir sits behind a /var → /private/var symlink and the
  // loader resolves module URLs to real paths — keep every path resolved.
  const appRoot = await realpath(await mkdtemp(join(tmpdir(), "dawn-static-equivalence-")))
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
    "package.json": '{ "name": "static-equivalence-fixture", "type": "module" }\n',
    "src/app/chat/index.ts":
      'import { agent } from "@dawn-ai/sdk"\n' +
      'export default agent({ model: "gpt-5-mini", systemPrompt: "You are helpful." })\n',
    "src/app/chat/memory.ts":
      "export default {\n" +
      '  kind: "semantic",\n' +
      '  scope: ["route"],\n' +
      "  schema: { parse: (value: unknown) => value },\n" +
      "}\n",
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
// Aimock scripting — hand-built fixtures with exact turnIndex matching.
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
// Conversation driver — the identical request sequence for both runs
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

async function driveConversation(
  handler: Awaited<ReturnType<typeof createRuntimeFetchHandler>>,
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
//
// Volatile = values that legitimately differ between two runs of the same
// conversation: thread ids, run ids, message ids, checkpoint ids (all
// process-generated uuids/chatcmpl ids) and timestamps. NOTHING else — not
// content, not tool names/args/results, not state values, not event types or
// order.
//
//   - Id-bearing keys: values are replaced with placeholders assigned in order
//     of first appearance (the test/generated normalizeForFixture approach),
//     so cross-references (e.g. checkpoint_id in config AND parent_config)
//     must agree between runs — a static-path id plumbed to the wrong place
//     still fails the comparison.
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

describe("static vs dynamic equivalence", () => {
  it("serves the identical conversation byte-equal (modulo volatile ids/timestamps) from the static manifest", async () => {
    const appRoot = await fixtureApp()

    // ---- Run 1: DYNAMIC (no modules.mjs on disk yet — pristine fixture) ----
    const dynamicAimock = await startAimock()
    const dynamicHandler = await createRuntimeFetchHandler({ appRoot })
    let dynamic: ConversationTranscript
    try {
      dynamic = await driveConversation(dynamicHandler, {
        aguiThreadId: "th-agui-dynamic",
        getModelRequests: dynamicAimock.getModelRequests,
      })
    } finally {
      await dynamicHandler.close()
      await dynamicAimock.stop()
    }

    // Anchor assertions BEFORE any normalization: the dynamic baseline really
    // ran tools and reducers (custom sum reducer → count 2; inferred append
    // reducer → both notes), so the equivalence below cannot trivially pass
    // on two equally-broken runs.
    const dynamicState = dynamic.state as { values?: Record<string, unknown> }
    expect(dynamicState.values?.count).toBe(2)
    expect(dynamicState.values?.notes).toEqual(["apples", "pears"])
    expect(JSON.stringify(dynamic.turn1)).toContain("noted: apples")
    expect(JSON.stringify(dynamic.aguiEvents)).toContain("echo: hello")
    expect(dynamic.aguiEventTypes[0]).toBe("RUN_STARTED")
    expect(dynamic.aguiEventTypes.at(-1)).toBe("RUN_FINISHED")

    // ---- Generate the static manifest with the REAL emitter ----
    await mkdir(join(appRoot, "node_modules", "@dawn-ai"), { recursive: true })
    await symlink(
      join(repoRoot, "packages", "cli"),
      join(appRoot, "node_modules", "@dawn-ai", "cli"),
      "dir",
    )
    const manifest = await discoverRoutes({ appRoot })
    const discoveries: RouteStaticDiscovery[] = []
    for (const route of manifest.routes) {
      discoveries.push(await collectRouteStaticDiscovery({ appRoot, route }))
    }
    const buildDir = join(appRoot, ".dawn", "build")
    await mkdir(buildDir, { recursive: true })
    const modulesPath = join(buildDir, "modules.mjs")
    await writeFile(modulesPath, emitModulesFile({ appRoot, buildDir, discoveries }), "utf8")

    // ---- Reset every relevant per-process cache so the static run cannot
    // inherit the dynamic run's loaded modules, config, or materialized
    // agents (which also capture the now-closed aimock's base URL). ----
    __resetRouteLoadCachesForTests()
    __clearDawnConfigCacheForTests()
    __resetMaterializedAgentsForTests()

    // ---- Run 2: STATIC (same fixture, fresh thread ids) ----
    const modules = await loadStaticModules(pathToFileURL(modulesPath))
    expect(modules.routes.map((route) => route.assistantId)).toEqual(["/chat#agent"])

    const staticAimock = await startAimock()
    const staticHandler = await createRuntimeFetchHandler({ appRoot, modules })
    let staticRun: ConversationTranscript
    try {
      staticRun = await driveConversation(staticHandler, {
        aguiThreadId: "th-agui-static",
        getModelRequests: staticAimock.getModelRequests,
      })
    } finally {
      await staticHandler.close()
      await staticAimock.stop()
    }

    // ---- Compare ----
    // Event-type sequence first: a drift here gives the clearest signal.
    expect(staticRun.aguiEventTypes).toEqual(dynamic.aguiEventTypes)

    // Full transcripts (all AP bodies + AG-UI payloads + model requests),
    // deep-equal after normalizing only volatile ids and timestamps.
    expect(normalizeTranscript(staticRun)).toEqual(normalizeTranscript(dynamic))
  }, 120_000)
})
