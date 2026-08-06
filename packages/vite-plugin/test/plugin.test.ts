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

    // Should still inject schema since only description exists
    if (result) {
      expect(result).not.toContain('export const description = "JSDoc description"')
      expect(result).toContain("export const schema =")
    }
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
})
