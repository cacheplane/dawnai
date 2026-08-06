import { readdir, readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import * as vitePlugin from "@dawn-ai/vite-plugin"
import { describe, expect, test } from "vitest"

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..")

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

describe("transformToolSource", () => {
  test("injects schema and description for a typed tool", () => {
    const source = `
/**
 * Look up a customer by ID
 * @param id - Customer ID
 */
export default async (input: { id: string }) => {
  return { name: "Acme" }
}
`
    const result = transformToolSource(source, "lookup-customer.ts")

    expect(result).not.toBeNull()
    expect(result).toContain('export const description = "Look up a customer by ID"')
    expect(result).toContain("export const schema =")
    expect(result).toContain("z.object(")
    expect(result).toContain('.describe("Customer ID")')
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
      'export const description = "Search across all indexed\\ncustomer records."',
    )
  })

  test("renders semantic intersection members instead of effective properties", () => {
    const source = `
type WithId<T> = { id: string } & T
export default async (input: WithId<{ name: string }>) => input
`
    const result = transformToolSource(source, "generic.ts")

    expect(result).toContain(
      'z.intersection(z.object({ "id": z.string() }), z.object({ "name": z.string() }))',
    )
  })

  test("does not override existing description export", () => {
    const source = `
/**
 * JSDoc description
 */
export const description = "Explicit description"
export default async (input: { id: string }) => ({ id: input.id })
`
    const result = transformToolSource(source, "tool.ts")

    expect(result).not.toBeNull()
    expect(result).not.toContain('export const description = "JSDoc description"')
    expect(result).toContain("export const schema =")
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

  test("ignores export-like comment text when deciding to inject schema", () => {
    const source = `
// A future implementation might use: export const schema = customSchema
export default async (input: { id: string }) => input
`
    const result = transformToolSource(source, "tool.ts")

    expect(result).not.toBeNull()
    expect(result).toContain("export const schema = z.object(")
  })

  test("injects runtime exports when description and schema exist only as types", () => {
    const source = `
export interface schema { parse(value: unknown): unknown }
class description {}
export type { description }
/** Generate runtime metadata. */
export default async (input: { id: string }) => input
`
    const result = transformToolSource(source, "tool.ts")

    expect(result).not.toBeNull()
    expect(result).toContain('export const description = "Generate runtime metadata."')
    expect(result).toContain("export const schema = z.object(")
  })

  test("injects description but not schema when only schema is exported", () => {
    const source = `
import { z } from "zod"
export const schema = z.object({ id: z.string() })
/** Look up a customer. */
export default async (input: { id: string }) => input
`
    const result = transformToolSource(source, "tool.ts")

    expect(result).not.toBeNull()
    expect(result).toContain('export const description = "Look up a customer."')
    expect(result?.match(/export const schema/g)).toHaveLength(1)
    expect(result?.match(/import \{ z \} from "zod"/g)).toHaveLength(1)
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
    expect(result).toContain('export const description = "A simple tool"')
    expect(result).not.toContain("export const schema")
  })

  test("uses documentation from an aliased default export target", () => {
    const source = `
/** Look up a customer from the target. */
const tool = async (input: { id: string }) => input
export { tool as default }
`
    const result = transformToolSource(source, "tool.ts")

    expect(result).not.toBeNull()
    expect(result).toContain('export const description = "Look up a customer from the target."')
    expect(result).toContain("export const schema = z.object(")
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
    expect(result).toContain('export const description = "Look up a customer from the alias."')
    expect(result).toContain('.describe("Aliased customer identifier")')
  })
})
