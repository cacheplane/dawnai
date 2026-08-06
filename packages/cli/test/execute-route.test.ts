import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { AIMessage } from "@langchain/core/messages"
import { Annotation, END, START, StateGraph } from "@langchain/langgraph"
import { ToolNode } from "@langchain/langgraph/prebuilt"
import { afterEach, describe, expect, it, vi } from "vitest"

import { materializeResolvedRouteGraph } from "../src/lib/runtime/execute-route.js"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })))
  Reflect.deleteProperty(globalThis, "__dawnTask10PolicyCalls")
  vi.doUnmock("@langchain/langgraph/prebuilt")
  vi.doUnmock("@langchain/openai")
})

describe("materializeResolvedRouteGraph", () => {
  it.each([
    ['tools: { allow: ["task"] }', /tools\.allow/],
    ['tools: { deny: ["task"] }', /tools\.deny/],
    ['tools: { approve: ["task"] }', /tools\.approve/],
    ["tools: { constrain: { task: async () => true } }", /tools\.constrain/],
  ])("repeats E1004 route-preparation validation for %s", async (parentBody, field) => {
    const appRoot = await fixtureApp({
      parentBody,
    })

    await expect(
      materializeResolvedRouteGraph({
        appRoot,
        routeFile: join(appRoot, "src/app/parent/index.ts"),
        routeId: "/parent",
        routePath: "src/app/parent/index.ts",
      }),
    ).rejects.toThrow(new RegExp(`\\[DAWN_E1004\\].*${field.source}`))
  })

  it.each([
    ["subagents array", "subagents: []", {}, /subagents must be a keyed object/],
    ["delegation scalar", 'delegation: "allow"', {}, /delegation must be an object/],
    ["rules array", "delegation: { rules: [] }", {}, /delegation\.rules must be an object/],
    ["invalid default", 'delegation: { default: "sometimes" }', {}, /delegation\.default must be/],
    [
      "invalid action",
      'subagents: { child }, delegation: { rules: { child: { action: "ask" } } }',
      { child: true },
      /invalid action/,
    ],
    [
      "invalid predicate",
      'subagents: { child }, delegation: { rules: { child: { action: "constrain", predicate: true } } }',
      { child: true },
      /predicate function/,
    ],
    [
      "invalid reason",
      'subagents: { child }, delegation: { rules: { child: { action: "deny", reason: 42 } } }',
      { child: true },
      /non-string reason/,
    ],
    [
      "unknown rule",
      'subagents: { child }, delegation: { rules: { missing: { action: "allow" } } }',
      { child: true },
      /Unknown rule name "missing"/,
    ],
    [
      "invalid explicit name",
      'subagents: { ["bad name"]: child }',
      { child: true },
      /Invalid explicit subagent name/,
    ],
    ["non-agent reference", "subagents: { child: {} }", {}, /must reference a Dawn agent/],
    ["unresolved reference", "subagents: { orphan }", { orphan: true }, /resolves to no route/],
    [
      "duplicate explicit route",
      "subagents: { first: child, second: child }",
      { child: true },
      /registered more than once/,
    ],
    [
      "explicit convention collision",
      "subagents: { researcher: other }",
      { collision: true },
      /Model-facing name collision/,
    ],
    [
      "ambiguous descriptor",
      "subagents: { shared }",
      { ambiguous: true },
      /ambiguous; candidate routes/,
    ],
    [
      "invalid convention name",
      "",
      { invalidConvention: true },
      /Invalid convention subagent name/,
    ],
  ] as const)("matches dawn check E1004 for %s", async (_name, parentBody, shape, message) => {
    const appRoot = await invalidRegistryFixture(parentBody, shape)

    await expect(
      materializeResolvedRouteGraph({
        appRoot,
        routeFile: join(appRoot, "src/app/parent/index.ts"),
        routeId: "/parent",
        routePath: "/parent",
      }),
    ).rejects.toThrow(new RegExp(`\\[DAWN_E1004\\].*${message.source}`, "i"))
  })

  it("lazily materializes one checkpointer-free child graph while rechecking policy", async () => {
    const createReactAgent = vi.fn((options: unknown) => ({
      invoke: vi.fn(async () => ({ messages: [new AIMessage("Child complete.")] })),
      options,
    }))
    vi.doMock("@langchain/langgraph/prebuilt", () => ({ createReactAgent }))
    vi.doMock("@langchain/openai", () => ({ ChatOpenAI: class {} }))
    const appRoot = await fixtureApp({ child: true, constrainedChild: true })
    Reflect.set(globalThis, "__dawnTask10PolicyCalls", 0)

    await materializeResolvedRouteGraph({
      appRoot,
      routeFile: join(appRoot, "src/app/parent/index.ts"),
      routeId: "/parent",
      routePath: "src/app/parent/index.ts",
    })

    expect(createReactAgent).toHaveBeenCalledTimes(1)
    const task = findTaskTool(createReactAgent.mock.calls[0]?.[0])

    await invokeTask(task, "task-first")

    expect(createReactAgent).toHaveBeenCalledTimes(2)
    const childOptions = createReactAgent.mock.calls[1]?.[0] as { readonly checkpointer?: unknown }
    expect(childOptions.checkpointer).toBeUndefined()

    await invokeTask(task, "task-second")

    expect(createReactAgent).toHaveBeenCalledTimes(2)
    expect(Reflect.get(globalThis, "__dawnTask10PolicyCalls")).toBe(2)
  })
})

