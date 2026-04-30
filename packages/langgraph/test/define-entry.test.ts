import { rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { defineEntry, normalizeRouteModule } from "@dawn-ai/langgraph"
import type { RouteModule } from "@dawn-ai/langgraph/route-module"
import { afterEach, describe, expect, test } from "vitest"

import { createPackedConsumer, runCommand } from "./_helpers/packed-consumer.js"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })))
})

describe("@dawn-ai/langgraph defineEntry", () => {
  test("graph.ts modules can export a native-first entry and route config", () => {
    const graph = () => "graph"
    const module = {
      graph,
      config: {
        runtime: "node",
        streaming: true,
        tags: ["support"],
      },
    } as const

    expect(defineEntry(module)).toBe(module)
    expect(normalizeRouteModule(module)).toEqual({
      kind: "graph",
      entry: graph,
      config: {
        runtime: "node",
        streaming: true,
        tags: ["support"],
      },
    })
  })

  test("workflow.ts modules are accepted as alternative executable route entries", () => {
    const workflow = () => "workflow"
    const module = {
      workflow,
      config: {
        runtime: "node",
        streaming: false,
      },
    } as const

    expect(defineEntry(module)).toBe(module)
    expect(normalizeRouteModule(module)).toEqual({
      kind: "workflow",
      entry: workflow,
      config: {
        runtime: "node",
        streaming: false,
      },
    })
  })

  test("rejects modules that provide both graph and workflow", () => {
    const graph = () => "graph"
    const workflow = () => "workflow"
    // @ts-expect-error - route modules must not expose both executable entries
    const invalidModule: RouteModule<typeof graph> = { graph, workflow }

    expect(() =>
      defineEntry({
        graph,
        workflow,
      } as never),
    ).toThrow(`Route index.ts must export exactly one of "workflow" or "graph"`)

    expect(() => normalizeRouteModule(invalidModule as never)).toThrow(
      `Route index.ts must export exactly one of "workflow" or "graph"`,
    )
  })

  test("rejects modules that provide neither graph nor workflow", () => {
    expect(() => defineEntry({} as never)).toThrow(
      `Route index.ts exports neither "workflow" nor "graph"`,
    )

    expect(() => normalizeRouteModule({} as never)).toThrow(
      `Route index.ts exports neither "workflow" nor "graph"`,
    )
  })

  test("treats explicit-undefined keys as absent when classifying entries", () => {
    const workflow = () => "workflow"
    const graph = () => "graph"

    expect(normalizeRouteModule({ graph: undefined, workflow } as never)).toEqual({
      kind: "workflow",
      entry: workflow,
      config: {},
    })

    expect(normalizeRouteModule({ graph, workflow: undefined } as never)).toEqual({
      kind: "graph",
      entry: graph,
      config: {},
    })

    expect(() => normalizeRouteModule({ graph: undefined, workflow: undefined } as never)).toThrow(
      `Route index.ts exports neither "workflow" nor "graph"`,
    )
  })

  test("packed consumers can import defineEntry from the published root export", {
    timeout: 30_000,
  }, async () => {
    const { consumerDir, tempRoot } = await createPackedConsumer()
    tempDirs.push(tempRoot)
    const scriptPath = join(consumerDir, "entry-check.mjs")

    await writeFile(
      scriptPath,
      [
        'import { defineEntry, normalizeRouteModule } from "@dawn-ai/langgraph";',
        "const graph = () => 'graph';",
        "const entry = defineEntry({ graph, config: { streaming: true } });",
        "const normalized = normalizeRouteModule(entry);",
        "if (normalized.kind !== 'graph' || normalized.config.streaming !== true) {",
        "  throw new Error('packed root export failed');",
        "}",
      ].join("\n"),
    )

    await expect(runCommand("node", [scriptPath], consumerDir)).resolves.toEqual({
      stderr: "",
      stdout: "",
    })
  })
})
