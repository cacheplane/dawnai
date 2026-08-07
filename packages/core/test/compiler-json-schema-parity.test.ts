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
  const { existing, projected } = await parametersFromSource(source)

  expect(existing[0]).toEqual(expected)
  expect(projected).toEqual(existing)
}

async function parametersFromSource(source: string): Promise<{
  readonly existing: readonly ExtractedToolSchema["parameters"][]
  readonly projected: readonly ExtractedToolSchema["parameters"][]
}> {
  const routeDir = join(tempDir, "route")
  const toolsDir = join(routeDir, "tools")
  mkdirSync(toolsDir, { recursive: true })
  writeFileSync(join(toolsDir, "tool.ts"), source)

  const extracted = await extractToolSchemasForRoute({
    routeDir,
    sharedToolsDir: undefined,
  })
  const projected = analyzeRouteTools({ routeDir, sharedToolsDir: undefined }).map((tool) =>
    typeInfoToToolParameters(tool.parameter),
  )
  return { existing: extracted.map((tool) => tool.parameters), projected }
}

describe("compiler-neutral JSON Schema behavior", () => {
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

  test("emits one root property for duplicate compatible intersection members", async () => {
    await compareParameters(
      "export default async function tool(input: { a: string } & { a: string }) { return input }",
      {
        type: "object",
        properties: { a: { type: "string" } },
        required: ["a"],
        additionalProperties: false,
      },
    )
  })

  test("falls back for a conflicting effective root intersection property", async () => {
    await compareParameters(
      "export default async function tool(input: { a: string } & { a: number }) { return input }",
      {
        type: "object",
        properties: { a: { type: "string" } },
        required: ["a"],
        additionalProperties: false,
      },
    )
  })

  test("uses effective semantic requiredness across root intersection declarations", async () => {
    await compareParameters(
      "export default async function tool(input: { a?: string } & { a: string }) { return input }",
      {
        type: "object",
        properties: { a: { type: "string" } },
        required: ["a"],
        additionalProperties: false,
      },
    )
  })

  test("retains fixed properties from a root record intersection", async () => {
    await compareParameters(
      `
export default async function tool(
  input: Record<string, number> & { fixed: string },
) { return input }
`,
      {
        type: "object",
        properties: { fixed: { type: "string" } },
        required: ["fixed"],
        additionalProperties: false,
      },
    )
  })

  test("uses semantic optionality for root Partial properties", async () => {
    await compareParameters(
      "export default async function tool(input: Partial<{ a: string }>) { return input }",
      {
        type: "object",
        properties: { a: { type: "string" } },
        required: [],
        additionalProperties: false,
      },
    )
  })

  test("uses semantic optionality for nested Partial properties", async () => {
    await compareParameters(
      "export default async function tool(input: { nested: Partial<{ a: string }> }) { return input }",
      {
        type: "object",
        properties: {
          nested: {
            type: "object",
            properties: { a: { type: "string" } },
            required: [],
            additionalProperties: false,
          },
        },
        required: ["nested"],
        additionalProperties: false,
      },
    )
  })

  test("uses semantic optionality for root Readonly Partial properties", async () => {
    await compareParameters(
      "export default async function tool(input: Readonly<Partial<{ a: string }>>) { return input }",
      {
        type: "object",
        properties: { a: { type: "string" } },
        required: [],
        additionalProperties: false,
      },
    )
  })

  test("uses semantic optionality for nested Readonly Partial properties", async () => {
    await compareParameters(
      "export default async function tool(input: { nested: Readonly<Partial<{ a: string }>> }) { return input }",
      {
        type: "object",
        properties: {
          nested: {
            type: "object",
            properties: { a: { type: "string" } },
            required: [],
            additionalProperties: false,
          },
        },
        required: ["nested"],
        additionalProperties: false,
      },
    )
  })

  test("uses semantic optionality for mapped optional properties", async () => {
    await compareParameters(
      `
type MappedOptional<T> = { [K in keyof T]?: T[K] }
export default async function tool(input: MappedOptional<{ a: string }>) { return input }
`,
      {
        type: "object",
        properties: { a: { type: "string" } },
        required: [],
        additionalProperties: false,
      },
    )
  })

  test.each([
    ["map", "Map<string, number> & { fixed: string }"],
    ["array", "string[] & { fixed: string }"],
    ["tuple", "[string, number] & { fixed: string }"],
    ["set", "Set<boolean> & { fixed: string }"],
  ])("uses a neutral fallback for a root %s intersection", async (_name, inputType) => {
    await compareParameters(
      `export default async function tool(input: ${inputType}) { return input }`,
      {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
    )
  })
})
