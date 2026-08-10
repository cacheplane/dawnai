import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ScenarioToolCallRecord, ScenarioToolMockDescriptor } from "@dawn-ai/sdk/testing"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const langchainMocks = vi.hoisted(() => ({
  executeAgent: vi.fn(),
  materializeAgentGraph: vi.fn(),
}))

vi.mock("@dawn-ai/langchain", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dawn-ai/langchain")>()
  return {
    ...actual,
    executeAgent: langchainMocks.executeAgent,
    materializeAgentGraph: langchainMocks.materializeAgentGraph,
  }
})

import {
  executeResolvedRoute,
  executeRoute,
  invokeResolvedRoute,
  materializeResolvedRouteGraph,
  streamResolvedRoute,
} from "../src/lib/runtime/execute-route.js"

const fixtureRoots: string[] = []

beforeEach(() => {
  langchainMocks.executeAgent.mockImplementation(async (value: unknown) => {
    const options = value as {
      readonly input: unknown
      readonly signal: AbortSignal
      readonly tools: ReadonlyArray<{
        readonly name: string
        readonly run: (input: unknown, context: { readonly signal: AbortSignal }) => unknown
      }>
    }
    const search = options.tools.find((tool) => tool.name === "search")
    if (!search) throw new Error("Expected agent search tool")
    return await search.run(options.input, { signal: options.signal })
  })
  langchainMocks.materializeAgentGraph.mockResolvedValue({ invoke: vi.fn() })
})

afterEach(async () => {
  langchainMocks.executeAgent.mockReset()
  langchainMocks.materializeAgentGraph.mockReset()
  for (const appRoot of fixtureRoots.splice(0).reverse()) {
    await rm(appRoot, { force: true, recursive: true })
  }
})

describe("scenario tool override runtime boundary", () => {
  it("marks only scenario-overridden agent preparation to bypass the graph cache", async () => {
    const fixture = await createFixtureApp()
    const journal: ScenarioToolCallRecord[] = []

    const ordinary = await executeRoute({
      appRoot: fixture.appRoot,
      input: { query: "ordinary-before" },
      routeFile: fixture.agentRouteFile,
    })
    const overridden = await executeRoute({
      appRoot: fixture.appRoot,
      input: { query: "overridden" },
      routeFile: fixture.agentRouteFile,
      toolCallJournal: journal,
      toolOverrides: overrideExtras(journal).toolOverrides,
    })
    const ordinaryAgain = await executeRoute({
      appRoot: fixture.appRoot,
      input: { query: "ordinary-after" },
      routeFile: fixture.agentRouteFile,
    })

    expect(ordinary.status).toBe("passed")
    expect(overridden.status).toBe("passed")
    expect(ordinaryAgain.status).toBe("passed")
    if (ordinary.status !== "passed") throw new Error(ordinary.error.message)
    if (overridden.status !== "passed") throw new Error(overridden.error.message)
    if (ordinaryAgain.status !== "passed") throw new Error(ordinaryAgain.error.message)
    expect(ordinary.output).toBe("real:ordinary-before")
    expect(overridden.output).toBe("mock:overridden")
    expect(ordinaryAgain.output).toBe("real:ordinary-after")
    expect(journal).toEqual([{ args: { query: "overridden" }, name: "search", sequence: 0 }])
    expect(langchainMocks.executeAgent).toHaveBeenCalledTimes(3)
    const agentOptions = langchainMocks.executeAgent.mock.calls.map(
      ([options]) => options as { readonly bypassCache?: boolean; readonly sandboxed?: boolean },
    )
    expect(agentOptions.map((options) => options.bypassCache)).toEqual([undefined, true, undefined])
    expect(agentOptions.map((options) => options.sandboxed)).toEqual([
      undefined,
      undefined,
      undefined,
    ])
  })

  it("ignores override-shaped extras on resolved route execution", async () => {
    const fixture = await createFixtureApp()
    const journal: ScenarioToolCallRecord[] = []
    const options = {
      appRoot: fixture.appRoot,
      input: { query: "resolved" },
      routeFile: fixture.workflowRouteFile,
      routeId: "/workflow",
      routePath: "src/app/workflow/index.ts",
      ...overrideExtras(journal),
    }

    const result = await executeResolvedRoute(options)

    expect(result.status).toBe("passed")
    if (result.status !== "passed") throw new Error(result.error.message)
    expect(result.output).toBe("real:resolved")
    expect(journal).toEqual([])
  })

  it("ignores override-shaped extras on resolved route invocation", async () => {
    const fixture = await createFixtureApp()
    const journal: ScenarioToolCallRecord[] = []
    const options = {
      appRoot: fixture.appRoot,
      input: { query: "invoke" },
      routeFile: fixture.workflowRouteFile,
      routeId: "/workflow",
      routePath: "src/app/workflow/index.ts",
      ...overrideExtras(journal),
    }

    const result = await invokeResolvedRoute(options)

    expect(result.status).toBe("passed")
    if (result.status !== "passed") throw new Error(result.error.message)
    expect(result.output).toBe("real:invoke")
    expect(journal).toEqual([])
  })

  it("ignores override-shaped extras on resolved route streaming", async () => {
    const fixture = await createFixtureApp()
    const journal: ScenarioToolCallRecord[] = []
    const options = {
      appRoot: fixture.appRoot,
      input: { query: "stream" },
      routeFile: fixture.workflowRouteFile,
      routeId: "/workflow",
      routePath: "src/app/workflow/index.ts",
      ...overrideExtras(journal),
    }

    const chunks = []
    for await (const chunk of streamResolvedRoute(options)) chunks.push(chunk)

    expect(chunks).toEqual([{ output: "real:stream", type: "done" }])
    expect(journal).toEqual([])
  })

  it("ignores override-shaped extras when materializing a resolved agent", async () => {
    const fixture = await createFixtureApp()
    const journal: ScenarioToolCallRecord[] = []
    const options = {
      appRoot: fixture.appRoot,
      routeFile: fixture.agentRouteFile,
      routeId: "/agent",
      routePath: "src/app/agent/index.ts",
      ...overrideExtras(journal),
    }

    await materializeResolvedRouteGraph(options)

    expect(langchainMocks.materializeAgentGraph).toHaveBeenCalledTimes(1)
    const materializeOptions = langchainMocks.materializeAgentGraph.mock.calls[0]?.[0] as
      | {
          readonly tools?: ReadonlyArray<{
            readonly name: string
            readonly run: (input: unknown, context: { readonly signal: AbortSignal }) => unknown
          }>
        }
      | undefined
    const search = materializeOptions?.tools?.find((tool) => tool.name === "search")
    if (!search) throw new Error("Expected materialized search tool")
    await expect(
      Promise.resolve(
        search.run({ query: "materialize" }, { signal: new AbortController().signal }),
      ),
    ).resolves.toBe("real:materialize")
    expect(journal).toEqual([])
  })
})

