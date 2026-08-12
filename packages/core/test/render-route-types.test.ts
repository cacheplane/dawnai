import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import ts from "typescript"
import { describe, expect, test } from "vitest"

import { renderDawnTypes, renderRouteTypes } from "../src/typegen/render-route-types"
import { renderScenarioTypes, SCENARIO_TYPES_FILE } from "../src/typegen/render-scenario-types.ts"
import { type RouteStateFields, renderStateTypes } from "../src/typegen/render-state-types"
import { renderToolTypes } from "../src/typegen/render-tool-types"
import type { RouteManifest, RouteSegment, RouteToolTypes } from "../src/types"

const MANIFEST_SNAPSHOT_PATH = fileURLToPath(
  new URL("../../../test/fixtures/contracts/manifest.snap.json", import.meta.url),
)

interface RenderManifestSnapshot {
  readonly routes: Array<{
    readonly pathname: string
    readonly segments: RouteSegment[]
  }>
}

async function loadManifestSnapshot(): Promise<RouteManifest> {
  const snapshot = JSON.parse(
    await readFile(MANIFEST_SNAPSHOT_PATH, "utf8"),
  ) as RenderManifestSnapshot

  return {
    appRoot: "/fixture/type-rendering",
    routes: snapshot.routes.map((route) => ({
      id: route.pathname,
      pathname: route.pathname,
      kind: "workflow",
      entryFile: `/fixture/type-rendering${route.pathname === "/" ? "/index" : route.pathname}.tsx`,
      routeDir: `/fixture/type-rendering${route.pathname}`,
      segments: route.segments,
    })),
  }
}

function ambientModuleExports(
  source: string,
  moduleName: string,
  options: { readonly expectSemanticValidity?: boolean } = {},
): string[] {
  const declarationPath = "/fixture/dawn.generated.d.ts"
  const scenarioPath = `/fixture/${SCENARIO_TYPES_FILE}`
  const files = new Map([
    [declarationPath, source],
    [scenarioPath, ""],
  ])
  const compilerOptions = {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ESNext,
  }
  const defaultHost = ts.createCompilerHost(compilerOptions)
  const host: ts.CompilerHost = {
    ...defaultHost,
    fileExists: (path) => files.has(path) || defaultHost.fileExists(path),
    getCurrentDirectory: () => "/fixture",
    getSourceFile(path, languageVersion) {
      const content = files.get(path)
      return content === undefined
        ? defaultHost.getSourceFile(path, languageVersion)
        : ts.createSourceFile(path, content, languageVersion, true)
    },
    readFile: (path) => files.get(path) ?? defaultHost.readFile(path),
  }
  const program = ts.createProgram([...files.keys()], compilerOptions, host)
  expect(program.getSyntacticDiagnostics()).toEqual([])
  if (options.expectSemanticValidity !== false) {
    expect(ts.getPreEmitDiagnostics(program)).toEqual([])
  }
  const checker = program.getTypeChecker()
  const ambientModule = checker
    .getAmbientModules()
    .find((candidate) => candidate.name === JSON.stringify(moduleName))
  expect(ambientModule, `ambient module ${moduleName} is missing`).toBeDefined()
  return checker
    .getExportsOfModule(ambientModule as ts.Symbol)
    .map(({ name }) => name)
    .sort()
}

