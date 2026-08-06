import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import ts from "typescript"
import { afterEach, beforeEach, describe, expect, test } from "vitest"

import { createAnalyzeRouteTools } from "../src/compiler/analyze-route-tools.ts"
import { analyzeRouteTools as analyzeRouteToolsProduction } from "../src/compiler/index.ts"
import { createAnalyzeToolFiles } from "../src/compiler/typescript-backend.ts"

let tempDir: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "dawn-route-analysis-"))
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

function writeToolFile(directory: string, name: string, source: string): void {
  const toolsDirectory = join(directory, "tools")
  mkdirSync(toolsDirectory, { recursive: true })
  writeFileSync(join(toolsDirectory, `${name}.ts`), source)
}

describe("analyzeRouteTools", () => {
  test("analyzes the effective sorted tool set with one compiler program", () => {
    const routeDir = join(tempDir, "route")
    const sharedToolsDir = join(tempDir, "shared")

    writeToolFile(
      sharedToolsDir,
      "lookup",
      `
/** Shared lookup. */
export default async function lookup(input: { query: string }): Promise<{ shared: true }> {
  return { shared: true }
}
`,
    )
    writeToolFile(
      sharedToolsDir,
      "alpha",
      `
/**
 * Find a customer.
 * @param id - Customer identifier
 */
export default async function alpha(input: {
  /** Customer identifier. */
  id: string
  limit?: number
}): Promise<{ found: boolean }> {
  return { found: input.id.length > 0 }
}
`,
    )
    writeToolFile(
      routeDir,
      "lookup",
      `
/** Local lookup. */
export default async function lookup(input: { id: number }): Promise<{ local: true }> {
  return { local: true }
}
`,
    )
    writeToolFile(
      routeDir,
      "ping",
      `
/** Check health. */
export default async function ping(): Promise<{ pong: boolean }> {
  return { pong: true }
}
`,
    )

    let backendCalls = 0
    let createProgramCalls = 0
    const analyzeToolFiles = createAnalyzeToolFiles((rootNames, options) => {
      createProgramCalls += 1
      return ts.createProgram(rootNames, options)
    })
    const analyzeRouteTools = createAnalyzeRouteTools((toolFiles) => {
      backendCalls += 1
      return analyzeToolFiles(toolFiles)
    })

    const result = analyzeRouteTools({ routeDir, sharedToolsDir })

    expect(backendCalls).toBe(1)
    expect(createProgramCalls).toBe(1)
    expect(result).toEqual([
      {
        name: "alpha",
        description: "Find a customer.",
        exports: { description: false, schema: false },
        inputType: "{ id: string; limit?: number | undefined; }",
        outputType: "{ found: boolean; }",
        parameter: {
          kind: "object",
          properties: [
            {
              name: "id",
              type: { kind: "string" },
              optional: false,
              description: "Customer identifier.",
            },
            { name: "limit", type: { kind: "number" }, optional: true },
          ],
        },
        parameterDescriptions: new Map([["id", "Customer identifier"]]),
      },
      {
        name: "lookup",
        description: "Local lookup.",
        exports: { description: false, schema: false },
        inputType: "{ id: number; }",
        outputType: "{ local: true; }",
        parameter: {
          kind: "object",
          properties: [{ name: "id", type: { kind: "number" }, optional: false }],
        },
        parameterDescriptions: new Map(),
      },
      {
        name: "ping",
        description: "Check health.",
        exports: { description: false, schema: false },
        inputType: "void",
        outputType: "{ pong: boolean; }",
        parameter: null,
        parameterDescriptions: new Map(),
      },
    ])
  })

  test("returns no tools when the tools directory is absent", () => {
    const routeDir = join(tempDir, "route")
    mkdirSync(routeDir, { recursive: true })

    expect(analyzeRouteToolsProduction({ routeDir, sharedToolsDir: undefined })).toEqual([])
  })

  test("excludes declaration files from route tool discovery", () => {
    const routeDir = join(tempDir, "route")
    writeToolFile(
      routeDir,
      "included",
      "export default async function included(input: string) { return input }",
    )
    const toolsDirectory = join(routeDir, "tools")
    writeFileSync(
      join(toolsDirectory, "excluded.d.ts"),
      "export default function excluded(input: string): Promise<string>",
    )

    expect(
      analyzeRouteToolsProduction({ routeDir, sharedToolsDir: undefined }).map((tool) => tool.name),
    ).toEqual(["included"])
  })

  test("skips files without a callable default export", () => {
    const routeDir = join(tempDir, "route")
    writeToolFile(routeDir, "named", "export function named(input: string) { return input }")
    writeToolFile(routeDir, "config", "export default { enabled: true }")
    writeToolFile(
      routeDir,
      "valid",
      "export default function valid(input: number) { return input > 0 }",
    )

    expect(
      analyzeRouteToolsProduction({ routeDir, sharedToolsDir: undefined }).map((tool) => tool.name),
    ).toEqual(["valid"])
  })

  test("resolves imported route-tool input and output types", () => {
    const routeDir = join(tempDir, "route")
    mkdirSync(routeDir, { recursive: true })
    writeFileSync(
      join(routeDir, "types.ts"),
      `
export interface ImportedInput { query: string }
export interface ImportedOutput { matches: number }
`,
    )
    writeToolFile(
      routeDir,
      "search",
      `
import type { ImportedInput, ImportedOutput } from "../types.js"
export default async function search(input: ImportedInput): Promise<ImportedOutput> {
  return { matches: input.query.length }
}
`,
    )

    const result = analyzeRouteToolsProduction({ routeDir, sharedToolsDir: undefined })

    expect(result[0]).toMatchObject({
      name: "search",
      inputType: "ImportedInput",
      outputType: "ImportedOutput",
      parameter: {
        kind: "object",
        properties: [{ name: "query", type: { kind: "string" }, optional: false }],
      },
    })
  })
})
