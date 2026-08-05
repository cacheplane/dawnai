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

function normalizeCompilerSymbolIds(value: unknown): unknown {
  if (typeof value === "string") return value.replace(/__@([^@]+)@\d+/g, "__@$1")
  if (Array.isArray(value)) return value.map(normalizeCompilerSymbolIds)
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key.replace(/__@([^@]+)@\d+/g, "__@$1"),
        normalizeCompilerSymbolIds(entry),
      ]),
    )
  }
  return value
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

  test("preserves legacy optionality across root intersection declarations", async () => {
    await compareParameters(
      "export default async function tool(input: { a?: string } & { a: string }) { return input }",
      {
        type: "object",
        properties: { a: { type: "string" } },
        required: [],
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

  test("preserves legacy parameters for a root map intersection", async () => {
    const { existing, projected } = await parametersFromSource(
      "export default async function tool(input: Map<string, number> & { fixed: string }) { return input }",
    )

    expect(existing[0]?.properties.fixed).toEqual({ type: "string" })
    expect(normalizeCompilerSymbolIds(projected)).toEqual(normalizeCompilerSymbolIds(existing))
  })

  test("preserves legacy requiredness for root Partial properties", async () => {
    await compareParameters(
      "export default async function tool(input: Partial<{ a: string }>) { return input }",
      {
        type: "object",
        properties: { a: { type: "string" } },
        required: ["a"],
        additionalProperties: false,
      },
    )
  })

  test("preserves legacy requiredness for nested Partial properties", async () => {
    await compareParameters(
      "export default async function tool(input: { nested: Partial<{ a: string }> }) { return input }",
      {
        type: "object",
        properties: {
          nested: {
            type: "object",
            properties: { a: { type: "string" } },
            required: ["a"],
            additionalProperties: false,
          },
        },
        required: ["nested"],
        additionalProperties: false,
      },
    )
  })

  test("preserves legacy requiredness for root Readonly Partial properties", async () => {
    await compareParameters(
      "export default async function tool(input: Readonly<Partial<{ a: string }>>) { return input }",
      {
        type: "object",
        properties: { a: { type: "string" } },
        required: ["a"],
        additionalProperties: false,
      },
    )
  })

  test("preserves legacy requiredness for nested Readonly Partial properties", async () => {
    await compareParameters(
      "export default async function tool(input: { nested: Readonly<Partial<{ a: string }>> }) { return input }",
      {
        type: "object",
        properties: {
          nested: {
            type: "object",
            properties: { a: { type: "string" } },
            required: ["a"],
            additionalProperties: false,
          },
        },
        required: ["nested"],
        additionalProperties: false,
      },
    )
  })

  test("preserves legacy requiredness for mapped optional properties", async () => {
    await compareParameters(
      `
type MappedOptional<T> = { [K in keyof T]?: T[K] }
export default async function tool(input: MappedOptional<{ a: string }>) { return input }
`,
      {
        type: "object",
        properties: { a: { type: "string" } },
        required: ["a"],
        additionalProperties: false,
      },
    )
  })

  test.each([
    ["array", "string[] & { fixed: string }"],
    ["tuple", "[string, number] & { fixed: string }"],
  ])("preserves legacy parameters for a root %s intersection", async (_name, inputType) => {
    const { existing, projected } = await parametersFromSource(
      `export default async function tool(input: ${inputType}) { return input }`,
    )

    expect(existing[0]?.properties.fixed).toEqual({ type: "string" })
    expect(normalizeCompilerSymbolIds(projected)).toEqual(normalizeCompilerSymbolIds(existing))
  })
})
