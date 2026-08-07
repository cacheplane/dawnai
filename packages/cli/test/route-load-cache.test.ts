import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

// Passthrough-count the route-tree walk at the seam execute-route.ts and
// runtime-registry.ts actually call. The mock delegates to the real
// implementation so discovery behavior is unchanged — only call counts are
// observable.
vi.mock("@dawn-ai/core/node", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dawn-ai/core/node")>()
  return {
    ...actual,
    discoverRoutes: vi.fn(actual.discoverRoutes),
  }
})

import { discoverRoutes } from "@dawn-ai/core/node"
import { createRuntimeFetchHandler } from "../src/lib/dev/runtime-fetch-handler.js"
import { prepareRouteExecution } from "../src/lib/runtime/execute-route.js"

const cleanup: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

async function fixtureApp(): Promise<string> {
  const appRoot = await mkdtemp(join(tmpdir(), "dawn-route-load-cache-"))
  cleanup.push(() => rm(appRoot, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 }))
  await writeFixtureFile(appRoot, "dawn.config.ts", "export default {}\n")
  await writeFixtureFile(
    appRoot,
    "package.json",
    '{ "name": "route-load-cache-fixture", "type": "module" }\n',
  )
  return appRoot
}

async function writeFixtureFile(appRoot: string, rel: string, body: string): Promise<void> {
  const filePath = join(appRoot, rel)
  await mkdir(join(filePath, ".."), { recursive: true })
  await writeFile(filePath, body, "utf8")
}

/**
 * Module source that records one line in `logPath` at module-evaluation time.
 * Two requests that each re-evaluate the module produce two lines; the ESM
 * cache (post `?t=` buster removal) plus the per-route cache produce one.
 */
function evalProbeSource(logPath: string, marker: string, exportLines: string): string {
  return [
    'import { appendFileSync } from "node:fs"',
    `appendFileSync(${JSON.stringify(logPath)}, ${JSON.stringify(`${marker}\n`)})`,
    exportLines,
    "",
  ].join("\n")
}

async function markerCount(logPath: string, marker: string): Promise<number> {
  const content = await readFile(logPath, "utf8").catch(() => "")
  return content.split("\n").filter((line) => line === marker).length
}

async function runsWait(
  handler: Awaited<ReturnType<typeof createRuntimeFetchHandler>>,
  threadId: string,
  route: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await handler.fetch(
    new Request(`http://localhost/threads/${threadId}/runs/wait`, {
      body: JSON.stringify({ input: {}, route }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }),
  )
  return { body: (await response.json()) as Record<string, unknown>, status: response.status }
}

describe("route-load cache — modules load once per process", () => {
  it("evaluates a tool module once across sequential requests", async () => {
    const appRoot = await fixtureApp()
    const logPath = join(appRoot, "eval-log.txt")
    await writeFixtureFile(
      appRoot,
      "src/app/probe/index.ts",
      "export const workflow = async () => ({ ok: true })\n",
    )
    await writeFixtureFile(
      appRoot,
      "src/app/probe/tools/marker.ts",
      evalProbeSource(logPath, "tool", 'export default async () => "ok"'),
    )

    const handler = await createRuntimeFetchHandler({ appRoot })
    cleanup.push(() => handler.close())

    const first = await runsWait(handler, "th-tool-1", "/probe#workflow")
    expect(first.status).toBe(200)
    expect(first.body).toEqual({ ok: true })

    const second = await runsWait(handler, "th-tool-2", "/probe#workflow")
    expect(second.status).toBe(200)
    expect(second.body).toEqual({ ok: true })

    expect(await markerCount(logPath, "tool")).toBe(1)
  }, 30_000)

  it("evaluates state.ts once across sequential agent-route requests", async () => {
    const appRoot = await fixtureApp()
    const logPath = join(appRoot, "eval-log.txt")
    // Agent-kind route via an invoke()-shaped entry: exercises the full agent
    // prep path (state discovery, capabilities, route manifest) without an LLM.
    await writeFixtureFile(
      appRoot,
      "src/app/chat/index.ts",
      "export const agent = { invoke: async () => ({ messages: [] }) }\n",
    )
    await writeFixtureFile(
      appRoot,
      "src/app/chat/state.ts",
      evalProbeSource(
        logPath,
        "state",
        "export default { parse: (_input: unknown) => ({ notes: [] as string[] }) }",
      ),
    )

    const handler = await createRuntimeFetchHandler({ appRoot })
    cleanup.push(() => handler.close())

    const first = await runsWait(handler, "th-state-1", "/chat#agent")
    expect(first.status).toBe(200)

    const second = await runsWait(handler, "th-state-2", "/chat#agent")
    expect(second.status).toBe(200)

    expect(await markerCount(logPath, "state")).toBe(1)
  }, 30_000)

  it("performs no per-request discoverRoutes walk after boot", async () => {
    const appRoot = await fixtureApp()
    await writeFixtureFile(
      appRoot,
      "src/app/chat/index.ts",
      "export const agent = { invoke: async () => ({ messages: [] }) }\n",
    )

    const handler = await createRuntimeFetchHandler({ appRoot })
    cleanup.push(() => handler.close())

    const callsAfterBoot = vi.mocked(discoverRoutes).mock.calls.length

    const first = await runsWait(handler, "th-walk-1", "/chat#agent")
    expect(first.status).toBe(200)

    const second = await runsWait(handler, "th-walk-2", "/chat#agent")
    expect(second.status).toBe(200)

    expect(vi.mocked(discoverRoutes).mock.calls.length).toBe(callsAfterBoot)
  }, 30_000)

  it("does not re-read tools.json after the first request for a route", async () => {
    const appRoot = await fixtureApp()
    await writeFixtureFile(
      appRoot,
      "src/app/probe/index.ts",
      "export const workflow = async () => ({ ok: true })\n",
    )
    await writeFixtureFile(
      appRoot,
      "src/app/probe/tools/marker.ts",
      'export default async () => "ok"\n',
    )
    const schemaPath = join(appRoot, ".dawn", "routes", "probe", "tools.json")
    await writeFixtureFile(
      appRoot,
      ".dawn/routes/probe/tools.json",
      `${JSON.stringify({
        marker: {
          description: "from-manifest",
          parameters: { properties: {}, type: "object" },
        },
      })}\n`,
    )

    const handler = await createRuntimeFetchHandler({ appRoot })
    cleanup.push(() => handler.close())

    const routeArgs = {
      appRoot,
      routeFile: join(appRoot, "src/app/probe/index.ts"),
      routeId: "/probe",
      routePath: "src/app/probe/index.ts",
    }

    const first = await runsWait(handler, "th-json-1", "/probe#workflow")
    expect(first.status).toBe(200)
    expect(first.body).toEqual({ ok: true })

    const before = await prepareRouteExecution(routeArgs)
    if (!before.ok) throw new Error(`route prep failed: ${before.message}`)
    expect(before.tools.find((t) => t.name === "marker")?.description).toBe("from-manifest")

    // Delete the generated schema manifest: a cached route must not notice.
    await unlink(schemaPath)

    const second = await runsWait(handler, "th-json-2", "/probe#workflow")
    expect(second.status).toBe(200)
    expect(second.body).toEqual({ ok: true })

    const after = await prepareRouteExecution(routeArgs)
    if (!after.ok) throw new Error(`route prep failed: ${after.message}`)
    expect(after.tools.find((t) => t.name === "marker")?.description).toBe("from-manifest")
  }, 30_000)
})
