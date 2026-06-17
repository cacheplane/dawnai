import type { DawnToolContext } from "@dawn-ai/sdk"
import { afterEach, expect, it } from "vitest"
import { createToolHarness } from "../src/tool-harness.js"
import { createWorkspaceHarness } from "../src/workspace-harness.js"

const open: Array<{ close(): Promise<void> }> = []
afterEach(async () => {
  await Promise.all(open.splice(0).map((h) => h.close()))
})

const stash = async (input: { name: string }, ctx: DawnToolContext) => {
  await ctx.fs.writeFile(`notes/${input.name}.md`, `# ${input.name}`)
  return { count: (await ctx.fs.listDir("notes")).length }
}

it("invokes a ctx.fs tool and exposes its workspace side effects", async () => {
  const h = await createToolHarness(stash)
  open.push(h)
  const result = await h.invoke({ name: "alpha" })
  expect(result).toEqual({ count: 1 })
  expect(await h.workspace.read("notes/alpha.md")).toContain("# alpha")
})

it("invoke() is reusable and accumulates workspace state", async () => {
  const h = await createToolHarness(stash)
  open.push(h)
  await h.invoke({ name: "a" })
  expect(await h.invoke({ name: "b" })).toEqual({ count: 2 })
})

it("passes the middleware bag to ctx.middleware", async () => {
  let seen: unknown
  const tool = async (_input: unknown, ctx: DawnToolContext) => {
    seen = ctx.middleware
    return "ok"
  }
  const h = await createToolHarness(tool, { middleware: { userId: "u1" } })
  open.push(h)
  await h.invoke({})
  expect(seen).toEqual({ userId: "u1" })
})

it("shares a passed-in workspace and does NOT close it", async () => {
  const ws = await createWorkspaceHarness()
  open.push(ws)
  const h = await createToolHarness(stash, { workspace: ws })
  await h.invoke({ name: "x" })
  await h.close() // must NOT remove ws
  expect(await ws.read("notes/x.md")).toContain("# x")
})