function overrideExtras(journal: ScenarioToolCallRecord[]): {
  readonly toolCallJournal: ScenarioToolCallRecord[]
  readonly toolOverrides: readonly ScenarioToolMockDescriptor[]
} {
  return {
    toolCallJournal: journal,
    toolOverrides: [
      {
        implementation: (input) => {
          const { query } = input as { readonly query: string }
          return `mock:${query}`
        },
        name: "search",
      },
    ],
  }
}

async function createFixtureApp(): Promise<{
  readonly agentRouteFile: string
  readonly appRoot: string
  readonly workflowRouteFile: string
}> {
  const appRoot = await mkdtemp(join(tmpdir(), "dawn-scenario-override-boundary-"))
  fixtureRoots.push(appRoot)
  const agentRouteDir = join(appRoot, "src/app/agent")
  const workflowRouteDir = join(appRoot, "src/app/workflow")
  await mkdir(join(agentRouteDir, "tools"), { recursive: true })
  await mkdir(join(workflowRouteDir, "tools"), { recursive: true })
  await writeFile(
    join(appRoot, "package.json"),
    '{ "name": "scenario-override-boundary-fixture", "type": "module" }\n',
    "utf8",
  )
  await writeFile(join(appRoot, "dawn.config.ts"), "export default {}\n", "utf8")
  await writeFile(
    join(workflowRouteDir, "index.ts"),
    [
      "export const workflow = async (input: unknown, context: {",
      "  tools: { search: (value: unknown) => Promise<unknown> },",
      "}) => context.tools.search(input)",
      "",
    ].join("\n"),
    "utf8",
  )
  await writeFile(
    join(agentRouteDir, "index.ts"),
    [
      "export const agent = {",
      '  [Symbol.for("dawn.agent")]: true,',
      '  model: "gpt-5-mini",',
      '  systemPrompt: "Test agent.",',
      "}",
      "",
    ].join("\n"),
    "utf8",
  )
  const toolSource = `export default async (input: { readonly query: string }) => \`real:\${input.query}\`\n`
  await writeFile(join(workflowRouteDir, "tools/search.ts"), toolSource, "utf8")
  await writeFile(join(agentRouteDir, "tools/search.ts"), toolSource, "utf8")
  return {
    agentRouteFile: join(agentRouteDir, "index.ts"),
    appRoot,
    workflowRouteFile: join(workflowRouteDir, "index.ts"),
  }
}
