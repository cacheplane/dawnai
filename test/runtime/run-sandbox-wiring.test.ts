/**
 * Sandbox wiring e2e — the behavioral proof that an agent's workspace tools
 * actually route into the per-thread sandbox (no Docker; fakeSandbox in-memory).
 *
 * This is the keystone test for the execution-sandbox feature: it proves that
 * configuring `sandbox: { provider }` in dawn.config.ts + threading the resolved
 * SandboxManager (+ threadId) into streamResolvedRoute causes
 * readFile/writeFile/runBash to redirect into the thread's isolated sandbox
 * volume instead of the host filesystem.
 *
 * INJECTION PATH (in-process, mirrors the runtime HTTP server):
 *   The runtime server (createRuntimeRequestListener) builds ONE SandboxManager
 *   via resolveSandboxManager(appRoot) and passes the SAME manager + the route's
 *   thread_id into every streamResolvedRoute call. We do exactly that here: build
 *   the manager once from the fixture's dawn.config.ts (which holds the
 *   fakeSandbox instance), then drive streamResolvedRoute directly with
 *   { sandboxManager, threadId }. The manager keeps one provider, so each thread
 *   gets its own in-memory volume that persists across turns and is isolated
 *   from other threads.
 *
 * ASSERTIONS (purely behavioral — no fakeSandbox internals):
 *   1. Routing + persistence: thread A writes report.md ("SANDBOXED"); a second
 *      turn on thread A reads it back and the agent sees "SANDBOXED". Proves the
 *      write landed in the sandbox volume and persisted across turns.
 *   2. Host untouched: no file exists at <appRoot>/workspace/report.md on the
 *      host — the write went to the sandbox, not the host fs.
 *   3. Isolation: thread B reading report.md gets ENOENT — per-thread isolation.
 */
import { existsSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import {
  __resetMaterializedAgentsForTests,
  createRuntimeRegistry,
  resolveSandboxManager,
  runTypegen,
  type SandboxManager,
  streamResolvedRoute,
} from "@dawn-ai/cli/runtime"
import { discoverRoutes } from "@dawn-ai/core"
import { type Aimock, collectRunResult, createAimock } from "@dawn-ai/testing"
import { afterAll, beforeAll, expect, it } from "vitest"

const appRoot = fileURLToPath(new URL("./fixtures/sandbox-app", import.meta.url))

let aimock: Aimock
let manager: SandboxManager | undefined
let resolved: { routeFile: string; routeId: string; routePath: string }
let prevBaseUrl: string | undefined
let prevKey: string | undefined

/**
 * Build the aimock fixtures for one turn:
 *   - a tool-call response keyed on the turn's (last) user message, and
 *   - a follow-up text reply keyed on the tool result id.
 * The reply fixture is listed FIRST so it wins once the tool result is present
 * (the matcher returns the first match). This avoids relying on turnIndex /
 * hasToolResult, both of which are unreliable on a checkpoint-resumed thread
 * whose history already contains prior assistant/tool messages.
 */
function toolThenReply(opts: {
  readonly userMessage: string
  readonly toolName: string
  readonly toolArgs: Record<string, unknown>
  readonly callId: string
  readonly reply: string
}): unknown[] {
  return [
    {
      match: { toolCallId: opts.callId },
      response: { content: opts.reply },
    },
    {
      match: { userMessage: opts.userMessage },
      response: { toolCalls: [{ id: opts.callId, name: opts.toolName, arguments: opts.toolArgs }] },
    },
  ]
}

beforeAll(async () => {
  prevBaseUrl = process.env.OPENAI_BASE_URL
  prevKey = process.env.OPENAI_API_KEY

  aimock = await createAimock({ fixtures: [] })
  process.env.OPENAI_BASE_URL = aimock.baseUrl
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "test-not-used"

  // Generate tool schemas (dev-boot fidelity), then resolve the agent route.
  const manifest = await discoverRoutes({ appRoot })
  await runTypegen({ appRoot, manifest })
  const registry = await createRuntimeRegistry(appRoot)
  const lookup = registry.lookup("/agent#agent")
  if (!lookup) throw new Error("sandbox-app: route /agent#agent not found")
  resolved = lookup

  // Build the SandboxManager ONCE from dawn.config.ts — exactly what the runtime
  // server does. The fixture's config holds a single fakeSandbox provider, so the
  // manager hands each thread its own persistent in-memory volume.
  manager = await resolveSandboxManager(appRoot)
  if (!manager) throw new Error("sandbox-app: resolveSandboxManager returned undefined")
}, 120_000)

afterAll(async () => {
  await manager?.releaseAll()
  await aimock.close()
  if (prevBaseUrl === undefined) delete process.env.OPENAI_BASE_URL
  else process.env.OPENAI_BASE_URL = prevBaseUrl
  if (prevKey === undefined) delete process.env.OPENAI_API_KEY
  else process.env.OPENAI_API_KEY = prevKey
  __resetMaterializedAgentsForTests()
})

// Shared across the two cases below: a single write on thread A whose presence
// the other cases probe. Each `it` is self-contained (own threadId), but they
// run in declaration order against the SAME process-wide sandbox manager.
const threadA = `sbx-A-${Date.now()}`
const threadB = `sbx-B-${Date.now()}`

async function runTurn(opts: {
  readonly threadId: string
  readonly userMessage: string
  readonly toolName: string
  readonly toolArgs: Record<string, unknown>
  readonly callId: string
  readonly reply: string
}) {
  aimock.addFixtures(
    toolThenReply({
      userMessage: opts.userMessage,
      toolName: opts.toolName,
      toolArgs: opts.toolArgs,
      callId: opts.callId,
      reply: opts.reply,
    }) as never,
  )
  const stream = streamResolvedRoute({
    appRoot,
    input: { messages: [{ role: "user", content: opts.userMessage }] },
    routeFile: resolved.routeFile,
    routeId: resolved.routeId,
    routePath: resolved.routePath,
    sandboxManager: manager,
    threadId: opts.threadId,
  })
  return collectRunResult(stream, opts.threadId)
}

it("routes workspace tools into the per-thread sandbox, persists across turns, and leaves the host untouched", async () => {
  // --- Turn 1 (thread A): write report.md = "SANDBOXED" ----------------------
  const writeResult = await runTurn({
    threadId: threadA,
    userMessage: "alpha-write",
    toolName: "writeFile",
    toolArgs: { path: "report.md", content: "SANDBOXED" },
    callId: "call_write_a",
    reply: "wrote the report",
  })

  // The write tool actually ran and succeeded. Critically, the workspace
  // capability only activates here because prepareRouteExecution injects the
  // sandbox handle's workspaceRoot — there is NO host `workspace/` dir in this
  // fixture. So `writeFile` being offered + succeeding already proves the
  // workspace routed into the sandbox. (The false-green check confirms: with
  // sandbox wiring disabled, `writeFile` is not even offered.)
  expect(writeResult.toolCalls.map((c) => c.name)).toContain("writeFile")
  const writeTool = writeResult.toolResults.find((r) => r.name === "writeFile")
  expect(writeTool).toBeDefined()
  expect(writeTool?.isError).toBe(false)
  expect(String(writeTool?.content)).toContain("report.md")

  // --- Turn 2 (thread A): read report.md back --------------------------------
  // Same threadId → checkpointer resumes; the sandbox volume persists.
  const readResult = await runTurn({
    threadId: threadA,
    userMessage: "alpha-read",
    toolName: "readFile",
    toolArgs: { path: "report.md" },
    callId: "call_read_a",
    reply: "the report says done",
  })

  // The agent read back exactly the bytes written on turn 1 — proving the write
  // persisted in the thread's sandbox volume across turns.
  const readTool = readResult.toolResults.find((r) => r.name === "readFile")
  expect(readTool).toBeDefined()
  expect(readTool?.isError).toBe(false)
  // ToolMessage content may be JSON-stringified ('"SANDBOXED"'); the exact file
  // body we wrote on turn 1 is present, which is the load-bearing fact.
  expect(String(readTool?.content)).toContain("SANDBOXED")

  // --- Host untouched --------------------------------------------------------
  // The write went into the sandbox (workspaceRoot "/workspace" in fakeSandbox),
  // never to the host. No file should exist under the host workspace dir.
  expect(existsSync(join(appRoot, "workspace", "report.md"))).toBe(false)
})

// Per-thread isolation: thread B has its own empty sandbox volume, so reading
// report.md (written only on thread A) must ENOENT. Guaranteed by the
// agent-adapter bypassing its materialized-agent cache when sandboxed
// (agent-adapter.ts, same precedent as the subagent `task` tool): workspace
// tools close over the thread's sandbox backends, so the compiled agent is
// never reused across threads.
it("isolates per-thread sandbox volumes", async () => {
  const isoResult = await runTurn({
    threadId: threadB,
    userMessage: "bravo-read",
    toolName: "readFile",
    toolArgs: { path: "report.md" },
    callId: "call_read_b",
    reply: "could not find the report",
  })

  const isoTool = isoResult.toolResults.find((r) => r.name === "readFile")
  expect(isoTool).toBeDefined()
  // Thread B's read must error (ENOENT from fakeSandbox) — it never wrote
  // report.md, and thread A's file must not be visible here.
  expect(isoTool?.isError).toBe(true)
  expect(String(isoTool?.content)).toContain("report.md")
  expect(String(isoTool?.content)).not.toContain("SANDBOXED")
})
