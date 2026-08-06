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

  it("materializes capabilities and lazy subagents without a root checkpointer", async () => {
    const createReactAgent = vi.fn((options: unknown) => ({ invoke: vi.fn(), options }))
    vi.doMock("@langchain/langgraph/prebuilt", () => ({ createReactAgent }))
    vi.doMock("@langchain/openai", () => ({ ChatOpenAI: class {} }))
    const appRoot = await fixtureApp({ child: true })

    await materializeResolvedRouteGraph({
      appRoot,
      routeFile: join(appRoot, "src/app/parent/index.ts"),
      routeId: "/parent",
      routePath: "src/app/parent/index.ts",
    })

    expect(createReactAgent).toHaveBeenCalledTimes(1)
    const options = createReactAgent.mock.calls[0]?.[0] as {
      readonly checkpointer?: unknown
      readonly tools?: readonly { readonly name: string }[]
    }
    expect(options.checkpointer).toBeUndefined()
    expect(options.tools?.map(({ name }) => name)).toContain("task")
  })
})

async function fixtureApp(options: {
  readonly child?: boolean
  readonly parentBody?: string
}): Promise<string> {
  const appRoot = await mkdtemp(join(tmpdir(), "dawn-execute-route-"))
  tempDirs.push(appRoot)
  const files: Record<string, string> = {
    "package.json": '{"type":"module"}\n',
    "dawn.config.ts": "export default {}\n",
    "src/app/parent/index.ts": `import { agent } from "@dawn-ai/sdk"
export default agent({ model: "gpt-5-mini", systemPrompt: "Parent.", ${options.parentBody ?? ""} } as any)
`,
  }
  if (options.child) {
    files["src/app/parent/subagents/researcher/index.ts"] = `import { agent } from "@dawn-ai/sdk"
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
