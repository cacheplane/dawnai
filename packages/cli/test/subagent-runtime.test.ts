import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { RunnableConfig } from "@langchain/core/runnables"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createAimock, script } from "../../testing/dist/index.js"

import {
  buildGuardedSubagentResolver,
  streamResolvedRoute,
} from "../src/lib/runtime/execute-route.js"

const tempDirs: string[] = []
const mocks: Array<{ close: () => Promise<void> }> = []
let previousBaseUrl: string | undefined
let previousApiKey: string | undefined

beforeEach(() => {
  previousBaseUrl = process.env.OPENAI_BASE_URL
  previousApiKey = process.env.OPENAI_API_KEY
})

afterEach(async () => {
  await Promise.all(mocks.splice(0).map((mock) => mock.close()))
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })))
  if (previousBaseUrl === undefined) delete process.env.OPENAI_BASE_URL
  else process.env.OPENAI_BASE_URL = previousBaseUrl
  if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY
  else process.env.OPENAI_API_KEY = previousApiKey
})

const registry = [
  {
    description: "Researches.",
    name: "researcher",
    routeId: "/parent/subagents/researcher",
    rule: { action: "allow" as const },
    source: "convention" as const,
  },
] as const

describe("lazy CLI subagent runtime context", () => {
  it("passes live params, signal, dispatch id, depth, and root sandbox key to child preparation", async () => {
    const prepareChild = vi.fn(async () => ({
      routeId: registry[0].routeId,
      graph: { invoke: vi.fn() },
    }))
    const resolver = buildGuardedSubagentResolver({
      interruptCapable: true,
      parentRouteId: "/parent/[tenant]",
      prepareChild,
      registry,
      routeParamNames: ["tenant"],
    })
    const signal = new AbortController().signal
    const config = {
      configurable: { checkpoint_ns: "parent:1", tenant: "acme", thread_id: "thread-1" },
      metadata: { dawn: { root_sandbox_key: "sandbox-root", subagent_depth: 1 } },
      signal,
    } as RunnableConfig

    await resolver({ callId: "call-child", config, input: "Inspect", name: "researcher" })

    expect(prepareChild).toHaveBeenCalledWith(registry[0], {
      callId: "call-child",
      depth: 2,
      params: { tenant: "acme" },
      rootSandboxKey: "sandbox-root",
      signal,
    })
  })

  it("does not retain a live RunnableConfig between resolutions", async () => {
    const prepareChild = vi.fn(async () => ({
      routeId: registry[0].routeId,
      graph: { invoke: vi.fn() },
    }))
    const resolver = buildGuardedSubagentResolver({
      interruptCapable: true,
      parentRouteId: "/parent",
      prepareChild,
      registry,
    })
    const firstSignal = new AbortController().signal
    const secondSignal = new AbortController().signal

    await resolver({
      callId: "first",
      config: { signal: firstSignal },
      input: "one",
      name: "researcher",
    })
    await resolver({
      callId: "second",
      config: { signal: secondSignal },
      input: "two",
      name: "researcher",
    })

    expect(prepareChild).toHaveBeenNthCalledWith(
      1,
      registry[0],
      expect.objectContaining({ callId: "first", signal: firstSignal }),
    )
    expect(prepareChild).toHaveBeenNthCalledWith(
      2,
      registry[0],
      expect.objectContaining({ callId: "second", signal: secondSignal }),
    )
  })

  it("retains task automatically for nested routes", async () => {
    const app = await nestedFixtureApp()
    const childInput = "ask the specialist"
    const grandchildInput = "inspect the nested evidence"
    const mock = await startMock(
      script()
        .user("delegate twice")
        .callsTool("task", { input: childInput, subagent: "researcher" })
        .replies("Parent complete.")
        .user(childInput)
        .callsTool("task", { input: grandchildInput, subagent: "specialist" })
        .replies("Child complete.")
        .user(grandchildInput)
        .replies("Nested evidence is sound.")
        .build(),
    )

    await collect(app, "/parent", "delegate twice")

    const childRequest = mock.requests().find((request) => hasUserMessage(request, childInput))
    expect(offeredToolNames(childRequest)).toContain("task")
  }, 30_000)

  it("prepares explicit cycles lazily and stops them at native depth three", async () => {
    const app = await cycleFixtureApp()
    const mock = await startMock(
      script()
        .user("start cycle")
        .callsTool("task", { input: "depth 1", subagent: "b" })
        .replies("Root complete.")
        .user("depth 1")
        .callsTool("task", { input: "depth 2", subagent: "a" })
        .replies("Depth one complete.")
        .user("depth 2")
        .callsTool("task", { input: "depth 3", subagent: "b" })
        .replies("Depth two complete.")
        .user("depth 3")
        .callsTool("task", { input: "depth 4", subagent: "a" })
        .replies("Depth three stopped.")
        .build(),
    )

    const chunks = await collect(app, "/a", "start cycle")

    expect(JSON.stringify(chunks)).toContain("maximum subagent depth is 3")
    expect(mock.requests().some((request) => hasUserMessage(request, "depth 4"))).toBe(false)
  }, 30_000)
})

