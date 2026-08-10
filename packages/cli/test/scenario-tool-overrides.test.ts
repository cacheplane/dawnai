import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ScenarioToolCallRecord } from "@dawn-ai/sdk/testing"
import { afterEach, describe, expect, it } from "vitest"
import { executeRoute } from "../src/lib/runtime/execute-route.js"
import { applyScenarioToolOverrides } from "../src/lib/runtime/scenario-tool-overrides.js"
import type { DiscoveredToolDefinition } from "../src/lib/runtime/tool-shape.js"

const context = { signal: new AbortController().signal }
const searchSchema = Object.freeze({
  properties: { query: { type: "string" } },
  required: ["query"],
  type: "object",
})
const realSearchRun: DiscoveredToolDefinition["run"] = (input) => {
  const { query } = input as { readonly query: string }
  return `real:${query}`
}
const realSaveRun: DiscoveredToolDefinition["run"] = () => "real:save"
const searchTool = Object.freeze<DiscoveredToolDefinition>({
  description: "Search indexed documents.",
  filePath: "/app/src/app/research/tools/search.ts",
  name: "search",
  run: realSearchRun,
  schema: searchSchema,
  scope: "route-local",
})
const saveTool = Object.freeze<DiscoveredToolDefinition>({
  description: "Save a research note.",
  filePath: "/app/src/tools/save.ts",
  name: "save",
  run: realSaveRun,
  scope: "shared",
})

const fixtureRoots: string[] = []

afterEach(async () => {
  for (const appRoot of fixtureRoots.splice(0).reverse()) {
    await rm(appRoot, { force: true, recursive: true })
  }
})

