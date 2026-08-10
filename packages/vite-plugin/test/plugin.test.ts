import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import * as vitePlugin from "@dawn-ai/vite-plugin"
import { transformWithEsbuild } from "vite"
import { afterEach, describe, expect, test } from "vitest"

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..")
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })))
})

async function createFile(filePath: string, content: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, content, "utf8")
}

describe("compiler ownership", () => {
  test("does not own the TypeScript compiler dependency or import it from source", async () => {
    const packageJson = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
      optionalDependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
    }
    const sourceFiles = await Promise.all(
      (await readdir(join(packageRoot, "src"), { recursive: true }))
        .filter((fileName) => fileName.endsWith(".ts"))
        .map((fileName) => readFile(join(packageRoot, "src", fileName), "utf8")),
    )

    expect(packageJson.dependencies?.typescript).toBeUndefined()
    expect(packageJson.devDependencies?.typescript).toBeUndefined()
    expect(packageJson.optionalDependencies?.typescript).toBeUndefined()
    expect(packageJson.peerDependencies?.typescript).toBeUndefined()
    expect(sourceFiles.some((text) => /from ["']typescript["']/.test(text))).toBe(false)
  })

  test("does not export the retired compiler helpers", () => {
    expect("extractJsDoc" in vitePlugin).toBe(false)
    expect("extractParameterType" in vitePlugin).toBe(false)
  })
})

const { transformToolSource } = vitePlugin

describe("type generation", () => {
  test("buildStart writes linked route and scenario declarations", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "dawn-vite-typegen-"))
    tempDirs.push(appRoot)

    await Promise.all([
      createFile(join(appRoot, "package.json"), '{"type":"module"}\n'),
      createFile(join(appRoot, "dawn.config.ts"), "export default {}\n"),
      createFile(
        join(appRoot, "src", "app", "hello", "index.ts"),
        "export const agent = async () => ({})\n",
      ),
      createFile(
        join(appRoot, "src", "app", "hello", "tools", "greet.ts"),
        [
          "interface GreetInput { readonly name: string }",
          "interface GreetOutput { readonly message: string }",
          "",
          "export default async function greet(input: GreetInput): Promise<GreetOutput> {",
          '  return { message: "Hello, " + input.name + "!" }',
          "}",
          "",
        ].join("\n"),
      ),
    ])

    const plugin = vitePlugin.dawnToolSchemaPlugin({ appRoot })
    await plugin.buildStart?.()

    const dawnTypesPath = join(appRoot, ".dawn", "dawn.generated.d.ts")
    const scenarioTypesPath = join(appRoot, ".dawn", "scenarios.generated.d.ts")
    expect(existsSync(dawnTypesPath)).toBe(true)
    expect(existsSync(scenarioTypesPath)).toBe(true)

    const dawnTypes = await readFile(dawnTypesPath, "utf8")
    expect(dawnTypes).toContain('/// <reference path="./scenarios.generated.d.ts" />')

    const scenarioTypes = await readFile(scenarioTypesPath, "utf8")
    expect(scenarioTypes).toContain('import "@dawn-ai/sdk/testing"')
    expect(scenarioTypes).toContain('declare module "@dawn-ai/sdk/testing"')
    expect(scenarioTypes).toContain('readonly "greet"')
    expect(scenarioTypes).toContain(
      'Parameters<typeof import("../src/app/hello/tools/greet.js").default>[0]',
    )
    expect(scenarioTypes).toContain(
      'Awaited<ReturnType<typeof import("../src/app/hello/tools/greet.js").default>>',
    )
  })
})

async function compileTransformedTool(source: string): Promise<{
  readonly source: string
  readonly code: string
}> {
  const transformed = transformToolSource(source, "tool.ts")
  expect(transformed).not.toBeNull()
  if (!transformed) throw new Error("Expected transformed tool source")

  const compiled = await transformWithEsbuild(transformed, "tool.ts", {
    format: "esm",
    loader: "ts",
  })
  return { source: transformed, code: compiled.code }
}

function expectSingleRuntimeMetadataExports(code: string): void {
  const exportedNames = [...code.matchAll(/\bexport\s*\{([^}]*)\}/gs)].flatMap((match) =>
    (match[1] ?? "").split(",").map((specifier) => {
      const names = specifier.trim().split(/\s+as\s+/)
      return names.at(-1)?.trim()
    }),
  )

  expect(exportedNames.filter((name) => name === "description")).toHaveLength(1)
  expect(exportedNames.filter((name) => name === "schema")).toHaveLength(1)
}