async function nestedFixtureApp(): Promise<{ appRoot: string; routeFile: string }> {
  const appRoot = await fixtureFiles("dawn-subagent-nested-", {
    "src/app/parent/index.ts": agentSource("Parent."),
    "src/app/parent/subagents/researcher/index.ts": agentSource("Researcher."),
    "src/app/parent/subagents/researcher/subagents/specialist/index.ts": agentSource("Specialist."),
  })
  return { appRoot, routeFile: join(appRoot, "src/app/parent/index.ts") }
}

async function cycleFixtureApp(): Promise<{ appRoot: string; routeFile: string }> {
  const appRoot = await fixtureFiles("dawn-subagent-cycle-", {
    "src/descriptors.ts": `import { agent } from "@dawn-ai/sdk"
export const a = agent({ model: "gpt-5-mini", systemPrompt: "Agent A." })
export const b = agent({ model: "gpt-5-mini", systemPrompt: "Agent B." })
;(a as any).subagents = { b }
;(b as any).subagents = { a }
`,
    "src/app/a/index.ts": 'export { a as default } from "../../descriptors.js"\n',
    "src/app/b/index.ts": 'export { b as default } from "../../descriptors.js"\n',
  })
  return { appRoot, routeFile: join(appRoot, "src/app/a/index.ts") }
}

function agentSource(systemPrompt: string): string {
  return `import { agent } from "@dawn-ai/sdk"\nexport default agent({ model: "gpt-5-mini", systemPrompt: ${JSON.stringify(systemPrompt)} })\n`
}

async function fixtureFiles(
  prefix: string,
  files: Readonly<Record<string, string>>,
): Promise<string> {
  const appRoot = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(appRoot)
  const allFiles = {
    "package.json": '{"type":"module"}\n',
    "dawn.config.ts": "export default {}\n",
    ...files,
  }
  await Promise.all(
    Object.entries(allFiles).map(async ([relativePath, source]) => {
      const filePath = join(appRoot, relativePath)
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, source, "utf8")
    }),
  )
  return appRoot
}

async function startMock(fixtures: Parameters<typeof createAimock>[0]["fixtures"]) {
  const mock = await createAimock({ fixtures })
  mocks.push(mock)
  process.env.OPENAI_BASE_URL = mock.baseUrl
  process.env.OPENAI_API_KEY = "test-not-used"
  return { requests: () => mock.getRequests() }
}

async function collect(
  app: { readonly appRoot: string; readonly routeFile: string },
  routeId: string,
  input: string,
): Promise<unknown[]> {
  const chunks: unknown[] = []
  for await (const chunk of streamResolvedRoute({
    appRoot: app.appRoot,
    input: { messages: [{ content: input, role: "user" }] },
    routeFile: app.routeFile,
    routeId,
    routePath: routeId,
    threadId: `thread-${Date.now()}-${Math.random()}`,
  })) {
    chunks.push(chunk)
  }
  return chunks
}

function offeredToolNames(request: unknown): readonly string[] {
  const tools = (request as { readonly body?: { readonly tools?: readonly unknown[] } } | undefined)
    ?.body?.tools
  return (tools ?? []).flatMap((tool) => {
    const name = (tool as { readonly function?: { readonly name?: unknown } }).function?.name
    return typeof name === "string" ? [name] : []
  })
}

function hasUserMessage(request: unknown, content: string): boolean {
  const messages = (
    request as { readonly body?: { readonly messages?: readonly unknown[] } } | undefined
  )?.body?.messages
  return (messages ?? []).some((message) => {
    const candidate = message as { readonly content?: unknown; readonly role?: unknown }
    return candidate.role === "user" && candidate.content === content
  })
}
