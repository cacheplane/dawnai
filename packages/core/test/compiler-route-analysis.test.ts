import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { analyzeRouteTools } from "../src/compiler/index.ts"

const programCounter = vi.hoisted(() => ({ count: 0 }))

vi.mock("typescript", async (importOriginal) => {
  const actual = await importOriginal<typeof import("typescript")>()
  return {
    ...actual,
    default: new Proxy(actual.default, {
      get(target, property, receiver) {
        if (property === "createProgram") {
          return (...args: Parameters<typeof target.createProgram>) => {
            programCounter.count += 1
            return target.createProgram(...args)
          }
        }
        return Reflect.get(target, property, receiver)
      },
    }),
  }
})

let tempDir: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "dawn-route-analysis-"))
  programCounter.count = 0
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

    const result = analyzeRouteTools({ routeDir, sharedToolsDir })

    expect(programCounter.count).toBe(1)
    expect(result).toEqual([
      {
        name: "alpha",
        description: "Find a customer.",
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
        inputType: "void",
        outputType: "{ pong: boolean; }",
        parameter: null,
        parameterDescriptions: new Map(),
      },
    ])
  })
})
