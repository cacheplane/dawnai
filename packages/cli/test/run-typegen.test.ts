import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import * as compiler from "@dawn-ai/core/internal/compiler"
import { discoverRoutes } from "@dawn-ai/core/node"
import { afterEach, describe, expect, test, vi } from "vitest"

import { runTypegen } from "../src/lib/typegen/run-typegen.js"

const tempDirs: string[] = []
const originalCwd = process.cwd()

afterEach(async () => {
  vi.restoreAllMocks()
  process.chdir(originalCwd)
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })))
})

async function createFile(filePath: string, content: string) {
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, content)
}

async function setupApp(options?: { withState?: boolean }) {
  const appRoot = await mkdtemp(join(tmpdir(), "dawn-typegen-"))
  tempDirs.push(appRoot)

  const routeDir = join(appRoot, "src", "app", "hello", "[tenant]")
  const toolsDir = join(routeDir, "tools")

  await Promise.all([
    createFile(join(appRoot, "package.json"), '{"type":"module"}'),
    createFile(join(appRoot, "dawn.config.ts"), "export default {};\n"),
    createFile(join(routeDir, "index.ts"), "export const agent = async () => ({});\n"),
    createFile(
      join(toolsDir, "greet.ts"),
      '/** Greets the tenant. */\nexport default async (input: { name: string }) => ({ message: "hi" })\n',
    ),
  ])

  if (options?.withState) {
    await createFile(
      join(routeDir, "state.ts"),
      'export default { "~standard": { validate: () => ({ value: { context: "" } }) } };\n',
    )
  }

  return { appRoot, routeDir }
}