describe("applyScenarioToolOverrides", () => {
  it("replaces one tool without mutating definitions or changing tool metadata", async () => {
    const tools = Object.freeze([searchTool, saveTool])
    const journal: ScenarioToolCallRecord[] = []
    const input = { query: "Dawn" }

    const result = applyScenarioToolOverrides({
      journal,
      overrides: [
        {
          implementation: async (received) => {
            expect(journal).toEqual([{ args: received, name: "search", sequence: 0 }])
            const { query } = received as { readonly query: string }
            return `mock:${query}`
          },
          name: "search",
        },
      ],
      tools,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.message)

    const mockedSearch = result.tools[0]
    if (!mockedSearch) throw new Error("Expected the search tool")
    expect(result.tools).not.toBe(tools)
    expect(mockedSearch).not.toBe(searchTool)
    expect(result.tools[1]).toBe(saveTool)
    expect(mockedSearch.description).toBe(searchTool.description)
    expect(mockedSearch.filePath).toBe(searchTool.filePath)
    expect(mockedSearch.name).toBe(searchTool.name)
    expect(mockedSearch.schema).toBe(searchTool.schema)
    expect(mockedSearch.scope).toBe(searchTool.scope)
    await expect(Promise.resolve(mockedSearch.run(input, context))).resolves.toBe("mock:Dawn")
    expect(journal).toEqual([{ args: input, name: "search", sequence: 0 }])
    expect(tools).toEqual([searchTool, saveTool])
    expect(searchTool.run).toBe(realSearchRun)
  })

  it("records a call before a mock throws and rethrows the same error", async () => {
    const journal: ScenarioToolCallRecord[] = []
    const input = { query: "failure" }
    const thrown = new Error("mock search failed")
    const result = applyScenarioToolOverrides({
      journal,
      overrides: [
        {
          implementation: (received) => {
            expect(journal).toEqual([{ args: received, name: "search", sequence: 0 }])
            throw thrown
          },
          name: "search",
        },
      ],
      tools: [searchTool],
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.message)

    let caught: unknown
    try {
      await result.tools[0]?.run(input, context)
    } catch (error) {
      caught = error
    }

    expect(caught).toBe(thrown)
    expect(journal).toEqual([{ args: input, name: "search", sequence: 0 }])
    expect(searchTool.run).toBe(realSearchRun)
  })

  it("assigns increasing sequence values across all mocked tools", async () => {
    const journal: ScenarioToolCallRecord[] = []
    const result = applyScenarioToolOverrides({
      journal,
      overrides: [
        { implementation: () => "mock:search", name: "search" },
        { implementation: () => "mock:save", name: "save" },
      ],
      tools: [searchTool, saveTool],
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.message)
    const mockedSearch = result.tools.find((tool) => tool.name === "search")
    const mockedSave = result.tools.find((tool) => tool.name === "save")
    if (!mockedSearch || !mockedSave) throw new Error("Expected both mocked tools")

    await mockedSave.run({ path: "first.md" }, context)
    await mockedSearch.run({ query: "Dawn" }, context)
    await mockedSave.run({ path: "second.md" }, context)

    expect(journal).toEqual([
      { args: { path: "first.md" }, name: "save", sequence: 0 },
      { args: { query: "Dawn" }, name: "search", sequence: 1 },
      { args: { path: "second.md" }, name: "save", sequence: 2 },
    ])
  })

  it("rejects an unknown override and lists available tools in sorted order", () => {
    const alphaTool = Object.freeze({ ...searchTool, name: "alpha" })
    const zetaTool = Object.freeze({ ...saveTool, name: "zeta" })
    const tools = Object.freeze([zetaTool, alphaTool])

    const result = applyScenarioToolOverrides({
      journal: [],
      overrides: [{ implementation: () => undefined, name: "missing" }],
      tools,
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("Expected an unknown-tool failure")
    expect(result.message).toContain('"missing"')
    expect(result.message).toContain("Available tools: alpha, zeta")
    expect(tools).toEqual([zetaTool, alphaTool])
    expect(zetaTool.run).toBe(realSaveRun)
    expect(alphaTool.run).toBe(realSearchRun)
  })
})

describe("scenario tool override route preparation", () => {
  it("does not leak an override or its journal through cached prepared modules", async () => {
    const appRoot = await createFixtureApp()
    const routeFile = join(appRoot, "src/app/research/index.ts")
    const journal: ScenarioToolCallRecord[] = []

    const first = await executeRoute({
      appRoot,
      input: { query: "first" },
      routeFile,
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
    })

    expect(first.status).toBe("passed")
    if (first.status !== "passed") throw new Error(first.error.message)
    expect(first.output).toBe("mock:first")
    expect(journal).toEqual([{ args: { query: "first" }, name: "search", sequence: 0 }])

    const second = await executeRoute({
      appRoot,
      input: { query: "second" },
      routeFile,
    })

    expect(second.status).toBe("passed")
    if (second.status !== "passed") throw new Error(second.error.message)
    expect(second.output).toBe("real:second")
    expect(journal).toEqual([{ args: { query: "first" }, name: "search", sequence: 0 }])
  }, 30_000)
})

async function createFixtureApp(): Promise<string> {
  const appRoot = await mkdtemp(join(tmpdir(), "dawn-scenario-tool-overrides-"))
  fixtureRoots.push(appRoot)
  await mkdir(join(appRoot, "src/app/research/tools"), { recursive: true })
  await writeFile(
    join(appRoot, "package.json"),
    '{ "name": "scenario-tool-overrides-fixture", "type": "module" }\n',
    "utf8",
  )
  await writeFile(join(appRoot, "dawn.config.ts"), "export default {}\n", "utf8")
  await writeFile(
    join(appRoot, "src/app/research/index.ts"),
    [
      "export const workflow = async (input: unknown, context: {",
      "  tools: { search: (value: unknown) => Promise<unknown> },",
      "}) => context.tools.search(input)",
      "",
    ].join("\n"),
    "utf8",
  )
  await writeFile(
    join(appRoot, "src/app/research/tools/search.ts"),
    [
      'export const description = "Search indexed documents."',
      'export const schema = { type: "object" }',
      `export default async (input: { readonly query: string }) => \`real:\${input.query}\``,
      "",
    ].join("\n"),
    "utf8",
  )
  return appRoot
}
