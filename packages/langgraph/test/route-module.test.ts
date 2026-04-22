import { readFileSync } from "node:fs"
import { rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { normalizeRouteModule } from "@dawn/langgraph"
import type {
  GraphRouteModule,
  RouteModule,
  WorkflowRouteModule,
} from "@dawn/langgraph/route-module"
import { afterEach, describe, expect, test } from "vitest"

import { createPackedConsumer, runCommand } from "./_helpers/packed-consumer.js"

const packageRoot = resolve(import.meta.dirname, "..")
const packageJsonPath = join(packageRoot, "package.json")
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })))
})

describe("@dawn/langgraph route-module", () => {
  test("exposes publishable exports and types on the package surface", () => {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      readonly exports: Record<string, { readonly types: string; readonly default: string }>
      readonly types: string
    }

    expect(packageJson.types).toBe("./dist/index.d.ts")
    expect(packageJson.exports["."]?.types).toBe("./dist/index.d.ts")
    expect(packageJson.exports["."]?.default).toBe("./dist/index.js")
    expect(packageJson.exports["./route-module"]?.types).toBe("./dist/route-module.d.ts")
  })

  test("exposes types and helpers that core and template apps can consume without a second runtime", () => {
    const graph = () => "graph"
    const workflow = () => "workflow"

    const graphModule = {
      graph,
      config: {
        runtime: "node",
      },
    } satisfies GraphRouteModule<typeof graph>

    const workflowModule = {
      workflow,
      config: {
        streaming: true,
      },
    } satisfies WorkflowRouteModule<typeof workflow>

    const normalizedGraph = normalizeRouteModule(graphModule satisfies RouteModule<typeof graph>)
    const normalizedWorkflow = normalizeRouteModule(
      workflowModule satisfies RouteModule<typeof workflow>,
    )

    expect(normalizedGraph.kind).toBe("graph")
    expect(normalizedWorkflow.kind).toBe("workflow")
  })

  test("packed consumers can resolve the route-module subpath export", {
    timeout: 30_000,
  }, async () => {
    const { consumerDir, tempRoot } = await createPackedConsumer()
    tempDirs.push(tempRoot)
    const scriptPath = join(consumerDir, "route-module-check.mjs")

    await writeFile(
      scriptPath,
      [
        'import { normalizeRouteModule } from "@dawn/langgraph/route-module";',
        "const workflow = () => 'workflow';",
        "const normalized = normalizeRouteModule({ workflow, config: { runtime: 'node' } });",
        "if (normalized.kind !== 'workflow' || normalized.config.runtime !== 'node') {",
        "  throw new Error('packed subpath export failed');",
        "}",
      ].join("\n"),
    )

    await expect(runCommand("node", [scriptPath], consumerDir)).resolves.toEqual({
      stderr: "",
      stdout: "",
    })
  })
})