describe("renderDawnTypes", () => {
  test("loads the exact stable no-state dawn:routes exports through TypeScript", () => {
    const manifest: RouteManifest = {
      appRoot: "/tmp/example-app",
      routes: [
        {
          id: "/hello/[tenant]",
          pathname: "/hello/[tenant]",
          kind: "workflow",
          entryFile: "/tmp/example-app/hello/[tenant].tsx",
          routeDir: "/tmp/example-app/hello/[tenant]",
          segments: [
            { kind: "static", value: "hello" },
            { kind: "dynamic", name: "tenant" },
          ],
        },
      ],
    }
    const toolTypes: RouteToolTypes[] = [
      {
        pathname: "/hello/[tenant]",
        tools: [{ name: "greet", inputType: "{ tenant: string }", outputType: "string" }],
      },
    ]

    const output = renderDawnTypes(manifest, toolTypes)

    expect(output).toContain(renderToolTypes(toolTypes).trimEnd())
    expect(ambientModuleExports(output, "dawn:routes")).toEqual([
      "DawnRouteParams",
      "DawnRoutePath",
      "DawnRouteTools",
      "RouteTools",
    ])
  })

  test("adds only the state exports when generated route state is present", () => {
    const manifest: RouteManifest = {
      appRoot: "/tmp/example-app",
      routes: [
        {
          id: "/hello",
          pathname: "/hello",
          kind: "workflow",
          entryFile: "/tmp/example-app/hello.tsx",
          routeDir: "/tmp/example-app/hello",
          segments: [{ kind: "static", value: "hello" }],
        },
      ],
    }
    const stateTypes: RouteStateFields[] = [
      { pathname: "/hello", fields: [{ name: "status", type: '"ready" | "done"' }] },
    ]

    const toolTypes: RouteToolTypes[] = [
      {
        pathname: "/hello",
        tools: [{ name: "status", inputType: "void", outputType: '"ready" | "done"' }],
      },
    ]
    const output = renderDawnTypes(manifest, toolTypes, stateTypes)

    expect(output).toContain(renderStateTypes(stateTypes).trimEnd())
    expect(ambientModuleExports(output, "dawn:routes")).toEqual([
      "DawnRouteParams",
      "DawnRoutePath",
      "DawnRouteState",
      "DawnRouteTools",
      "RouteState",
      "RouteTools",
    ])
  })

  test("detects added and removed generated exports bidirectionally", () => {
    const manifest: RouteManifest = {
      appRoot: "/tmp/example-app",
      routes: [
        {
          id: "/hello",
          pathname: "/hello",
          kind: "workflow",
          entryFile: "/tmp/example-app/hello.tsx",
          routeDir: "/tmp/example-app/hello",
          segments: [{ kind: "static", value: "hello" }],
        },
      ],
    }
    const output = renderDawnTypes(manifest, [
      {
        pathname: "/hello",
        tools: [{ name: "greet", inputType: "void", outputType: "string" }],
      },
    ])
    const expected = ["DawnRouteParams", "DawnRoutePath", "DawnRouteTools", "RouteTools"]
    const added = output.replace(
      'declare module "dawn:routes" {',
      'declare module "dawn:routes" {\n  export type UnexpectedRouteType = never;',
    )
    const removed = output.replace(/ {2}export interface DawnRouteTools \{[\s\S]*?\n {2}\}\n\n/, "")

    expect(added).not.toBe(output)
    expect(removed).not.toBe(output)
    expect(ambientModuleExports(added, "dawn:routes")).not.toEqual(expected)
    expect(
      ambientModuleExports(removed, "dawn:routes", { expectSemanticValidity: false }),
    ).not.toEqual(expected)
  })

  test("renders a single declare module block with route params and tool types", () => {
    const manifest: RouteManifest = {
      appRoot: "/tmp/example-app",
      routes: [
        {
          id: "/hello/[tenant]",
          pathname: "/hello/[tenant]",
          kind: "workflow",
          entryFile: "/tmp/example-app/hello/[tenant].tsx",
          routeDir: "/tmp/example-app/hello/[tenant]",
          segments: [
            { kind: "static", value: "hello" },
            { kind: "dynamic", name: "tenant" },
          ],
        },
      ],
    }

    const toolTypes: RouteToolTypes[] = [
      {
        pathname: "/hello/[tenant]",
        tools: [
          {
            name: "greet",
            inputType: "{ readonly tenant: string; }",
            outputType: "{ greeting: string; }",
          },
        ],
      },
    ]

    const output = renderDawnTypes(manifest, toolTypes)

    expect(output.startsWith(`/// <reference path="./${SCENARIO_TYPES_FILE}" />\n\n`)).toBe(true)
    expect(output).toMatchInlineSnapshot(`
      "/// <reference path="./scenarios.generated.d.ts" />

      declare module "dawn:routes" {
        export type DawnRoutePath = "/hello/[tenant]";

        export interface DawnRouteParams {
        "/hello/[tenant]": { tenant: string };
        }

        export interface DawnRouteTools {
          "/hello/[tenant]": {
            readonly greet: (input: { readonly tenant: string; }) => Promise<{ greeting: string; }>;
          };
        }

        export type RouteTools<P extends DawnRoutePath> = DawnRouteTools[P];
      }
      "
    `)
  })

  test("renders correct output for empty manifest and empty tools", () => {
    const manifest: RouteManifest = {
      appRoot: "/tmp/example-app",
      routes: [],
    }

    const toolTypes: RouteToolTypes[] = []

    expect(renderDawnTypes(manifest, toolTypes)).toMatchInlineSnapshot(`
      "/// <reference path="./scenarios.generated.d.ts" />

      declare module "dawn:routes" {
        export type DawnRoutePath = never;

        export interface DawnRouteParams {}

        export interface DawnRouteTools {}

        export type RouteTools<P extends DawnRoutePath> = DawnRouteTools[P];
      }
      "
    `)
  })

  test("includes DawnRouteState and RouteState when stateTypes is provided", () => {
    const manifest: RouteManifest = {
      appRoot: "/tmp/example-app",
      routes: [
        {
          id: "/hello/[tenant]",
          pathname: "/hello/[tenant]",
          kind: "workflow",
          entryFile: "/tmp/example-app/hello/[tenant].tsx",
          routeDir: "/tmp/example-app/hello/[tenant]",
          segments: [
            { kind: "static", value: "hello" },
            { kind: "dynamic", name: "tenant" },
          ],
        },
      ],
    }

    const toolTypes: RouteToolTypes[] = []

    const stateTypes: RouteStateFields[] = [
      {
        pathname: "/hello/[tenant]",
        fields: [
          { name: "status", type: "string" },
          { name: "count", type: "number" },
        ],
      },
    ]

    const output = renderDawnTypes(manifest, toolTypes, stateTypes)
    expect(output).toContain("DawnRouteState")
    expect(output).toContain("RouteState")
    expect(output).toContain("readonly status: string;")
    expect(output).toContain("readonly count: number;")
  })

  test("does NOT include DawnRouteState when stateTypes is omitted", () => {
    const manifest: RouteManifest = {
      appRoot: "/tmp/example-app",
      routes: [
        {
          id: "/hello/[tenant]",
          pathname: "/hello/[tenant]",
          kind: "workflow",
          entryFile: "/tmp/example-app/hello/[tenant].tsx",
          routeDir: "/tmp/example-app/hello/[tenant]",
          segments: [
            { kind: "static", value: "hello" },
            { kind: "dynamic", name: "tenant" },
          ],
        },
      ],
    }

    const toolTypes: RouteToolTypes[] = []

    const output = renderDawnTypes(manifest, toolTypes)
    expect(output).not.toContain("DawnRouteState")
  })
})

