import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import ts from "typescript"
import { afterEach, beforeEach, describe, expect, test } from "vitest"

import { createAnalyzeRouteTools } from "../src/compiler/analyze-route-tools.ts"
import { analyzeRouteTools as analyzeRouteToolsProduction } from "../src/compiler/index.ts"
import { createAnalyzeToolFiles } from "../src/compiler/typescript-backend.ts"
import { renderScenarioTypes, SCENARIO_TYPES_FILE } from "../src/typegen/render-scenario-types.ts"
import type { RouteManifest, RouteToolTypes } from "../src/types.ts"

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

function compileScenarioDeclaration(options: {
  readonly routeDir: string
  readonly pathname: string
  readonly tools: RouteToolTypes["tools"]
  readonly consumerSource?: string
}): {
  readonly diagnostics: ReadonlyArray<{
    readonly mode: string
    readonly code: number
    readonly message: string
  }>
} {
  const scenarioTypesFile = join(tempDir, ".dawn", SCENARIO_TYPES_FILE)
  const manifest: RouteManifest = {
    appRoot: tempDir,
    routes: [
      {
        id: options.pathname,
        pathname: options.pathname,
        kind: "workflow",
        entryFile: join(options.routeDir, "index.ts"),
        routeDir: options.routeDir,
        segments: [{ kind: "static", raw: options.pathname.slice(1) }],
      },
    ],
  }
  const routeTools: RouteToolTypes[] = [{ pathname: options.pathname, tools: options.tools }]
  const content = renderScenarioTypes(manifest, routeTools)

  mkdirSync(join(tempDir, ".dawn"), { recursive: true })
  writeFileSync(join(tempDir, "package.json"), '{"type":"module"}\n')
  writeFileSync(scenarioTypesFile, content)
  const sdkTestingStub = join(tempDir, "sdk-testing.d.ts")
  writeFileSync(
    sdkTestingStub,
    'declare module "@dawn-ai/sdk/testing" { interface RouteScenarioMap {} }\n',
  )

  const rootNames = [scenarioTypesFile, sdkTestingStub]
  if (options.consumerSource !== undefined) {
    const consumerFile = join(tempDir, "consumer.ts")
    writeFileSync(consumerFile, options.consumerSource)
    rootNames.push(consumerFile)
  }

  const modes: ReadonlyArray<{ readonly name: string; readonly options: ts.CompilerOptions }> = [
    {
      name: "Bundler",
      options: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        strict: true,
        noEmit: true,
        lib: ["lib.es2022.d.ts"],
      },
    },
    {
      name: "NodeNext",
      options: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        strict: true,
        noEmit: true,
        lib: ["lib.es2022.d.ts"],
      },
    },
  ]

  const diagnostics = modes.flatMap((mode) =>
    ts.getPreEmitDiagnostics(ts.createProgram(rootNames, mode.options)).map((diagnostic) => ({
      mode: mode.name,
      code: diagnostic.code,
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    })),
  )

  return { diagnostics }
}

