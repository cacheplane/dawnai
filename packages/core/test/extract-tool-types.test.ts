import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"

import { extractToolTypesForRoute } from "../src/typegen/extract-tool-types"

let tempDir: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "dawn-extract-tools-"))
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

function writeToolFile(dir: string, name: string, content: string): void {
  const toolsDir = join(dir, "tools")
  mkdirSync(toolsDir, { recursive: true })
  writeFileSync(join(toolsDir, `${name}.ts`), content)
}

describe("extractToolTypesForRoute", () => {
  test("extracts input and output types from a properly typed tool", async () => {
    const routeDir = join(tempDir, "route")
    writeToolFile(
      routeDir,
      "greet",
      `
export default async function greet(input: { name: string }): Promise<{ message: string }> {
  return { message: "hello " + input.name }
}
`,
    )

    const result = await extractToolTypesForRoute({
      routeDir,
      sharedToolsDir: undefined,
    })

    expect(result).toEqual([
      {
        description: "",
        name: "greet",
        inputType: "{ name: string; }",
        outputType: "{ message: string; }",
      },
    ])
  })

  test("returns multiple tools sorted alphabetically by name", async () => {
    const routeDir = join(tempDir, "route")
    writeToolFile(
      routeDir,
      "zeta",
      `
export default async function zeta(input: { z: number }): Promise<{ ok: boolean }> {
  return { ok: true }
}
`,
    )
    writeToolFile(
      routeDir,
      "alpha",
      `
export default async function alpha(input: { a: string }): Promise<{ result: string }> {
  return { result: input.a }
}
`,
    )

    const result = await extractToolTypesForRoute({
      routeDir,
      sharedToolsDir: undefined,
    })

    expect(result).toHaveLength(2)
    expect(result[0]?.name).toBe("alpha")
    expect(result[1]?.name).toBe("zeta")
  })

  test("returns empty array when no tools directory exists", async () => {
    const routeDir = join(tempDir, "empty-route")
    mkdirSync(routeDir, { recursive: true })

    const result = await extractToolTypesForRoute({
      routeDir,
      sharedToolsDir: undefined,
    })

    expect(result).toEqual([])
  })

  test("extracts unknown inputType for input: unknown", async () => {
    const routeDir = join(tempDir, "route")
    writeToolFile(
      routeDir,
      "flexible",
      `
export default async function flexible(input: unknown): Promise<{ done: boolean }> {
  return { done: true }
}
`,
    )

    const result = await extractToolTypesForRoute({
      routeDir,
      sharedToolsDir: undefined,
    })

    expect(result).toEqual([
      {
        description: "",
        name: "flexible",
        inputType: "unknown",
        outputType: "{ done: boolean; }",
      },
    ])
  })

  test("extracts void inputType for tools with no parameters", async () => {
    const routeDir = join(tempDir, "route")
    writeToolFile(
      routeDir,
      "ping",
      `
export default async function ping(): Promise<{ pong: boolean }> {
  return { pong: true }
}
`,
    )

    const result = await extractToolTypesForRoute({
      routeDir,
      sharedToolsDir: undefined,
    })

    expect(result).toEqual([
      {
        description: "",
        name: "ping",
        inputType: "void",
        outputType: "{ pong: boolean; }",
      },
    ])
  })

  test("route-local tools shadow shared tools of the same name", async () => {
    const routeDir = join(tempDir, "route")
    const sharedDir = join(tempDir, "shared")

    writeToolFile(
      routeDir,
      "lookup",
      `
export default async function lookup(input: { id: number }): Promise<{ local: true }> {
  return { local: true }
}
`,
    )
    writeToolFile(
      sharedDir,
      "lookup",
      `
export default async function lookup(input: { query: string }): Promise<{ shared: true }> {
  return { shared: true }
}
`,
    )

    const result = await extractToolTypesForRoute({
      routeDir,
      sharedToolsDir: sharedDir,
    })

    expect(result).toEqual([
      {
        description: "",
        name: "lookup",
        inputType: "{ id: number; }",
        outputType: "{ local: true; }",
      },
    ])
  })

  test("merges shared and route-local tools", async () => {
    const routeDir = join(tempDir, "route")
    const sharedDir = join(tempDir, "shared")

    writeToolFile(
      routeDir,
      "local-tool",
      `
export default async function localTool(input: { x: string }): Promise<{ y: string }> {
  return { y: input.x }
}
`,
    )
    writeToolFile(
      sharedDir,
      "shared-tool",
      `
export default async function sharedTool(input: { a: number }): Promise<{ b: number }> {
  return { b: input.a }
}
`,
    )

    const result = await extractToolTypesForRoute({
      routeDir,
      sharedToolsDir: sharedDir,
    })

    expect(result).toHaveLength(2)
    expect(result[0]?.name).toBe("local-tool")
    expect(result[1]?.name).toBe("shared-tool")
  })

  test("extracts JSDoc description from tool function", async () => {
    const routeDir = join(tempDir, "route")
    writeToolFile(
      routeDir,
      "greet",
      `
/**
 * Greets the user by name.
 */
export default async function greet(input: { name: string }): Promise<{ message: string }> {
  return { message: "hello " + input.name }
}
`,
    )

    const result = await extractToolTypesForRoute({
      routeDir,
      sharedToolsDir: undefined,
    })

    expect(result[0]?.description).toBe("Greets the user by name.")
  })

  test("returns empty description when no JSDoc", async () => {
    const routeDir = join(tempDir, "route")
    writeToolFile(
      routeDir,
      "ping",
      `
export default async function ping(): Promise<{ pong: boolean }> {
  return { pong: true }
}
`,
    )

    const result = await extractToolTypesForRoute({
      routeDir,
      sharedToolsDir: undefined,
    })

    expect(result[0]?.description).toBe("")
  })

  test("skips .d.ts files", async () => {
    const routeDir = join(tempDir, "route")
    const toolsDir = join(routeDir, "tools")
    mkdirSync(toolsDir, { recursive: true })

    writeFileSync(
      join(toolsDir, "real.ts"),
      `
export default async function real(input: { ok: boolean }): Promise<{ done: boolean }> {
  return { done: input.ok }
}
`,
    )
    writeFileSync(
      join(toolsDir, "types.d.ts"),
      `
export default function types(input: { bad: string }): Promise<{ bad: string }>
`,
    )

    const result = await extractToolTypesForRoute({
      routeDir,
      sharedToolsDir: undefined,
    })

    expect(result).toHaveLength(1)
    expect(result[0]?.name).toBe("real")
  })
})
