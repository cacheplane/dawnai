import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"

import { analyzeRouteTools, typeInfoToToolParameters } from "../src/compiler/index.ts"
import { extractToolSchemasForRoute } from "../src/typegen/extract-tool-schema.ts"
import type { ExtractedToolSchema } from "../src/types.ts"

let tempDir: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "dawn-schema-parity-"))
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

async function compareParameters(
  source: string,
  expected: ExtractedToolSchema["parameters"],
): Promise<void> {
  const routeDir = join(tempDir, "route")
  const toolsDir = join(routeDir, "tools")
  mkdirSync(toolsDir, { recursive: true })
  writeFileSync(join(toolsDir, "tool.ts"), source)

  const existing = await extractToolSchemasForRoute({
    routeDir,
    sharedToolsDir: undefined,
  })
  const projected = analyzeRouteTools({ routeDir, sharedToolsDir: undefined }).map((tool) =>
    typeInfoToToolParameters(tool.parameter),
  )

  expect(existing[0]?.parameters).toEqual(expected)
  expect(projected).toEqual(existing.map((tool) => tool.parameters))
}

describe("compiler-neutral JSON Schema parity", () => {
  test("keeps a top-level optional object parameter empty", async () => {
    await compareParameters(
      "export default async function tool(input?: { id: string }) { return input }",
      {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
    )
  })

  test("keeps a nested all-object intersection unsupported", async () => {
    await compareParameters(
      `
export default async function tool(input: {
  value: { a: string } & { b: number }
}) { return input }
`,
      {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
    )
  })

  test("combines an all-object intersection at the root", async () => {
    await compareParameters(
      `
export default async function tool(input: { a: string } & { b: number }) {
  return input
}
`,
      {
        type: "object",
        properties: {
          a: { type: "string" },
          b: { type: "number" },
        },
        required: ["a", "b"],
        additionalProperties: false,
      },
    )
  })
})
