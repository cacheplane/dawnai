import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

import { materializeResolvedRouteGraph } from "../src/lib/runtime/execute-route.js"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })))
  vi.doUnmock("@langchain/langgraph/prebuilt")
  vi.doUnmock("@langchain/openai")
})

describe("subagent sandbox preparation", () => {
  it("resolves sandbox-bound tools with the supplied root sandbox key", async () => {
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
    vi.doMock("@langchain/langgraph/prebuilt", () => ({
      createReactAgent: vi.fn(() => ({ invoke: vi.fn() })),
    }))
    vi.doMock("@langchain/openai", () => ({ ChatOpenAI: class {} }))

    await materializeResolvedRouteGraph({
      appRoot,
      routeFile: join(appRoot, "src/app/parent/index.ts"),
      routeId: "/parent",
      routePath: "src/app/parent/index.ts",
      sandboxManager: { getForThread } as never,
      sandboxThreadId: "sandbox-root",
    })

    expect(getForThread).toHaveBeenCalledWith("sandbox-root", expect.any(AbortSignal))
  })
})

async function fixtureApp(): Promise<string> {
  const appRoot = await mkdtemp(join(tmpdir(), "dawn-subagent-sandbox-"))
  tempDirs.push(appRoot)
  const files = {
    "package.json": '{"type":"module"}\n',
    "dawn.config.ts": "export default {}\n",
    "src/app/parent/index.ts": `import { agent } from "@dawn-ai/sdk"\nexport default agent({ model: "gpt-5-mini", systemPrompt: "Parent." })\n`,
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
