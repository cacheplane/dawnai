import { randomUUID } from "node:crypto"
import { createRuntimeRegistry, runTypegen, streamResolvedRoute } from "@dawn-ai/cli/runtime"
import { discoverRoutes } from "@dawn-ai/core"
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

  let registeredFixtures: FixtureSet = (options.fixtures ?? []).slice()
  let aimock: AimockHandle = await startAimock({ fixtures: registeredFixtures })
  process.env.OPENAI_BASE_URL = aimock.baseUrl
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "test-not-used"

  // typegen once → generated tool schemas exist (dev-boot fidelity)
  const manifest = await discoverRoutes({ appRoot: options.appRoot })
  await runTypegen({ appRoot: options.appRoot, manifest })

  const registry = await createRuntimeRegistry(options.appRoot)
  const resolved = registry.lookup(options.route)
  if (!resolved) {
    await aimock.stop()
    throw new Error(`createAgentHarness: unknown route "${options.route}"`)
  }

  let threadId = randomUUID()
  let closed = false

  async function restartAimock(fixtures: FixtureSet): Promise<void> {
    await aimock.stop()
    aimock = await startAimock({ fixtures })
    process.env.OPENAI_BASE_URL = aimock.baseUrl
  }

  const harness: AgentHarness = {
    get baseUrl() {
      return aimock.baseUrl
    },
    async run(runOpts) {
      if (runOpts.fixtures) {
        const newFixtures = toFixtureSet(runOpts.fixtures)
        if (newFixtures.length > 0) {
          registeredFixtures = [...registeredFixtures, ...newFixtures]
          await restartAimock(registeredFixtures)
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
    },
  }
  return harness
}