describe("transformToolSource", () => {
  test("injects collision-free schema and description aliases for an ordinary typed tool", async () => {
    const source = `
/**
 * Look up a customer by ID
 * @param id - Customer ID
 */
export default async (input: { id: string }) => {
  return { name: "Acme" }
}
`
    const result = await compileTransformedTool(source)

    expect(result.source).toContain('const __dawnGeneratedDescription = "Look up a customer by ID"')
    expect(result.source).toContain("export { __dawnGeneratedDescription as description }")
    expect(result.source).toContain('import { z as __dawnGeneratedZ } from "zod"')
    expect(result.source).toContain("const __dawnGeneratedSchema = __dawnGeneratedZ.object(")
    expect(result.source).toContain("export { __dawnGeneratedSchema as schema }")
    expect(result.source).toContain('.describe("Customer ID")')
    expectSingleRuntimeMetadataExports(result.code)
  })

  test("prefers inline property descriptions over parameter tag fallbacks", () => {
    const source = `
/**
 * Look up a customer
 * @param id - Fallback customer identifier
 */
export default async (input: {
  /** Canonical customer identifier. */
  id: string
}) => input
`
    const result = transformToolSource(source, "lookup-customer.ts")

    expect(result).toContain('.describe("Canonical customer identifier.")')
    expect(result).not.toContain('.describe("Fallback customer identifier")')
  })

  test("uses the compiler-symbol description for multiline JSDoc", () => {
    const source = `
/**
 * Search across all indexed
 * customer records.
 */
export default async (input: { query: string }) => input
`
    const result = transformToolSource(source, "search.ts")

    expect(result).toContain(
      'const __dawnGeneratedDescription = "Search across all indexed\\ncustomer records."',
    )
  })

  test("renders semantic intersection members instead of effective properties", () => {
    const source = `
type WithId<T> = { id: string } & T
export default async (input: WithId<{ name: string }>) => input
`
    const result = transformToolSource(source, "generic.ts")

    expect(result).toContain(
      '__dawnGeneratedZ.intersection(__dawnGeneratedZ.object({ "id": __dawnGeneratedZ.string() }), __dawnGeneratedZ.object({ "name": __dawnGeneratedZ.string() }))',
    )
  })

  test("injects only schema when description is already exported", async () => {
    const source = `
/**
 * JSDoc description
 */
export const description = "Explicit description"
const schema = "local schema binding"
const z = "local z binding"
export default async (input: { id: string }) => ({ id: input.id })
`
    const result = await compileTransformedTool(source)

    expect(result.source).not.toContain("__dawnGeneratedDescription")
    expect(result.source).toContain("export { __dawnGeneratedSchema as schema }")
    expectSingleRuntimeMetadataExports(result.code)
  })

  test("recognizes typed description and schema exports without adding a duplicate zod import", () => {
    const source = `
import { z } from "zod"
export const description: string = "Explicit description"
export const schema: z.ZodType = z.object({ id: z.string() })
export default async (input: { id: string }) => input
`

    expect(transformToolSource(source, "tool.ts")).toBeNull()
  })

  test("ignores export-like comment text when deciding to inject schema", async () => {
    const source = `
// A future implementation might use: export const schema = customSchema
export default async (input: { id: string }) => input
`
    const result = await compileTransformedTool(source)

    expect(result.source).toContain("export { __dawnGeneratedSchema as schema }")
  })

  test("compiles a class-backed type-only description export", async () => {
    const source = `
class description {}
export type { description }
/** Generate runtime metadata. */
export default async (input: { id: string }) => input
`
    const result = await compileTransformedTool(source)

    expect(result.source).toContain("export { __dawnGeneratedDescription as description }")
    expect(result.source).toContain("export { __dawnGeneratedSchema as schema }")
    expectSingleRuntimeMetadataExports(result.code)
  })

  test("compiles an enum-backed type-only schema export", async () => {
    const source = `
enum schema { Original }
export type { schema }
/** Generate runtime metadata. */
export default async (input: { id: string }) => input
`
    const result = await compileTransformedTool(source)

    expect(result.source).toContain("export { __dawnGeneratedDescription as description }")
    expect(result.source).toContain("export { __dawnGeneratedSchema as schema }")
    expectSingleRuntimeMetadataExports(result.code)
  })

  test("avoids non-exported local description, schema, and z bindings", async () => {
    const source = `
const description = "local description"
const schema = "local schema"
const z = "local z"
/** Generate runtime metadata. */
export default async (input: { id: string }) => input
`
    const result = await compileTransformedTool(source)

    expect(result.source).toContain("export { __dawnGeneratedDescription as description }")
    expect(result.source).toContain("export { __dawnGeneratedSchema as schema }")
    expect(result.source).toContain('import { z as __dawnGeneratedZ } from "zod"')
    expectSingleRuntimeMetadataExports(result.code)
  })

  test("suffixes preexisting generated identifier bindings deterministically", async () => {
    const source = `
const __dawnGeneratedDescription = "occupied"
const __dawnGeneratedSchema = "occupied"
const __dawnGeneratedZ = "occupied"
/** Generate runtime metadata. */
export default async (input: { id: string }) => input
`
    const result = await compileTransformedTool(source)

    expect(result.source).toContain("export { __dawnGeneratedDescription2 as description }")
    expect(result.source).toContain("export { __dawnGeneratedSchema2 as schema }")
    expect(result.source).toContain('import { z as __dawnGeneratedZ2 } from "zod"')
    expectSingleRuntimeMetadataExports(result.code)
  })

  test("suffixes Unicode-escaped generated identifiers by their canonical names", async () => {
    const source = String.raw`
const \u005f_dawnGeneratedDescription = "occupied"
const \u005f_dawnGeneratedSchema = "occupied"
const \u005f_dawnGeneratedZ = "occupied"
const \u005f_dawnGeneratedZ2 = "also occupied"
/** Generate runtime metadata. */
export default async (input: { id: string }) => input
`
    const result = await compileTransformedTool(source)

    expect(result.source).toContain("export { __dawnGeneratedDescription2 as description }")
    expect(result.source).toContain("export { __dawnGeneratedSchema2 as schema }")
    expect(result.source).toContain('import { z as __dawnGeneratedZ3 } from "zod"')
    expectSingleRuntimeMetadataExports(result.code)
  })

  test("injects only description when schema is already exported", async () => {
    const source = `
const description = "local description binding"
export const schema = { parse: (value: unknown) => value }
/** Look up a customer. */
export default async (input: { id: string }) => input
`
    const result = await compileTransformedTool(source)

    expect(result.source).toContain("export { __dawnGeneratedDescription as description }")
    expect(result.source).not.toContain("__dawnGeneratedSchema")
    expect(result.source).not.toContain("__dawnGeneratedZ")
    expectSingleRuntimeMetadataExports(result.code)
  })

  test("does not override existing schema export", () => {
    const source = `
import { z } from "zod"
export const schema = z.object({ id: z.string() })
export default async (input: { id: string }) => ({ id: input.id })
`
    const result = transformToolSource(source, "tool.ts")

    // May inject description if JSDoc present, but not schema
    // No JSDoc here, so should return null
    expect(result).toBeNull()
  })

  test("returns null when both schema and description already exist", () => {
    const source = `
import { z } from "zod"
export const description = "Already described"
export const schema = z.object({ id: z.string() })
export default async (input: { id: string }) => ({ id: input.id })
`
    const result = transformToolSource(source, "tool.ts")

    expect(result).toBeNull()
  })

  test("returns null for tool with no type annotation and no JSDoc", () => {
    const source = `export default async (input) => input`
    const result = transformToolSource(source, "tool.ts")

    expect(result).toBeNull()
  })

  test.each([
    ["missing default", "export const tool = (input: { id: string }) => input"],
    ["non-callable default", "export default { enabled: true }"],
  ])("returns null for a %s module", (_case, source) => {
    expect(transformToolSource(source, "tool.ts")).toBeNull()
  })

  test("injects only description when type is unknown but JSDoc exists", () => {
    const source = `
/**
 * A simple tool
 */
export default async (input: unknown) => input
`
    const result = transformToolSource(source, "tool.ts")

    expect(result).not.toBeNull()
    expect(result).toContain('const __dawnGeneratedDescription = "A simple tool"')
    expect(result).toContain("export { __dawnGeneratedDescription as description }")
    expect(result).not.toContain("__dawnGeneratedSchema")
    expect(result).not.toContain("__dawnGeneratedZ")
  })

  test("uses documentation from an aliased default export target", () => {
    const source = `
/** Look up a customer from the target. */
const tool = async (input: { id: string }) => input
export { tool as default }
`
    const result = transformToolSource(source, "tool.ts")

    expect(result).not.toBeNull()
    expect(result).toContain(
      'const __dawnGeneratedDescription = "Look up a customer from the target."',
    )
    expect(result).toContain("export { __dawnGeneratedSchema as schema }")
  })

  test("uses leading export-alias JSDoc for description and parameter fallback", () => {
    const source = `
const tool = async (input: { id: string }) => input
/**
 * Look up a customer from the alias.
 * @param id - Aliased customer identifier
 */
export { tool as default }
`
    const result = transformToolSource(source, "tool.ts")

    expect(result).not.toBeNull()
    expect(result).toContain(
      'const __dawnGeneratedDescription = "Look up a customer from the alias."',
    )
    expect(result).toContain('.describe("Aliased customer identifier")')
  })
})
