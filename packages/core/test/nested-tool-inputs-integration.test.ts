import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"

import { extractToolSchemasForRoute } from "../src/typegen/extract-tool-schema"
import { extractToolTypesForRoute } from "../src/typegen/extract-tool-types"

// End-to-end coverage that a single tool with a deeply nested input flows
// consistently through BOTH real extractors: the JSON-Schema path (what the
// LLM tool-call sees) and the TS-type path (what RouteTools generates for DX).
// Exercises nested objects, arrays-of-objects, Record maps, object unions, and
// optional fields in one fixture.

let tempDir: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "dawn-nested-integration-"))
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

function writeToolFile(dir: string, name: string, content: string): void {
  const toolsDir = join(dir, "tools")
  mkdirSync(toolsDir, { recursive: true })
  writeFileSync(join(toolsDir, `${name}.ts`), content)
}

const NESTED_TOOL = `
/** Search with a structured filter. */
export default async function search(input: {
  filter: { status: "open" | "closed"; tags: string[]; range: { min: number; max: number } }
  meta: Record<string, number>
  action: { kind: "create"; name: string } | { kind: "delete"; id: number }
  limit?: number
}): Promise<{ count: number }> {
  return { count: input.filter.tags.length }
}
`

describe("nested tool inputs — end-to-end through both extractors", () => {
  test("JSON Schema captures nested object, array-of-object, Record, union, optional", async () => {
    const routeDir = join(tempDir, "route")
    writeToolFile(routeDir, "search", NESTED_TOOL)

    const schemas = await extractToolSchemasForRoute({ routeDir, sharedToolsDir: undefined })
    const params = schemas[0]?.parameters
    expect(params).toBeDefined()

    // Nested object with a string-literal enum, array of primitives, and a
    // doubly-nested object.
    const filter = params?.properties.filter
    expect(filter?.type).toBe("object")
    expect(filter?.properties?.status).toEqual({ type: "string", enum: ["open", "closed"] })
    expect(filter?.properties?.tags).toEqual({ type: "array", items: { type: "string" } })
    expect(filter?.properties?.range?.properties?.min).toEqual({ type: "number" })

    // Record<string, number> → additionalProperties schema.
    expect(params?.properties.meta?.additionalProperties).toEqual({ type: "number" })

    // Object union → anyOf.
    expect(params?.properties.action?.anyOf).toHaveLength(2)

    // Optional field omitted from required; required fields present.
    expect(params?.required).toContain("filter")
    expect(params?.required).not.toContain("limit")
  })

  test("TS inputType renders the nested shape in full (no truncation)", async () => {
    const routeDir = join(tempDir, "route")
    writeToolFile(routeDir, "search", NESTED_TOOL)

    const types = await extractToolTypesForRoute({ routeDir, sharedToolsDir: undefined })
    const inputType = types[0]?.inputType ?? ""

    expect(inputType).toContain("filter")
    expect(inputType).toContain("range")
    expect(inputType).toContain("Record<string, number>")
    expect(inputType).toContain("limit?")
    expect(inputType).not.toContain("...")
  })
})
