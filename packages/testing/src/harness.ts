import { randomUUID } from "node:crypto"
import {
  __resetMaterializedAgentsForTests,
  createRuntimeRegistry,
  runTypegen,
  streamResolvedRoute,
} from "@dawn-ai/cli/runtime"
import { discoverRoutes } from "@dawn-ai/core"
import { type Aimock, createAimock } from "./aimock-runner.js"
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
      // OpenAI chat models use role "system"; gpt-5 / reasoning models send the
      // system prompt under role "developer". Accept either so the captured
      // systemPrompt is populated regardless of which model the route uses.
      if ((m.role === "system" || m.role === "developer") && typeof m.content === "string") {
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
  /**
   * When true, proxy all LLM requests through a real upstream (OPENAI_API_KEY
   * must be set). Requires OPENAI_API_KEY to be present in the environment.
   */
  readonly live?: boolean
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
  [Symbol.asyncDispose](): Promise<void>
}

export async function createAgentHarness(options: AgentHarnessOptions): Promise<AgentHarness> {
  const mode = options.mode ?? "in-process"
  if (mode !== "in-process") {
    throw new Error(`createAgentHarness: mode "${mode}" not yet implemented`)
  }

  const live = options.live ?? false

  // Guard: live mode requires a real API key before doing anything else.
  if (live && !process.env.OPENAI_API_KEY) {
    throw new Error(
      "createAgentHarness({ live: true }) requires OPENAI_API_KEY to be set in the environment",
    )
  }

  const prevBaseUrl = process.env.OPENAI_BASE_URL
  const prevKey = process.env.OPENAI_API_KEY

  // Start aimock once — port (and thus the cached agent's baseURL) stays stable for the harness lifetime.
  // In live mode: proxy all requests through to the real OpenAI upstream.
  const aimock: Aimock = live
    ? await createAimock({ fixtures: [], proxy: { openai: "https://api.openai.com" } })
    : await createAimock({ fixtures: options.fixtures ?? [] })
  process.env.OPENAI_BASE_URL = aimock.baseUrl
  // Only inject a dummy key in mock mode; in live mode the real key is already set.
  if (!live) {
    process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "test-not-used"
  }

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
    await aimock.close()
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
    // In live mode, fixtures are proxied to the real upstream — skip registration.
    if (!live && driveOpts.fixtures) {
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
      // Start each scenario from a clean fixture set. Fixtures are registered
      // additively per run() and findFixture is first-match-in-array-order, so
      // without this a loosely-matched fixture from a prior scenario (e.g. a raw
      // FixtureSet with no `userMessage`) would shadow the next run's turn-0
      // call. Live mode proxies to the real upstream and registers no fixtures.
      if (!live) {
        aimock.clearFixtures()
        if (options.fixtures && options.fixtures.length > 0) {
          aimock.addFixtures(options.fixtures)
        }
      }
    },
    async close() {
      if (closed) return
      closed = true
      await aimock.close()
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
    [Symbol.asyncDispose](): Promise<void> {
      return this.close()
    },
  }
  return harness
}