describe("renderScenarioTypes", () => {
  test("renders an external testing module augmentation with route-aware tool types", () => {
    const manifest: RouteManifest = {
      appRoot: "/tmp/example-app",
      routes: [
        {
          id: "/hello/[tenant]",
          pathname: "/hello/[tenant]",
          kind: "workflow",
          entryFile: "/tmp/example-app/hello/[tenant].tsx",
          routeDir: "/tmp/example-app/hello/[tenant]",
          segments: [
            { kind: "static", value: "hello" },
            { kind: "dynamic", name: "tenant" },
          ],
        },
      ],
    }
    const toolTypes: RouteToolTypes[] = [
      {
        pathname: "/hello/[tenant]",
        tools: [
          {
            name: "greet",
            description: "Greet a tenant",
            inputType: "{ readonly tenant: string }",
            outputType: "{ name: string }",
          },
        ],
      },
    ]

    expect(renderScenarioTypes(manifest, toolTypes)).toMatchInlineSnapshot(`
      "import "@dawn-ai/sdk/testing"

      declare module "@dawn-ai/sdk/testing" {
        interface RouteScenarioMap {
          "/hello/[tenant]": {
            readonly tools: {
              readonly "greet": (input: { readonly tenant: string }) => Promise<{ name: string }>
            }
          }
        }
      }
      "
    `)
  })

  test("renders empty tool maps and void-input tool signatures", () => {
    const manifest: RouteManifest = {
      appRoot: "/tmp/example-app",
      routes: [
        {
          id: "/without-tools",
          pathname: "/without-tools",
          kind: "workflow",
          entryFile: "/tmp/example-app/without-tools.tsx",
          routeDir: "/tmp/example-app/without-tools",
          segments: [{ kind: "static", value: "without-tools" }],
        },
        {
          id: "/ping",
          pathname: "/ping",
          kind: "workflow",
          entryFile: "/tmp/example-app/ping.tsx",
          routeDir: "/tmp/example-app/ping",
          segments: [{ kind: "static", value: "ping" }],
        },
      ],
    }
    const toolTypes: RouteToolTypes[] = [
      {
        pathname: "/ping",
        tools: [
          {
            name: "ping",
            description: "Ping the route",
            inputType: "void",
            outputType: "string",
          },
        ],
      },
    ]

    const output = renderScenarioTypes(manifest, toolTypes)
    expect(output).toContain(`"/without-tools": {
      readonly tools: Record<never, never>
    }`)
    expect(output).toContain('readonly "ping": () => Promise<string>')
  })
})

describe("renderRouteTypes", () => {
  test("renders valid TypeScript for an empty manifest", () => {
    const manifest: RouteManifest = {
      appRoot: "/tmp/example-app",
      routes: [],
    }

    expect(renderRouteTypes(manifest)).toMatchInlineSnapshot(`
      "declare module "dawn:routes" {
        export type DawnRoutePath = never;
      
        export interface DawnRouteParams {}
      }
      "
    `)
  })

  test("renders route types from the synthetic checked-in path-and-param snapshot", async () => {
    const manifest = await loadManifestSnapshot()

    expect(renderRouteTypes(manifest)).toMatchInlineSnapshot(`
      "declare module "dawn:routes" {
        export type DawnRoutePath = "/" | "/[tenant]" | "/docs/[...path]" | "/docs/[[...path]]";
      
        export interface DawnRouteParams {
        "/": {};
        "/[tenant]": { tenant: string };
        "/docs/[...path]": { path: string[] };
        "/docs/[[...path]]": { path?: string[] };
        }
      }
      "
    `)
  })
})
