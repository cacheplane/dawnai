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
  vi.doUnmock("@langchain/langgraph/prebuilt")
  vi.doUnmock("@langchain/openai")
})

describe("subagent sandbox preparation", () => {
  it("inherits the root sandbox key and recompiles sandbox-bound children per dispatch", async () => {
    const appRoot = await fixtureApp()
    const getForThread = vi.fn(async () => ({
      exec: { execute: vi.fn() },
      filesystem: {
        list: vi.fn(),
        mkdir: vi.fn(),
        read: vi.fn(),
        remove: vi.fn(),
        stat: vi.fn(),
        write: vi.fn(),
      },
      workspaceRoot: "/workspace",
    }))
    const createReactAgent = vi.fn((_options: unknown) => ({
      invoke: vi.fn(async () => ({ messages: [new AIMessage("Child complete.")] })),
    }))
    vi.doMock("@langchain/langgraph/prebuilt", () => ({ createReactAgent }))
    vi.doMock("@langchain/openai", () => ({ ChatOpenAI: class {} }))

    await materializeResolvedRouteGraph({
      appRoot,
      routeFile: join(appRoot, "src/app/parent/index.ts"),
      routeId: "/parent",
      routePath: "src/app/parent/index.ts",
      sandboxManager: { getForThread } as never,
      sandboxThreadId: "sandbox-root",
    })

    expect(createReactAgent).toHaveBeenCalledTimes(1)
    const task = findTaskTool(createReactAgent.mock.calls[0]?.[0])

    await invokeTask(task, "sandbox-first")
    await invokeTask(task, "sandbox-second")

    expect(createReactAgent).toHaveBeenCalledTimes(3)
    expect(getForThread).toHaveBeenCalledTimes(3)
    for (const call of getForThread.mock.calls) {
      expect(call).toEqual(["sandbox-root", expect.any(AbortSignal)])
    }
  })
})

async function fixtureApp(): Promise<string> {
  const appRoot = await mkdtemp(join(tmpdir(), "dawn-subagent-sandbox-"))
  tempDirs.push(appRoot)
  const files = {
    "package.json": '{"type":"module"}\n',
    "dawn.config.ts": "export default {}\n",
    "src/app/parent/index.ts": `import { agent } from "@dawn-ai/sdk"\nexport default agent({ model: "gpt-5-mini", systemPrompt: "Parent." })\n`,
    "src/app/parent/subagents/researcher/index.ts": `import { agent } from "@dawn-ai/sdk"\nexport default agent({ model: "gpt-5-mini", systemPrompt: "Child." })\n`,
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
              args: { input: "Inspect", subagent: "researcher" },
              id: callId,
              name: "task",
              type: "tool_call",
            },
          ],
        }),
      ],
    },
    { configurable: { thread_id: "sandbox-thread" } },
  )
}
