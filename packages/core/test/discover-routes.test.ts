import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { discoverRoutes } from "../src/index.js"

let workspaceRoot: string

beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), "dawn-discover-"))
})

afterEach(async () => {
  await rm(workspaceRoot, { recursive: true, force: true })
})

async function writeApp(files: Readonly<Record<string, string>>): Promise<string> {
  const appRoot = workspaceRoot

  await writeFile(join(appRoot, "package.json"), `{}\n`, "utf8")
  await writeFile(join(appRoot, "dawn.config.ts"), `export default { appDir: "src/app" }\n`, "utf8")

  for (const [relative, content] of Object.entries(files)) {
    const absolute = join(appRoot, relative)
    await mkdir(join(absolute, ".."), { recursive: true })
    await writeFile(absolute, content, "utf8")
  }

  return appRoot
}

describe("discoverRoutes", () => {
  it("discovers a workflow route from index.ts", async () => {
    const appRoot = await writeApp({
      "src/app/hello/index.ts": `export async function workflow() { return {} }\n`,
    })

    const manifest = await discoverRoutes({ appRoot })

    expect(manifest.routes).toHaveLength(1)
    expect(manifest.routes[0]).toMatchObject({
      pathname: "/hello",
      kind: "workflow",
    })
  })

  it("discovers a graph route from index.ts", async () => {
    const appRoot = await writeApp({
      "src/app/hello/index.ts": `export const graph = { invoke: async () => ({}) }\n`,
    })

    const manifest = await discoverRoutes({ appRoot })

    expect(manifest.routes[0].kind).toBe("graph")
  })

  it("throws when index.ts exports both workflow and graph", async () => {
    const appRoot = await writeApp({
      "src/app/hello/index.ts": `export async function workflow() { return {} }\nexport const graph = { invoke: async () => ({}) }\n`,
    })

    await expect(discoverRoutes({ appRoot })).rejects.toThrow(
      /Route index\.ts must export exactly one of "workflow" or "graph"/,
    )
  })

  it("skips index.ts that exports neither", async () => {
    const appRoot = await writeApp({
      "src/app/util/index.ts": `export const helper = 1\n`,
    })

    const manifest = await discoverRoutes({ appRoot })

    expect(manifest.routes).toHaveLength(0)
  })

  it("strips route groups from pathnames", async () => {
    const appRoot = await writeApp({
      "src/app/(public)/hello/index.ts": `export async function workflow() { return {} }\n`,
    })

    const manifest = await discoverRoutes({ appRoot })

    expect(manifest.routes[0].pathname).toBe("/hello")
  })

  it("preserves dynamic segments in pathnames", async () => {
    const appRoot = await writeApp({
      "src/app/hello/[tenant]/index.ts": `export async function workflow() { return {} }\n`,
    })

    const manifest = await discoverRoutes({ appRoot })

    expect(manifest.routes[0].pathname).toBe("/hello/[tenant]")
    expect(manifest.routes[0].segments).toEqual([
      { kind: "static", raw: "hello" },
      { kind: "dynamic", name: "tenant", raw: "[tenant]" },
    ])
  })

  it("skips private segments", async () => {
    const appRoot = await writeApp({
      "src/app/_internal/index.ts": `export async function workflow() { return {} }\n`,
      "src/app/hello/index.ts": `export async function workflow() { return {} }\n`,
    })

    const manifest = await discoverRoutes({ appRoot })

    expect(manifest.routes.map((r) => r.pathname)).toEqual(["/hello"])
  })

  it("detects duplicate pathnames across route groups", async () => {
    const appRoot = await writeApp({
      "src/app/(a)/hello/index.ts": `export async function workflow() { return {} }\n`,
      "src/app/(b)/hello/index.ts": `export async function workflow() { return {} }\n`,
    })

    await expect(discoverRoutes({ appRoot })).rejects.toThrow(/Duplicate Dawn route pathname/)
  })
})
