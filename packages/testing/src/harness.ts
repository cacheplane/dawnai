import { randomUUID } from "node:crypto"
import { createRuntimeRegistry, runTypegen, streamResolvedRoute } from "@dawn-ai/cli/runtime"
import { discoverRoutes } from "@dawn-ai/core"
import { __resetMaterializedAgentsForTests } from "@dawn-ai/langchain"
import { type AimockHandle, startAimock } from "./aimock-runner.js"
import type { FixtureSet, ScriptBuilder } from "./fixture-builder.js"
import { type AgentRunResult, collectRunResult } from "./run-result.js"

/** Normalise a ScriptBuilder or bare FixtureSet to a FixtureSet. */
function toFixtureSet(f: FixtureSet | ScriptBuilder): FixtureSet {
  if (Array.isArray(f)) return f
  return f.build()
}

export interface AgentHarnessOptions {
  readonly appRoot: string
  readonly route: string
  readonly fixtures?: FixtureSet
  readonly mode?: "in-process" | "http-inject" | "subprocess"
}

export interface AgentHarness {
  readonly baseUrl: string
  run(opts: { input: string; fixtures?: FixtureSet | ScriptBuilder }): Promise<AgentRunResult>
  reset(): void
  close(): Promise<void>
}

export async function createAgentHarness(options: AgentHarnessOptions): Promise<AgentHarness> {
  const mode = options.mode ?? "in-process"
  if (mode !== "in-process") {
    throw new Error(`createAgentHarness: mode "${mode}" not yet implemented`)
  }

  const prevBaseUrl = process.env.OPENAI_BASE_URL
  const prevKey = process.env.OPENAI_API_KEY

  // Start aimock once — port (and thus the cached agent's baseURL) stays stable for the harness lifetime.
  const aimock: AimockHandle = await startAimock({ fixtures: options.fixtures ?? [] })
  process.env.OPENAI_BASE_URL = aimock.baseUrl
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "test-not-used"

  // All construction steps after aimock starts are wrapped so we can clean up on failure.
  let resolved: Awaited<ReturnType<Awaited<ReturnType<typeof createRuntimeRegistry>>["lookup"]>>
  try {
    // typegen once → generated tool schemas exist (dev-boot fidelity)
    const manifest = await discoverRoutes({ appRoot: options.appRoot })
    await runTypegen({ appRoot: options.appRoot, manifest })

    const registry = await createRuntimeRegistry(options.appRoot)
    resolved = registry.lookup(options.route)
    if (!resolved) {
      throw new Error(`createAgentHarness: unknown route "${options.route}"`)
    }
  } catch (err) {
    // Unified cleanup: stop aimock and restore env vars before re-throwing.
    await aimock.stop()
    if (prevBaseUrl === undefined) delete process.env.OPENAI_BASE_URL
    else process.env.OPENAI_BASE_URL = prevBaseUrl
    if (prevKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = prevKey
    throw err
  }

  const baseUrl = aimock.baseUrl
  let threadId = randomUUID()
  let closed = false

  const harness: AgentHarness = {
    get baseUrl() {
      return baseUrl
    },
    async run(runOpts) {
      if (runOpts.fixtures) {
        const newFixtures = toFixtureSet(runOpts.fixtures)
        if (newFixtures.length > 0) {
          // Append fixtures onto the live mock — no restart, port stays stable.
          aimock.addFixtures(newFixtures)
        }
      }
      const stream = streamResolvedRoute({
        appRoot: options.appRoot,
        input: { messages: [{ role: "user", content: runOpts.input }] },
        routeFile: resolved.routeFile,
        routeId: resolved.routeId,
        routePath: resolved.routePath,
        threadId,
      })
      return await collectRunResult(stream, threadId)
    },
    reset() {
      threadId = randomUUID()
    },
    async close() {
      if (closed) return
      closed = true
      await aimock.stop()
      // restore env to avoid cross-test bleed
      if (prevBaseUrl === undefined) delete process.env.OPENAI_BASE_URL
      else process.env.OPENAI_BASE_URL = prevBaseUrl
      if (prevKey === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = prevKey
      // Reset the per-descriptor LLM cache so the next harness constructs a
      // fresh ChatOpenAI instance pointing to its own aimock URL. Without this,
      // successive harnesses that share the same DawnAgent descriptor object
      // (ESM module cache returns the same export) would reuse an LLM already
      // bound to the previous (stopped) aimock server.
      __resetMaterializedAgentsForTests()
    },
  }
  return harness
}
