import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { afterEach, beforeEach, describe, expect, test } from "vitest"

import { createAimock, script } from "../../testing/dist/index.js"
import { run } from "../src/index.js"

const SDK_TESTING_URL = pathToFileURL(
  resolve(import.meta.dirname, "../../sdk/dist/testing/index.js"),
).href
const REAL_SEARCH_CALLS = "__dawnScenarioRealSearchCalls"
const CHILD_LOOKUP_CALLS = "__dawnScenarioChildLookupCalls"

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
  delete (globalThis as Record<string, unknown>)[REAL_SEARCH_CALLS]
  delete (globalThis as Record<string, unknown>)[CHILD_LOOKUP_CALLS]
  if (previousBaseUrl === undefined) delete process.env.OPENAI_BASE_URL
  else process.env.OPENAI_BASE_URL = previousBaseUrl
  if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY
  else process.env.OPENAI_API_KEY = previousApiKey
})

describe("scenario tool mocking for agents", () => {
  test("runs an agent with a mocked application tool", async () => {
    const userInput = "research Dawn"
    const aimock = await startAimock(
      script()
        .user(userInput)
        .callsTool("searchWeb", { query: "Dawn" })
        .replies("The mocked search result was received.")
        .build(),
    )
    const appRoot = await createFixtureApp({
      "src/app/research/index.ts": `import { agent } from "@dawn-ai/sdk"

export default agent({
  model: "gpt-5-mini",
  systemPrompt: "Search the web before answering.",
})
`,
      "src/app/research/run.test.ts": `import { scenarios } from ${JSON.stringify(SDK_TESTING_URL)}

export default scenarios("/research").scenario("mocked search passes", (s) =>
  s
    .input({ messages: [{ role: "user", content: ${JSON.stringify(userInput)} }] })
    .mockTool("searchWeb", async ({ query }: { query: string }) => ({
      result: "mock-result:" + query,
    }))
    .expectPassed()
    .expectTool("searchWeb", (call) => call.calledOnce()),
)
`,
      "src/app/research/tools/searchWeb.ts": `export default async (_input: { query: string }) => {
  const key = ${JSON.stringify(REAL_SEARCH_CALLS)}
  const values = globalThis as Record<string, unknown>
  values[key] = (typeof values[key] === "number" ? values[key] : 0) + 1
  throw new Error("real searchWeb implementation must not run")
}
`,
    })

    const result = await invoke(["test", "--cwd", appRoot], appRoot)

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    expect(result.stdout).toContain("PASS mocked search passes")
    expect(result.stdout).toContain("Summary: 1 passed, 0 failed")
    expect((globalThis as Record<string, unknown>)[REAL_SEARCH_CALLS] ?? 0).toBe(0)
    expect(JSON.stringify(aimock.getRequests())).toContain("mock-result:Dawn")
  }, 30_000)

  test("does not propagate a parent mock to a same-name subagent tool", async () => {
    const parentInput = "delegate the lookup"
    const childInput = "look up the Dawn record"
    const aimock = await startAimock(
      script()
        .user(parentInput)
        .callsTool("task", { input: childInput, subagent: "researcher" })
        .replies("The delegated lookup is complete.")
        .user(childInput)
        .callsTool("lookup", { key: "dawn" })
        .replies("The child lookup is complete.")
        .build(),
    )
    const appRoot = await createFixtureApp({
      "src/app/coordinator/index.ts": `import { agent } from "@dawn-ai/sdk"

export default agent({
  model: "gpt-5-mini",
  systemPrompt: "Delegate lookup requests to the researcher.",
})
`,
      "src/app/coordinator/run.test.ts": `import { scenarios } from ${JSON.stringify(SDK_TESTING_URL)}

export default scenarios("/coordinator").scenario("parent mock stays isolated", (s) =>
  s
    .input({ messages: [{ role: "user", content: ${JSON.stringify(parentInput)} }] })
    .mockTool("lookup", async () => ({ source: "parent-mock" }))
    .expectPassed()
    .expectTool("lookup", (call) => call.notCalled()),
)
`,
      "src/app/coordinator/tools/lookup.ts": `export default async (_input: { key: string }) => ({
  source: "parent-real",
})
`,
      "src/app/coordinator/subagents/researcher/index.ts": `import { agent } from "@dawn-ai/sdk"

export default agent({
  model: "gpt-5-mini",
  description: "Looks up records.",
  systemPrompt: "Use lookup to answer the delegated request.",
})
`,
      "src/app/coordinator/subagents/researcher/tools/lookup.ts": `export default async ({ key }: { key: string }) => {
  const marker = ${JSON.stringify(CHILD_LOOKUP_CALLS)}
  const values = globalThis as Record<string, unknown>
  values[marker] = (typeof values[marker] === "number" ? values[marker] : 0) + 1
  return { source: "child-real", value: "child-real:" + key }
}
`,
    })

    const result = await invoke(["test", "--cwd", appRoot], appRoot)

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    expect(result.stdout).toContain("PASS parent mock stays isolated")
    expect(result.stdout).toContain("Summary: 1 passed, 0 failed")
    expect((globalThis as Record<string, unknown>)[CHILD_LOOKUP_CALLS]).toBe(1)
    expect(JSON.stringify(aimock.getRequests())).toContain("child-real:dawn")
  }, 30_000)
})

async function createFixtureApp(files: Readonly<Record<string, string>>): Promise<string> {
  const appRoot = await mkdtemp(join(tmpdir(), "dawn-scenario-agent-mocking-"))
  tempDirs.push(appRoot)
  const allFiles = {
    "package.json": '{ "type": "module" }\n',
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

async function startAimock(fixtures: Parameters<typeof createAimock>[0]["fixtures"]) {
  const mock = await createAimock({ fixtures })
  mocks.push(mock)
  process.env.OPENAI_BASE_URL = mock.baseUrl
  process.env.OPENAI_API_KEY = "test-not-used"
  return mock
}

async function invoke(argv: readonly string[], cwd: string) {
  const stdout: string[] = []
  const stderr: string[] = []
  const previousCwd = process.cwd()
  process.chdir(cwd)

  try {
    const exitCode = await run([...argv], {
      stderr: (message: string) => stderr.push(message),
      stdout: (message: string) => stdout.push(message),
    })
    return { exitCode, stderr: stderr.join(""), stdout: stdout.join("") }
  } finally {
    process.chdir(previousCwd)
  }
}
