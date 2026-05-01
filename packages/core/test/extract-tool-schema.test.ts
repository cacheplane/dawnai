import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"

import { extractToolSchemasForRoute } from "../src/typegen/extract-tool-schema"

let tempDir: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "dawn-extract-schema-"))
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

function writeToolFile(dir: string, name: string, content: string): void {
  const toolsDir = join(dir, "tools")
  mkdirSync(toolsDir, { recursive: true })
  writeFileSync(join(toolsDir, `${name}.ts`), content)
}

describe("extractToolSchemasForRoute", () => {
  test("extracts full JSON Schema with JSDoc descriptions", async () => {
    const routeDir = join(tempDir, "route")
    writeToolFile(
      routeDir,
      "greet",
      `
/** Greets a user by name */
export default async function greet(input: {
  /** The user's name */
  name: string
  /** Optional greeting prefix */
  prefix?: string
}): Promise<{ message: string }> {
  return { message: (input.prefix ?? "Hello") + " " + input.name }
}
`,
    )

    const result = await extractToolSchemasForRoute({
      routeDir,
      sharedToolsDir: undefined,
    })

    expect(result).toEqual([
      {
        name: "greet",
        description: "Greets a user by name",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "The user's name" },
            prefix: { type: "string", description: "Optional greeting prefix" },
          },
          required: ["name"],
          additionalProperties: false,
        },
      },
    ])
  })

  test("maps number, boolean, and array types correctly", async () => {
    const routeDir = join(tempDir, "route")
    writeToolFile(
      routeDir,
      "process",
      `
/** Processes data */
export default async function process(input: {
  count: number
  enabled: boolean
  tags: string[]
}): Promise<{ ok: boolean }> {
  return { ok: true }
}
`,
    )

    const result = await extractToolSchemasForRoute({
      routeDir,
      sharedToolsDir: undefined,
    })

    expect(result).toEqual([
      {
        name: "process",
        description: "Processes data",
        parameters: {
          type: "object",
          properties: {
            count: { type: "number" },
            enabled: { type: "boolean" },
            tags: { type: "array", items: { type: "string" } },
          },
          required: ["count", "enabled", "tags"],
          additionalProperties: false,
        },
      },
    ])
  })

  test("optional properties are omitted from required", async () => {
    const routeDir = join(tempDir, "route")
    writeToolFile(
      routeDir,
      "search",
      `
/** Searches items */
export default async function search(input: {
  query: string
  limit?: number
  offset?: number
}): Promise<{ results: string[] }> {
  return { results: [] }
}
`,
    )

    const result = await extractToolSchemasForRoute({
      routeDir,
      sharedToolsDir: undefined,
    })

    expect(result[0]?.parameters.required).toEqual(["query"])
  })

  test("string literal unions map to enum", async () => {
    const routeDir = join(tempDir, "route")
    writeToolFile(
      routeDir,
      "sort",
      `
/** Sorts items */
export default async function sort(input: {
  direction: "asc" | "desc"
}): Promise<{ ok: boolean }> {
  return { ok: true }
}
`,
    )

    const result = await extractToolSchemasForRoute({
      routeDir,
      sharedToolsDir: undefined,
    })

    expect(result[0]?.parameters.properties.direction).toEqual({
      type: "string",
      enum: ["asc", "desc"],
    })
  })

  test("no JSDoc gives empty description string and no description key on properties", async () => {
    const routeDir = join(tempDir, "route")
    writeToolFile(
      routeDir,
      "plain",
      `
export default async function plain(input: {
  value: string
}): Promise<{ ok: boolean }> {
  return { ok: true }
}
`,
    )

    const result = await extractToolSchemasForRoute({
      routeDir,
      sharedToolsDir: undefined,
    })

    expect(result[0]?.description).toBe("")
    expect(result[0]?.parameters.properties.value).toEqual({ type: "string" })
    expect("description" in (result[0]?.parameters.properties.value ?? {})).toBe(
      false,
    )
  })

  test("no-parameter tools get empty properties and required", async () => {
    const routeDir = join(tempDir, "route")
    writeToolFile(
      routeDir,
      "ping",
      `
/** Health check */
export default async function ping(): Promise<{ pong: boolean }> {
  return { pong: true }
}
`,
    )

    const result = await extractToolSchemasForRoute({
      routeDir,
      sharedToolsDir: undefined,
    })

    expect(result).toEqual([
      {
        name: "ping",
        description: "Health check",
        parameters: {
          type: "object",
          properties: {},
          required: [],
          additionalProperties: false,
        },
      },
    ])
  })

  test("route-local tools shadow shared tools", async () => {
    const routeDir = join(tempDir, "route")
    const sharedDir = join(tempDir, "shared")

    writeToolFile(
      routeDir,
      "lookup",
      `
/** Local lookup */
export default async function lookup(input: { id: number }): Promise<{ found: boolean }> {
  return { found: true }
}
`,
    )
    writeToolFile(
      sharedDir,
      "lookup",
      `
/** Shared lookup */
export default async function lookup(input: { query: string }): Promise<{ found: boolean }> {
  return { found: true }
}
`,
    )

    const result = await extractToolSchemasForRoute({
      routeDir,
      sharedToolsDir: sharedDir,
    })

    expect(result).toHaveLength(1)
    expect(result[0]?.description).toBe("Local lookup")
    expect(result[0]?.parameters.properties.id).toEqual({ type: "number" })
  })

  test("merges shared and route-local tools", async () => {
    const routeDir = join(tempDir, "route")
    const sharedDir = join(tempDir, "shared")

    writeToolFile(
      routeDir,
      "local-tool",
      `
/** A local tool */
export default async function localTool(input: { x: string }): Promise<{ y: string }> {
  return { y: input.x }
}
`,
    )
    writeToolFile(
      sharedDir,
      "shared-tool",
      `
/** A shared tool */
export default async function sharedTool(input: { a: number }): Promise<{ b: number }> {
  return { b: input.a }
}
`,
    )

    const result = await extractToolSchemasForRoute({
      routeDir,
      sharedToolsDir: sharedDir,
    })

    expect(result).toHaveLength(2)
    expect(result[0]?.name).toBe("local-tool")
    expect(result[1]?.name).toBe("shared-tool")
  })
})
