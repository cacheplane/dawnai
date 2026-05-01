import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"

import { discoverRoutes } from "@dawn-ai/core"

import { runTypegen } from "../src/lib/typegen/run-typegen.js"

const tempDirs: string[] = []

afterEach(async () => {
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
    createFile(
      join(routeDir, "index.ts"),
      "export const agent = async () => ({});\n",
    ),
    createFile(
      join(toolsDir, "greet.ts"),
      "/** Greets the tenant. */\nexport default async (input: { name: string }) => ({ message: \"hi\" })\n",
    ),
  ])

  if (options?.withState) {
    await createFile(
      join(routeDir, "state.ts"),
      "export default { \"~standard\": { validate: () => ({ value: { context: \"\" } }) } };\n",
    )
  }

  return { appRoot, routeDir }
}

describe("runTypegen", () => {
  test("writes dawn.generated.d.ts with tool types", async () => {
    const { appRoot } = await setupApp()
    const manifest = await discoverRoutes({ appRoot })

    const result = await runTypegen({ appRoot, manifest })

    expect(result.routeCount).toBe(1)
    expect(result.toolSchemaCount).toBe(1)

    const dtsPath = join(appRoot, ".dawn", "dawn.generated.d.ts")
    expect(existsSync(dtsPath)).toBe(true)

    const content = await readFile(dtsPath, "utf8")
    expect(content).toContain("DawnRoutePath")
    expect(content).toContain("greet")
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

  test("writes state.json when state.ts exists", async () => {
    const { appRoot } = await setupApp({ withState: true })
    const manifest = await discoverRoutes({ appRoot })

    const result = await runTypegen({ appRoot, manifest })

    expect(result.stateRouteCount).toBe(1)

    const stateJsonPath = join(appRoot, ".dawn", "routes", "hello-tenant", "state.json")
    expect(existsSync(stateJsonPath)).toBe(true)

    const stateJson = JSON.parse(await readFile(stateJsonPath, "utf8"))
    expect(stateJson).toEqual([
      { name: "context", reducer: "replace", default: "" },
    ])
  })
})