async function fixtureApp(options: {
  readonly child?: boolean
  readonly constrainedChild?: boolean
  readonly parentBody?: string
}): Promise<string> {
  const appRoot = await mkdtemp(join(tmpdir(), "dawn-execute-route-"))
  tempDirs.push(appRoot)
  const files: Record<string, string> = {
    "package.json": '{"type":"module"}\n',
    "dawn.config.ts": "export default {}\n",
    "src/app/parent/index.ts": `${options.constrainedChild ? 'import child from "./subagents/child/index.js"\n' : ""}import { agent } from "@dawn-ai/sdk"
export default agent({ model: "gpt-5-mini", systemPrompt: "Parent.", ${
      options.constrainedChild
        ? `subagents: { child }, delegation: { rules: { child: { action: "constrain", predicate: async () => { globalThis.__dawnTask10PolicyCalls = (globalThis.__dawnTask10PolicyCalls ?? 0) + 1; return true } } } },`
        : (options.parentBody ?? "")
    } } as any)
`,
  }
  if (options.child) {
    files[
      `src/app/parent/subagents/${options.constrainedChild ? "child" : "researcher"}/index.ts`
    ] = `import { agent } from "@dawn-ai/sdk"
export default agent({ model: "gpt-5-mini", systemPrompt: "Child." })
`
  }
  await Promise.all(
    Object.entries(files).map(async ([relativePath, source]) => {
      const filePath = join(appRoot, relativePath)
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, source, "utf8")
    }),
  )
  return appRoot
}

async function invalidRegistryFixture(
  parentBody: string,
  shape: {
    readonly ambiguous?: boolean
    readonly child?: boolean
    readonly collision?: boolean
    readonly invalidConvention?: boolean
    readonly orphan?: boolean
  },
): Promise<string> {
  const imports = [
    ...(shape.child ? ['import child from "./subagents/child/index.js"'] : []),
    ...(shape.orphan ? ['import orphan from "../../orphan.js"'] : []),
    ...(shape.collision ? ['import other from "../other/index.js"'] : []),
    ...(shape.ambiguous ? ['import shared from "../../shared.js"'] : []),
  ].join("\n")
  const files: Record<string, string> = {
    "src/app/parent/index.ts": `${imports}\nimport { agent } from "@dawn-ai/sdk"
export default agent({ model: "gpt-5-mini", systemPrompt: "Parent.", ${parentBody} } as any)
`,
  }
  if (shape.child) files["src/app/parent/subagents/child/index.ts"] = childSource()
  if (shape.orphan) files["src/orphan.ts"] = childSource()
  if (shape.collision) {
    files["src/app/parent/subagents/researcher/index.ts"] = childSource()
    files["src/app/other/index.ts"] = childSource()
  }
  if (shape.ambiguous) {
    files["src/shared.ts"] = childSource()
    files["src/app/alpha/index.ts"] = 'export { default } from "../../shared.js"\n'
    files["src/app/beta/index.ts"] = 'export { default } from "../../shared.js"\n'
  }
  if (shape.invalidConvention) {
    files["src/app/parent/subagents/bad.name/index.ts"] = childSource()
  }
  return writeFixtureFiles(files)
}

function childSource(): string {
  return `import { agent } from "@dawn-ai/sdk"\nexport default agent({ model: "gpt-5-mini", systemPrompt: "Child." })\n`
}

async function writeFixtureFiles(files: Readonly<Record<string, string>>): Promise<string> {
  const appRoot = await mkdtemp(join(tmpdir(), "dawn-execute-route-invalid-"))
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

function findTaskTool(options: unknown): { readonly name: string } {
  const tools = (options as { readonly tools?: readonly { readonly name: string }[] } | undefined)
    ?.tools
  const task = tools?.find(({ name }) => name === "task")
  if (!task) throw new Error("Expected materialized root task tool")
  return task
}

async function invokeTask(task: { readonly name: string }, callId: string): Promise<void> {
  const graph = new StateGraph(Annotation.Root({ messages: Annotation<unknown[]>() }))
    .addNode("tools", new ToolNode([task as never]))
    .addEdge(START, "tools")
    .addEdge("tools", END)
    .compile()
  await graph.invoke(
    {
      messages: [
        new AIMessage({
          content: "",
          tool_calls: [
            {
              args: { input: "Inspect", subagent: "child" },
              id: callId,
              name: "task",
              type: "tool_call",
            },
          ],
        }),
      ],
    },
    { configurable: { thread_id: "thread-stable" } },
  )
}
