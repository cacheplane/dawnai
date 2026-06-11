import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { discoverToolDefinitions } from "../src/lib/runtime/tool-discovery.js"

describe("tool discovery error messages", () => {
  let appRoot: string
  let toolsDir: string

  beforeEach(() => {
    appRoot = mkdtempSync(join(tmpdir(), "dawn-tooldisc-"))
    toolsDir = join(appRoot, "route", "tools")
    mkdirSync(toolsDir, { recursive: true })
  })
  afterEach(() => {
    rmSync(appRoot, { recursive: true, force: true })
  })

  function writeTool(name: string, source: string): void {
    writeFileSync(join(toolsDir, name), source, "utf8")
  }

  async function discover() {
    return discoverToolDefinitions({ appRoot, routeDir: join(appRoot, "route") })
  }

  it("names a LangChain StructuredTool-shaped default export and shows the wrapper fix", async () => {
    writeTool(
      "search.ts",
      `export default {
        name: "web_search",
        schema: {},
        invoke: async () => "results",
      }`,
    )
    await expect(discover()).rejects.toThrow(
      /default-exports a LangChain tool\(\) \(StructuredTool "web_search"\)/,
    )
    await expect(discover()).rejects.toThrow(/export default async/)
    await expect(discover()).rejects.toThrow(/dawnai\.org\/docs\/tools/)
  })

  it("describes a plain-object default export by its keys", async () => {
    writeTool("config.ts", `export default { apiKey: "x", region: "us" }`)
    await expect(discover()).rejects.toThrow(/an object with keys \[apiKey, region\]/)
    await expect(discover()).rejects.toThrow(/dawnai\.org\/docs\/tools/)
  })

  it("describes a missing default export", async () => {
    writeTool("nothing.ts", `export const helper = 1`)
    await expect(discover()).rejects.toThrow(/no default export/)
  })

  it("describes a primitive default export by type", async () => {
    writeTool("oops.ts", `export default "just a string"`)
    await expect(discover()).rejects.toThrow(/a string/)
  })

  it("still accepts a plain default-exported function", async () => {
    writeTool("greet.ts", `export default async (input: { name: string }) => input.name`)
    const tools = await discover()
    expect(tools.map((t) => t.name)).toEqual(["greet"])
  })

  it("still accepts an object with a run function", async () => {
    writeTool("runner.ts", `export default { run: async () => "ok" }`)
    const tools = await discover()
    expect(tools.map((t) => t.name)).toEqual(["runner"])
  })
})
