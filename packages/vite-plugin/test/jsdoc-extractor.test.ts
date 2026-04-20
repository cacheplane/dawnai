import { describe, expect, it } from "vitest"

import { extractJsDoc } from "../src/jsdoc-extractor.js"

describe("extractJsDoc", () => {
  it("extracts description from JSDoc comment", () => {
    const source = `
/**
 * Look up a customer by ID
 */
export default async (input: { id: string }) => input
`
    const result = extractJsDoc(source, "test.ts")
    expect(result).toEqual({
      description: "Look up a customer by ID",
      params: {},
    })
  })

  it("extracts @param descriptions with dash separator", () => {
    const source = `
/**
 * Look up a customer
 * @param id - Customer ID
 * @param includeHistory - Include order history
 */
export default async (input: { id: string; includeHistory?: boolean }) => input
`
    const result = extractJsDoc(source, "test.ts")
    expect(result).toEqual({
      description: "Look up a customer",
      params: {
        id: "Customer ID",
        includeHistory: "Include order history",
      },
    })
  })

  it("returns undefined description and empty params when no JSDoc", () => {
    const source = `export default async (input: { id: string }) => input`
    const result = extractJsDoc(source, "test.ts")
    expect(result).toEqual({
      description: undefined,
      params: {},
    })
  })

  it("joins multiline description with spaces", () => {
    const source = `
/**
 * This is a long description
 * that spans multiple lines
 * for clarity
 */
export default async (input: { id: string }) => input
`
    const result = extractJsDoc(source, "test.ts")
    expect(result).toEqual({
      description: "This is a long description that spans multiple lines for clarity",
      params: {},
    })
  })

  it("extracts @param without dash separator", () => {
    const source = `
/**
 * Greet
 * @param name The user name
 */
export default async (input: { name: string }) => input
`
    const result = extractJsDoc(source, "test.ts")
    expect(result).toEqual({
      description: "Greet",
      params: {
        name: "The user name",
      },
    })
  })
})
