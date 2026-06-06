import { randomUUID } from "node:crypto"
import {
  __resetMaterializedAgentsForTests,
  createRuntimeRegistry,
  runTypegen,
  streamResolvedRoute,
} from "@dawn-ai/cli/runtime"
import { discoverRoutes } from "@dawn-ai/core"
import { type AimockHandle, startAimock } from "./aimock-runner.js"
import type { FixtureSet, ScriptBuilder } from "./fixture-builder.js"
import { type AgentRunResult, collectRunResult } from "./run-result.js"

/** Normalise a ScriptBuilder or bare FixtureSet to a FixtureSet. */
function toFixtureSet(f: FixtureSet | ScriptBuilder): FixtureSet {
  if (Array.isArray(f)) return f
  return f.build()
}

/** Extract the system prompt from a slice of aimock journal requests. */
function systemPromptFromRequests(
  reqs: ReadonlyArray<{ body: { messages?: Array<{ role: string; content: unknown }> } | null }>,
): string {
  for (const req of reqs) {
    const messages = req.body?.messages ?? []
    for (const m of messages) {
      if (m.role === "system" && typeof m.content === "string") {
        return m.content
      }
    }
  }
  return ""
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
  resume(opts: {
    decision: "once" | "always" | "deny"
    fixtures?: FixtureSet | ScriptBuilder
  }): Promise<AgentRunResult>
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

  /** Core drive helper — runs a single turn and merges systemPrompt. */
  async function drive(driveOpts: {
    fixtures?: FixtureSet | ScriptBuilder
    input?: string
    resumeDecision?: "once" | "always" | "deny"
  }): Promise<AgentRunResult> {
    if (driveOpts.fixtures) {
      const newFixtures = toFixtureSet(driveOpts.fixtures)
      if (newFixtures.length > 0) {
        aimock.addFixtures(newFixtures)
      }
    }
    const snapshotLen = aimock.getRequests().length
    // resolved is guaranteed non-null at this point: the catch block re-throws
    // before returning, so if we reach drive() the null check already passed.
    const r = resolved!
    const streamArgs: Parameters<typeof streamResolvedRoute>[0] = {
      appRoot: options.appRoot,
      input:
        driveOpts.input !== undefined
          ? { messages: [{ role: "user", content: driveOpts.input }] }
          : { messages: [] },
      routeFile: r.routeFile,
      routeId: r.routeId,
      routePath: r.routePath,
      threadId,
      ...(driveOpts.resumeDecision !== undefined
        ? { resumeDecision: driveOpts.resumeDecision }
        : {}),
    }
    const stream = streamResolvedRoute(streamArgs)
    const result = await collectRunResult(stream, threadId)
    const turnReqs = aimock.getRequests().slice(snapshotLen)
    return { ...result, systemPrompt: systemPromptFromRequests(turnReqs) }
  }

  const harness: AgentHarness = {
    get baseUrl() {
      return baseUrl
    },
    async run(runOpts) {
      return drive({
        input: runOpts.input,
        ...(runOpts.fixtures !== undefined ? { fixtures: runOpts.fixtures } : {}),
      })
    },
    async resume(resumeOpts) {
      return drive({
        resumeDecision: resumeOpts.decision,
        ...(resumeOpts.fixtures !== undefined ? { fixtures: resumeOpts.fixtures } : {}),
      })
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
