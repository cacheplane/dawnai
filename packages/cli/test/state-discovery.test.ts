import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"

import { discoverStateDefinition } from "../src/lib/runtime/state-discovery.js"

let tempDir: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "dawn-state-disc-"))
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

describe("discoverStateDefinition", () => {
  test("returns null when no state.ts exists", async () => {
    const routeDir = join(tempDir, "route")
    mkdirSync(routeDir, { recursive: true })

    const result = await discoverStateDefinition({ routeDir })
    expect(result).toBeNull()
  })

  test("discovers state.ts with Standard Schema interface", async () => {
    const routeDir = join(tempDir, "route")
    mkdirSync(routeDir, { recursive: true })
    writeFileSync(
      join(routeDir, "state.ts"),
      `
const schema = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (input: unknown) => ({
      value: { context: "", results: [] as string[] },
    }),
  },
}
export default schema
`,
    )

    const result = await discoverStateDefinition({ routeDir })

    expect(result).not.toBeNull()
    expect(result?.defaults.get("context")).toBe("")
    expect(result?.defaults.get("results")).toEqual([])
  })

  test("discovers state.ts with .parse() fallback", async () => {
    const routeDir = join(tempDir, "route")
    mkdirSync(routeDir, { recursive: true })
    writeFileSync(
      join(routeDir, "state.ts"),
      `
const schema = {
  parse: (input: unknown) => ({
    count: 0,
    items: [] as string[],
  }),
}
export default schema
`,
    )

    const result = await discoverStateDefinition({ routeDir })

    expect(result).not.toBeNull()
    expect(result?.defaults.get("count")).toBe(0)
    expect(result?.defaults.get("items")).toEqual([])
  })

  test("discovers reducer overrides from reducers/ folder", async () => {
    const routeDir = join(tempDir, "route")
    const reducersDir = join(routeDir, "reducers")
    mkdirSync(reducersDir, { recursive: true })
    writeFileSync(
      join(routeDir, "state.ts"),
      `
const schema = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (input: unknown) => ({ value: { tags: [] as string[] } }),
  },
}
export default schema
`,
    )
    writeFileSync(
      join(reducersDir, "tags.ts"),
      `
export default (current: string[], incoming: string[]) => incoming
`,
    )

    const result = await discoverStateDefinition({ routeDir })

    expect(result).not.toBeNull()
    expect(result?.reducerOverrides.has("tags")).toBe(true)
    // biome-ignore lint/style/noNonNullAssertion: test assertion after null check
    const reducer = result!.reducerOverrides.get("tags")
    // biome-ignore lint/style/noNonNullAssertion: test assertion after existence check
    expect(reducer!(["a"], ["b"])).toEqual(["b"])
  })

  test("returns null when default export is not an object", async () => {
    const routeDir = join(tempDir, "route")
    mkdirSync(routeDir, { recursive: true })
    writeFileSync(join(routeDir, "state.ts"), `export default "not a schema"`)

    const result = await discoverStateDefinition({ routeDir })
    expect(result).toBeNull()
  })

  test("returns empty reducerOverrides when no reducers/ folder", async () => {
    const routeDir = join(tempDir, "route")
    mkdirSync(routeDir, { recursive: true })
    writeFileSync(
      join(routeDir, "state.ts"),
      `
const schema = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (input: unknown) => ({ value: { x: 1 } }),
  },
}
export default schema
`,
    )

    const result = await discoverStateDefinition({ routeDir })

    expect(result).not.toBeNull()
    expect(result?.reducerOverrides.size).toBe(0)
  })
})
