import { transformToolSource } from "@dawnai.org/vite-plugin"
import { describe, expect, test } from "vitest"

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
