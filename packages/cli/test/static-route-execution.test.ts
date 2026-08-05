import { existsSync } from "node:fs"
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { discoverRoutes, resolveStateFields } from "@dawn-ai/core"
import { afterEach, describe, expect, it } from "vitest"

import { createAimock, script } from "../../testing/dist/index.js"
import { createRuntimeFetchHandler } from "../src/lib/dev/runtime-fetch-handler.js"
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
// Fixture app: one agent route with a shared tool. Honest fixture — no
// hand-mocks — used both to (a) generate a real `DawnStaticModules` by
// running the actual dynamic loaders once, and (b) serve dynamically as a
// baseline.
// ---------------------------------------------------------------------------

async function fixtureApp(): Promise<string> {
  const appRoot = await mkdtemp(join(tmpdir(), "dawn-static-route-exec-"))
  cleanup.push(() => rm(appRoot, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 }))
  const files: Record<string, string> = {
    "dawn.config.ts": "export default {}\n",
    "package.json": '{ "name": "static-route-exec-fixture", "type": "module" }\n',
    "src/app/chat/index.ts":
      'import { agent } from "@dawn-ai/sdk"\n' +
      'export default agent({ model: "gpt-5-mini", systemPrompt: "You are helpful." })\n',
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

/**
 * Build a `DawnStaticModules` manifest by running the SAME dynamic loaders
 * `createRuntimeRegistry`/`loadPreparedRouteModules` use, once, against an
 * intact fixture app. Honest data — no hand-built normalized modules or
 * tool stubs.
 */
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

/** Point OPENAI_BASE_URL/OPENAI_API_KEY at a local aimock instance for the
 * duration of the test, restoring the previous env afterward. */
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
  userMessage = "hello",
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

// ---------------------------------------------------------------------------
// Test 1: pruned-fixture proof — the static manifest is generated from an
// INTACT fixture, then the route file + tools are deleted from a pruned copy.
// Booting the fetch handler with `modules` against the pruned root and
// completing a turn proves zero dynamic fallback: the dynamic loaders would
// ENOENT/throw if consulted, since the files they'd read no longer exist.
// ---------------------------------------------------------------------------

describe("createRuntimeFetchHandler — static modules (pruned-fixture proof)", () => {
  it("completes a turn using static tools with the route file and tool files deleted", async () => {
    const intactRoot = await fixtureApp()
    const modules = await buildStaticModulesForFixture(intactRoot)

    // Sanity: the manifest actually captured the route + its tool — otherwise
    // this test would trivially pass with an empty registry.
    expect(modules.routes).toHaveLength(1)
    expect(modules.routes[0]?.assistantId).toBe("/chat#agent")
    expect(modules.routes[0]?.tools.map((t) => t.name)).toEqual(["echo"])

    // Prune: copy only dawn.config.ts, package.json, and an empty src/app dir
    // (findDawnApp/config-loading convention) — NOT the route file, NOT
    // src/tools. The dynamic loaders (`normalizeRouteModule`,
    // `discoverToolDefinitions`) would fail against this root.
    const prunedRoot = await mkdtemp(join(tmpdir(), "dawn-static-route-exec-pruned-"))
    cleanup.push(() =>
      rm(prunedRoot, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 }),
    )
    await cp(join(intactRoot, "dawn.config.ts"), join(prunedRoot, "dawn.config.ts"))
    await cp(join(intactRoot, "package.json"), join(prunedRoot, "package.json"))
    await mkdir(join(prunedRoot, "src/app"), { recursive: true })
    expect(existsSync(join(prunedRoot, "src/app/chat"))).toBe(false)
    expect(existsSync(join(prunedRoot, "src/tools"))).toBe(false)

    await withAimock(
      script()
        .user("echo hello")
        .callsTool("echo", { text: "hello" })
        .replies("Hi there, friend!")
        .build(),
    )

    const handler = await createRuntimeFetchHandler({ appRoot: prunedRoot, modules })
    cleanup.push(() => handler.close())

    // Registry consistency: the synthesized manifest resolves the route with
    // no filesystem access to the (nonexistent) pruned route file.
    expect(handler.fetch).toBeInstanceOf(Function)

    const body = await runChatTurn(handler, "th-pruned", "echo hello")
    expect(body).toContain("RUN_STARTED")
    // The tool actually ran (its real `run` fn, bound from the static
    // manifest — no dynamic tool-discovery ever touched the pruned root) and
    // produced its real output, which only the static tool's `run` closure
    // can know how to format.
    expect(body).toContain("echo: hello")
    expect(body).toContain("Hi there, friend!")
    expect(body).toContain("RUN_FINISHED")
  }, 30_000)
})

// ---------------------------------------------------------------------------
// Test 2: dynamic-path untouched — booted WITHOUT `modules` on the intact
// fixture behaves exactly as today (one turn passes end to end).
// ---------------------------------------------------------------------------

describe("createRuntimeFetchHandler — without modules (dynamic path unchanged)", () => {
  it("completes a turn via the existing dynamic discovery path", async () => {
    const appRoot = await fixtureApp()
    await withAimock(script().user("hello").replies("Hi there, friend!").build())

    const handler = await createRuntimeFetchHandler({ appRoot })
    cleanup.push(() => handler.close())

    const body = await runChatTurn(handler, "th-dynamic")
    expect(body).toContain("RUN_STARTED")
    expect(body).toContain("Hi there, friend!")
    expect(body).toContain("RUN_FINISHED")
  }, 30_000)
})
