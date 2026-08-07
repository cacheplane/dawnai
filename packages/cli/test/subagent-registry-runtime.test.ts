import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createAimock, script } from "../../testing/dist/index.js"
import { streamResolvedRoute } from "../src/lib/runtime/execute-route.js"

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

describe("canonical subagent registry route preparation", () => {
  it("dispatches a keyed child under its explicit alias", async () => {
    const app = await fixtureApp({ alias: "analyst" })
    const childInput = "inspect the evidence"
    const mock = await startMock(
      script()
        .user("delegate this")
        .callsTool("task", { subagent: "analyst", input: childInput })
        .replies("Delegation complete.")
        .user(childInput)
        .replies("The evidence is sound.")
        .build(),
    )

    const chunks = await collect(app, "delegate this")

    expect(chunks).toContainEqual(expect.objectContaining({ type: "tool_result", name: "task" }))
    expect(mock.requests()).toHaveLength(3)
  })

  it("does not retain the replaced convention leaf as a dispatch alias", async () => {
    const app = await fixtureApp({ alias: "analyst" })
    const mock = await startMock(script().user("list specialists").replies("Ready.").build())

    await collect(app, "list specialists")

    const task = offeredTask(mock.requests()[0])
    expect(task?.function?.parameters?.properties?.subagent?.enum).toEqual(["analyst"])
    expect(task?.function?.parameters?.properties?.subagent?.enum).not.toContain("researcher")
  })

  it("dispatches a convention-only child through the current bridge", async () => {
    const app = await fixtureApp({})
    const childInput = "inspect by convention"
    const mock = await startMock(
      script()
        .user("delegate conventionally")
        .callsTool("task", { subagent: "researcher", input: childInput })
        .replies("Delegation complete.")
        .user(childInput)
        .replies("Convention dispatch worked.")
        .build(),
    )

    const chunks = await collect(app, "delegate conventionally")

    expect(chunks).toContainEqual(expect.objectContaining({ type: "tool_result", name: "task" }))
    expect(mock.requests()).toHaveLength(3)
  })

  it("omits a statically denied child from the task tool", async () => {
    const app = await fixtureApp({ defaultPolicy: "deny" })
    const mock = await startMock(script().user("list specialists").replies("None.").build())

    await collect(app, "list specialists")

    expect(offeredTask(mock.requests()[0])).toBeUndefined()
  })

  it("fails route preparation with E1004 for an invalid policy", async () => {
    const app = await fixtureApp({ invalidRule: true })

    await expect(collect(app, "delegate this")).rejects.toThrow(/\[DAWN_E1004\]/)
  })
})

interface FixtureOptions {
  readonly alias?: string
  readonly defaultPolicy?: "allow" | "deny" | "approve"
  readonly invalidRule?: boolean
}

async function fixtureApp(options: FixtureOptions): Promise<{
  readonly appRoot: string
  readonly routeFile: string
}> {
  const appRoot = await mkdtemp(join(tmpdir(), "dawn-subagent-registry-"))
  tempDirs.push(appRoot)
  const routeFile = join(appRoot, "src/app/coordinator/index.ts")
  const childImport = options.alias
    ? 'import researcher from "./subagents/researcher/index.js"\n'
    : ""
  const subagents = options.alias ? `subagents: { ${options.alias}: researcher },` : ""
  const delegation = options.invalidRule
    ? 'delegation: { rules: { missing: { action: "allow" } } },'
    : options.defaultPolicy
      ? `delegation: { default: "${options.defaultPolicy}" },`
      : ""

  await writeFiles(appRoot, {
    "package.json": "{}\n",
    "dawn.config.ts": "export default {}\n",
    "src/app/coordinator/index.ts": `${childImport}import { agent } from "@dawn-ai/sdk"
export default agent({
  model: "gpt-5-mini",
  systemPrompt: "Delegate when requested.",
  ${subagents}
  ${delegation}
})
`,
    "src/app/coordinator/subagents/researcher/index.ts": `import { agent } from "@dawn-ai/sdk"
export default agent({
  model: "gpt-5-mini",
  description: "Researches evidence.",
  systemPrompt: "Answer the delegated question.",
})
`,
  })

  return { appRoot, routeFile }
}

async function writeFiles(appRoot: string, files: Readonly<Record<string, string>>): Promise<void> {
  await Promise.all(
    Object.entries(files).map(async ([relativePath, source]) => {
      const filePath = join(appRoot, relativePath)
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, source, "utf8")
    }),
  )
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
  input: string,
): Promise<unknown[]> {
  const chunks: unknown[] = []
  for await (const chunk of streamResolvedRoute({
    appRoot: app.appRoot,
    input: { messages: [{ role: "user", content: input }] },
    routeFile: app.routeFile,
    routeId: "/coordinator#agent",
    routePath: "src/app/coordinator/index.ts",
    threadId: `thread-${Date.now()}-${Math.random()}`,
  })) {
    chunks.push(chunk)
  }
  return chunks
}

function offeredTask(request: unknown):
  | {
      readonly function?: {
        readonly parameters?: {
          readonly properties?: { readonly subagent?: { readonly enum?: readonly string[] } }
        }
      }
    }
  | undefined {
  const tools = (request as { readonly body?: { readonly tools?: readonly unknown[] } } | undefined)
    ?.body?.tools
  return tools?.find(
    (tool): tool is NonNullable<ReturnType<typeof offeredTask>> =>
      (tool as { readonly function?: { readonly name?: string } }).function?.name === "task",
  )
}
