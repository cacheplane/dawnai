import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { PermissionsStore } from "@dawn-ai/permissions"
import type { RunnableConfig } from "@langchain/core/runnables"
import { afterEach, describe, expect, it, vi } from "vitest"

const permissionStores = vi.hoisted(() => [] as PermissionsStore[])

vi.mock("@dawn-ai/permissions/node", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dawn-ai/permissions/node")>()
  return {
    ...actual,
    createPermissionsStore: (
      options: Parameters<typeof actual.createPermissionsStore>[0],
    ): PermissionsStore => {
      const store = actual.createPermissionsStore(options)
      permissionStores.push(store)
      return store
    },
  }
})

import { materializeResolvedRouteGraph } from "../src/lib/runtime/execute-route.js"

const tempDirs: string[] = []

afterEach(async () => {
  permissionStores.length = 0
  vi.doUnmock("@langchain/langgraph/prebuilt")
  vi.doUnmock("@langchain/openai")
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })))
})

describe("subagent permission store inheritance", () => {
  it("shares one store and write queue across concurrent parent and child always decisions", async () => {
    const appRoot = await fixtureApp()
    const signal = new AbortController().signal
    const createReactAgent = vi.fn((options: unknown) => ({
      invoke: vi.fn(async () => ({
        messages: [{ content: "Child complete." }],
      })),
      options,
    }))
    vi.doMock("@langchain/langgraph/prebuilt", () => ({ createReactAgent }))
    vi.doMock("@langchain/openai", () => ({ ChatOpenAI: class {} }))

    await materializeResolvedRouteGraph({
      appRoot,
      routeFile: join(appRoot, "src/app/parent/index.ts"),
      routeId: "/parent",
      routePath: "/parent",
      signal,
    })
    const task = findTaskTool(createReactAgent.mock.calls[0]?.[0])
    await task.func({ input: "Inspect", subagent: "child" }, undefined, {
      configurable: { thread_id: "permission-thread" },
      signal,
      toolCall: { id: "permission-child" },
    } as RunnableConfig & { readonly toolCall: { readonly id: string } })

    const rootStore = permissionStores[0]
    const childStore = permissionStores.at(-1)
    expect(rootStore).toBeDefined()
    const parentPattern = JSON.stringify(["/parent", "child"])
    const childPattern = JSON.stringify(["/parent/subagents/child", "nested"])
    await Promise.all([
      rootStore?.addAllow("subagent", parentPattern),
      childStore?.addAllow("subagent", childPattern),
    ])

    const actual = await vi.importActual<typeof import("@dawn-ai/permissions/node")>(
      "@dawn-ai/permissions/node",
    )
    const reloaded = actual.createPermissionsStore({
      appRoot,
      config: undefined,
      mode: "interactive",
    })
    await reloaded.load()
    expect(reloaded.match("subagent", parentPattern)).toBe("allow")
    expect(reloaded.match("subagent", childPattern)).toBe("allow")
    expect(childStore).toBe(rootStore)
    expect(permissionStores).toHaveLength(1)
  })
})

async function fixtureApp(): Promise<string> {
  const appRoot = await mkdtemp(join(tmpdir(), "dawn-subagent-permissions-"))
  tempDirs.push(appRoot)
  const files = {
    "package.json": '{"type":"module"}\n',
    "dawn.config.ts": "export default {}\n",
    "src/app/parent/index.ts": `import child from "./subagents/child/index.js"
import { agent } from "@dawn-ai/sdk"
export default agent({ model: "gpt-5-mini", systemPrompt: "Parent.", subagents: { child } })
`,
    "src/app/parent/subagents/child/index.ts": `import { agent } from "@dawn-ai/sdk"
export default agent({ model: "gpt-5-mini", systemPrompt: "Child." })
`,
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

interface TaskTool {
  readonly name: string
  readonly func: (
    input: { readonly input: string; readonly subagent: string },
    manager: undefined,
    config: RunnableConfig,
  ) => Promise<unknown>
}

function findTaskTool(options: unknown): TaskTool {
  const tools = (options as { readonly tools?: readonly TaskTool[] } | undefined)?.tools
  const task = tools?.find(({ name }) => name === "task")
  if (!task) throw new Error("Expected materialized root task tool")
  return task
}