describe("runTypegen", () => {
  test("writes types and schemas from one combined route analysis", async () => {
    const { appRoot } = await setupApp()
    const manifest = await discoverRoutes({ appRoot })
    const extractArtifacts = vi.spyOn(compiler, "extractToolArtifactsForRoute")

    const result = await runTypegen({ appRoot, manifest })

    expect(result.routeCount).toBe(1)
    expect(result.toolSchemaCount).toBe(1)
    expect(extractArtifacts).toHaveBeenCalledTimes(1)

    const dtsPath = join(appRoot, ".dawn", "dawn.generated.d.ts")
    const scenarioDtsPath = join(appRoot, ".dawn", "scenarios.generated.d.ts")
    expect(existsSync(dtsPath)).toBe(true)
    expect(existsSync(scenarioDtsPath)).toBe(true)

    const content = await readFile(dtsPath, "utf8")
    expect(content).toContain("DawnRoutePath")
    expect(content).toContain("greet")

    const scenarioContent = await readFile(scenarioDtsPath, "utf8")
    expect(scenarioContent).toContain('import "@dawn-ai/sdk/testing"')
    expect(scenarioContent).toContain('"/hello/[tenant]"')
    expect(scenarioContent).toContain('readonly "greet"')

    const toolsJsonPath = join(appRoot, ".dawn", "routes", "hello-tenant", "tools.json")
    const toolsJson = JSON.parse(await readFile(toolsJsonPath, "utf8"))
    expect(toolsJson.greet.description).toBe("Greets the tenant.")
    expect(toolsJson.greet.parameters.properties.name.type).toBe("string")
  })

  test("writes tools.json for each route", async () => {
    const { appRoot } = await setupApp()
    const manifest = await discoverRoutes({ appRoot })

    await runTypegen({ appRoot, manifest })

    const toolsJsonPath = join(appRoot, ".dawn", "routes", "hello-tenant", "tools.json")
    expect(existsSync(toolsJsonPath)).toBe(true)

    const toolsJson = JSON.parse(await readFile(toolsJsonPath, "utf8"))
    expect(toolsJson.greet).toBeDefined()
    expect(toolsJson.greet.description).toBe("Greets the tenant.")
    expect(toolsJson.greet.parameters.properties.name.type).toBe("string")
  })

  test("skips state.json when no state.ts", async () => {
    const { appRoot } = await setupApp({ withState: false })
    const manifest = await discoverRoutes({ appRoot })

    const result = await runTypegen({ appRoot, manifest })

    expect(result.stateRouteCount).toBe(0)

    const stateJsonPath = join(appRoot, ".dawn", "routes", "hello-tenant", "state.json")
    expect(existsSync(stateJsonPath)).toBe(false)
  })

  test("includes writeTodos in generated types when plan.md exists", async () => {
    const { appRoot, routeDir } = await setupApp()
    await createFile(join(routeDir, "plan.md"), "# Plan\n\nDo the thing.\n")

    const manifest = await discoverRoutes({ appRoot })
    await runTypegen({ appRoot, manifest })

    const dtsPath = join(appRoot, ".dawn", "dawn.generated.d.ts")
    const content = await readFile(dtsPath, "utf8")

    expect(content).toContain("writeTodos")
    expect(content).toContain('"pending"')
    expect(content).toContain('"in_progress"')
    expect(content).toContain('"completed"')
    // Existing user tool still present alongside the capability-contributed one
    expect(content).toContain("greet")

    const scenarioContent = await readFile(
      join(appRoot, ".dawn", "scenarios.generated.d.ts"),
      "utf8",
    )
    expect(scenarioContent).not.toContain("writeTodos")
  })

  test("omits writeTodos when plan.md is absent", async () => {
    const { appRoot } = await setupApp()
    const manifest = await discoverRoutes({ appRoot })
    await runTypegen({ appRoot, manifest })

    const dtsPath = join(appRoot, ".dawn", "dawn.generated.d.ts")
    const content = await readFile(dtsPath, "utf8")

    expect(content).not.toContain("writeTodos")
  })

  test("includes task tool in generated types when subagents/<name>/index.ts exists", async () => {
    const { appRoot, routeDir } = await setupApp()
    await createFile(
      join(routeDir, "subagents", "research", "index.ts"),
      "export const agent = async () => ({});\n",
    )

    const manifest = await discoverRoutes({ appRoot })
    await runTypegen({ appRoot, manifest })

    const dtsPath = join(appRoot, ".dawn", "dawn.generated.d.ts")
    const content = await readFile(dtsPath, "utf8")

    expect(content).toContain("task")
    expect(content).toContain("subagent: string")
    expect(content).toContain("greet")

    const scenarioContent = await readFile(
      join(appRoot, ".dawn", "scenarios.generated.d.ts"),
      "utf8",
    )
    expect(scenarioContent).not.toContain("task")
  })

  test("omits task tool when subagents/ is absent or empty", async () => {
    const { appRoot, routeDir } = await setupApp()
    // Create an empty subagents/ directory — should NOT trigger the task tool
    await mkdir(join(routeDir, "subagents"), { recursive: true })

    const manifest = await discoverRoutes({ appRoot })
    await runTypegen({ appRoot, manifest })

    const dtsPath = join(appRoot, ".dawn", "dawn.generated.d.ts")
    const content = await readFile(dtsPath, "utf8")

    expect(content).not.toContain("Dispatch a sub-task")
  })

  test("includes workspace tools in generated types when workspace/ directory exists", async () => {
    const { appRoot } = await setupApp()
    await mkdir(join(appRoot, "workspace"), { recursive: true })
    process.chdir(appRoot)

    const manifest = await discoverRoutes({ appRoot })
    await runTypegen({ appRoot, manifest })

    const dtsPath = join(appRoot, ".dawn", "dawn.generated.d.ts")
    const content = await readFile(dtsPath, "utf8")

    expect(content).toContain("readFile")
    expect(content).toContain("writeFile")
    expect(content).toContain("listDir")
    expect(content).toContain("runBash")
    expect(content).toContain("greet")

    const scenarioContent = await readFile(
      join(appRoot, ".dawn", "scenarios.generated.d.ts"),
      "utf8",
    )
    expect(scenarioContent).not.toContain("readFile")
  })

  test("omits workspace tools when workspace/ directory is absent", async () => {
    const { appRoot } = await setupApp()
    process.chdir(appRoot)
    const manifest = await discoverRoutes({ appRoot })
    await runTypegen({ appRoot, manifest })

    const dtsPath = join(appRoot, ".dawn", "dawn.generated.d.ts")
    const content = await readFile(dtsPath, "utf8")

    expect(content).not.toContain("Read a UTF-8 file from the workspace")
    expect(content).not.toContain("Write a UTF-8 file inside the workspace")
    expect(content).not.toContain("List entries in a workspace directory")
    expect(content).not.toContain("Run a shell command inside the workspace")
  })

  test("includes remember and recall tools in generated types when memory.ts exists", async () => {
    const { appRoot, routeDir } = await setupApp()
    await createFile(
      join(routeDir, "memory.ts"),
      [
        'import { defineMemory } from "@dawn-ai/sdk"',
        'import { z } from "zod"',
        "export default defineMemory({",
        '  kind: "semantic",',
        '  scope: ["route"],',
        "  schema: z.object({ subject: z.string(), predicate: z.string(), value: z.string() }),",
        "})",
        "",
      ].join("\n"),
    )

    const manifest = await discoverRoutes({ appRoot })
    await runTypegen({ appRoot, manifest })

    const dtsPath = join(appRoot, ".dawn", "dawn.generated.d.ts")
    const content = await readFile(dtsPath, "utf8")

    expect(content).toContain("remember")
    expect(content).toContain("recall")
    expect(content).toContain(
      'data: import("zod").infer<(typeof import("../src/app/hello/[tenant]/memory").default)["schema"]>',
    )
    expect(content).not.toContain("data: Record<string, unknown>")
    // Existing user tool still present alongside the capability-contributed ones
    expect(content).toContain("greet")

    const scenarioContent = await readFile(
      join(appRoot, ".dawn", "scenarios.generated.d.ts"),
      "utf8",
    )
    expect(scenarioContent).not.toContain("remember")
    expect(scenarioContent).not.toContain("recall")
  })

  test("omits remember and recall tools when memory.ts is absent", async () => {
    const { appRoot } = await setupApp()
    const manifest = await discoverRoutes({ appRoot })
    await runTypegen({ appRoot, manifest })

    const dtsPath = join(appRoot, ".dawn", "dawn.generated.d.ts")
    const content = await readFile(dtsPath, "utf8")

    expect(content).not.toContain("Store a typed long-term memory")
    expect(content).not.toContain("Recall typed long-term memories")
  })

  test("writes state.json when state.ts exists", async () => {
    const { appRoot } = await setupApp({ withState: true })
    const manifest = await discoverRoutes({ appRoot })

    const result = await runTypegen({ appRoot, manifest })

    expect(result.stateRouteCount).toBe(1)

    const stateJsonPath = join(appRoot, ".dawn", "routes", "hello-tenant", "state.json")
    expect(existsSync(stateJsonPath)).toBe(true)

    const stateJson = JSON.parse(await readFile(stateJsonPath, "utf8"))
    expect(stateJson).toEqual([{ name: "context", reducer: "replace", default: "" }])
  })
})