// These suites drive the TypeScript compiler through
// `src/compiler/typescript-backend.ts`, so their runtime tracks machine load
// rather than the work in the test. Idle they finish well inside a second; under
// a saturated parallel run they have exceeded vitest's 5000ms default and failed
// as timeouts rather than as anything real. The explicit suite timeout leaves
// room for that without hiding a genuine hang.
describe("analyzeRouteTools", { timeout: 30_000 }, () => {
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

  test("emits portable imported types that compile in the generated scenario declaration", () => {
    const routeDir = join(tempDir, "src", "app", "search")
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

    const scenarioTypesFile = join(tempDir, ".dawn", SCENARIO_TYPES_FILE)
    const tools = analyzeRouteToolsProduction({
      routeDir,
      sharedToolsDir: undefined,
      typeReferenceFileName: scenarioTypesFile,
    })
    const { diagnostics } = compileScenarioDeclaration({
      routeDir,
      pathname: "/search",
      tools,
    })

    expect({
      name: tools[0]?.name,
      inputType: tools[0]?.inputType,
      outputType: tools[0]?.outputType,
      parameter: tools[0]?.parameter,
      containsAbsolutePath:
        tools[0]?.inputType.includes(tempDir) || tools[0]?.outputType.includes(tempDir),
      diagnostics,
    }).toEqual({
      name: "search",
      inputType: 'Parameters<typeof import("../src/app/search/tools/search.js").default>[0]',
      outputType: 'Awaited<ReturnType<typeof import("../src/app/search/tools/search.js").default>>',
      parameter: {
        kind: "object",
        properties: [{ name: "query", type: { kind: "string" }, optional: false }],
      },
      containsAbsolutePath: false,
      diagnostics: [],
    })
  })

  test("keeps private local types reachable through the source module", () => {
    const routeDir = join(tempDir, "src", "app", "local")
    writeToolFile(
      routeDir,
      "local",
      `
interface LocalInput { query: string; child?: LocalInput }
interface LocalOutput { matches: number; child?: LocalOutput }
export default async function local(input: LocalInput): Promise<LocalOutput> {
  return { matches: input.query.length }
}
`,
    )

    const scenarioTypesFile = join(tempDir, ".dawn", SCENARIO_TYPES_FILE)
    const tools = analyzeRouteToolsProduction({
      routeDir,
      sharedToolsDir: undefined,
      typeReferenceFileName: scenarioTypesFile,
    })
    const { diagnostics } = compileScenarioDeclaration({
      routeDir,
      pathname: "/local",
      tools,
    })

    expect({
      inputType: tools[0]?.inputType,
      outputType: tools[0]?.outputType,
      containsAbsolutePath:
        tools[0]?.inputType.includes(tempDir) || tools[0]?.outputType.includes(tempDir),
      diagnostics,
    }).toEqual({
      inputType: 'Parameters<typeof import("../src/app/local/tools/local.js").default>[0]',
      outputType: 'Awaited<ReturnType<typeof import("../src/app/local/tools/local.js").default>>',
      containsAbsolutePath: false,
      diagnostics: [],
    })
  })

  test("keeps zero-argument portable tool inputs void", () => {
    const routeDir = join(tempDir, "src", "app", "ping")
    writeToolFile(
      routeDir,
      "ping",
      'export default async function ping(): Promise<string> { return "pong" }',
    )

    const tools = analyzeRouteToolsProduction({
      routeDir,
      sharedToolsDir: undefined,
      typeReferenceFileName: join(tempDir, ".dawn", SCENARIO_TYPES_FILE),
    })
    const { diagnostics } = compileScenarioDeclaration({
      routeDir,
      pathname: "/ping",
      tools,
      consumerSource: `
import type { RouteScenarioMap } from "@dawn-ai/sdk/testing"
declare const ping: RouteScenarioMap["/ping"]["tools"]["ping"]
const result: Promise<string> = ping()
void result
`,
    })

    expect(tools[0]?.inputType).toBe("void")
    expect(diagnostics).toEqual([])
  })

  test("keeps the first overload as the portable tool signature", () => {
    const routeDir = join(tempDir, "src", "app", "overloaded")
    writeToolFile(
      routeDir,
      "lookup",
      `
function lookup(input: string): Promise<number>
function lookup(input: number): Promise<string>
async function lookup(input: string | number): Promise<string | number> {
  return typeof input === "string" ? input.length : String(input)
}
export default lookup
`,
    )

    const tools = analyzeRouteToolsProduction({
      routeDir,
      sharedToolsDir: undefined,
      typeReferenceFileName: join(tempDir, ".dawn", SCENARIO_TYPES_FILE),
    })
    const { diagnostics } = compileScenarioDeclaration({
      routeDir,
      pathname: "/overloaded",
      tools,
      consumerSource: `
import type { RouteScenarioMap } from "@dawn-ai/sdk/testing"
declare const lookup: RouteScenarioMap["/overloaded"]["tools"]["lookup"]
const result: Promise<number> = lookup("query")
void result
`,
    })

    expect(diagnostics).toEqual([])
  })
})
