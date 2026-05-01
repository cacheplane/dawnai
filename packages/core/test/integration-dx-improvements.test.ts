import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"

import { extractToolSchemasForRoute } from "../src/typegen/extract-tool-schema"
import { extractToolTypesForRoute } from "../src/typegen/extract-tool-types"

let tempDir: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "dawn-dx-integration-"))
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

describe("DX improvements integration", () => {
  test("tool schema generation produces valid JSON Schema for LLM", async () => {
    const routeDir = join(tempDir, "route")
    const toolsDir = join(routeDir, "tools")
    mkdirSync(toolsDir, { recursive: true })

    writeFileSync(
      join(toolsDir, "search.ts"),
      `
/**
 * Searches the knowledge base for relevant documents.
 */
export default async (input: {
  /** The search query string */
  query: string
  /** Maximum number of results */
  limit?: number
  /** Filter by category */
  category: "docs" | "code" | "issues"
}) => {
  return { results: [], total: 0 }
}
`,
    )

    const schemas = await extractToolSchemasForRoute({
      routeDir,
      sharedToolsDir: undefined,
    })

    expect(schemas).toHaveLength(1)
    const schema = schemas[0]!

    expect(schema.name).toBe("search")
    expect(schema.description).toBe("Searches the knowledge base for relevant documents.")
    expect(schema.parameters.type).toBe("object")
    expect(schema.parameters.additionalProperties).toBe(false)
    expect(schema.parameters.properties.query).toEqual({
      type: "string",
      description: "The search query string",
    })
    expect(schema.parameters.properties.limit).toEqual({
      type: "number",
      description: "Maximum number of results",
    })
    expect(schema.parameters.properties.category).toEqual({
      type: "string",
      enum: ["docs", "code", "issues"],
      description: "Filter by category",
    })
    expect(schema.parameters.required).toEqual(["query", "category"])
  })

  test("type extraction and schema extraction produce consistent results", async () => {
    const routeDir = join(tempDir, "route")
    const toolsDir = join(routeDir, "tools")
    mkdirSync(toolsDir, { recursive: true })

    writeFileSync(
      join(toolsDir, "greet.ts"),
      `
/** Greets someone. */
export default async (input: { name: string }) => {
  return { message: "hello" }
}
`,
    )

    const types = await extractToolTypesForRoute({
      routeDir,
      sharedToolsDir: undefined,
    })
    const schemas = await extractToolSchemasForRoute({
      routeDir,
      sharedToolsDir: undefined,
    })

    expect(types).toHaveLength(1)
    expect(schemas).toHaveLength(1)
    expect(types[0]!.name).toBe(schemas[0]!.name)
    expect(types[0]!.description).toBe(schemas[0]!.description)
  })
})
