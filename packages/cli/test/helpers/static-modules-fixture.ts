import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { discoverRoutes, resolveStateFields } from "@dawn-ai/core"
import { expect } from "vitest"

import { type Aimock, createAimock, type script } from "../../../testing/dist/index.js"
import type { createRuntimeFetchHandler } from "../../src/lib/dev/runtime-fetch-handler.js"
import { loadRouteMemory } from "../../src/lib/runtime/load-memory.js"
import { normalizeRouteModule } from "../../src/lib/runtime/load-route-kind.js"
import { createRouteAssistantId } from "../../src/lib/runtime/route-identity.js"
import { discoverStateDefinition } from "../../src/lib/runtime/state-discovery.js"
import type { DawnStaticModules, StaticRouteModule } from "../../src/lib/runtime/static-modules.js"
import { discoverToolDefinitions } from "../../src/lib/runtime/tool-discovery.js"

/**
 * Shared per-test teardown registry for the static-modules suites. Test files
 * drain it (reversed) in their own `afterEach` — the helpers below push onto
 * it so fixture dirs, aimock servers, and env overrides are always restored.
 */
export const cleanup: Array<() => Promise<void> | void> = []

/**
 * Build a `DawnStaticModules` manifest by running the SAME dynamic loaders
 * `createRuntimeRegistry`/`loadPreparedRouteModules` use, once, against an
 * intact fixture app. Honest data — no hand-built normalized modules or
 * tool stubs.
 */
export async function buildStaticModulesForFixture(appRoot: string): Promise<DawnStaticModules> {
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

/**
 * Point OPENAI_BASE_URL/OPENAI_API_KEY at a local aimock instance for the
 * duration of the test, restoring the previous env afterward. Returns the
 * handle so tests can inspect the mock's request journal.
 */
export async function withAimock(
  fixtures: ReturnType<ReturnType<typeof script>["build"]>,
): Promise<Aimock> {
  const aimock = await createAimock({ fixtures })
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
  return aimock
}

/** POST one AG-UI turn to the `/chat#agent` route and return the raw SSE body. */
export async function runChatTurn(
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
