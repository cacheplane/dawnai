import { existsSync, realpathSync } from "node:fs"
import { createPermissionsStore } from "@dawn-ai/permissions"
import { afterEach, expect, it } from "vitest"
import { createWorkspaceHarness, type WorkspaceHarness } from "../src/workspace-harness.js"

const open: WorkspaceHarness[] = []
afterEach(async () => {
  await Promise.all(open.splice(0).map((h) => h.close()))
})
async function harness(...args: Parameters<typeof createWorkspaceHarness>) {
  const h = await createWorkspaceHarness(...args)
  open.push(h)
  return h
}

it("round-trips write -> fs.readFile and fs.writeFile -> read", async () => {
  const h = await harness()
  await h.write("notes/seed.md", "hi")
  expect(await h.fs.readFile("notes/seed.md")).toBe("hi")
  await h.fs.writeFile("out/result.md", "done")
  expect(await h.read("out/result.md")).toBe("done")
})

it("exposes a realpath'd workspace dir", async () => {
  const h = await harness()
  expect(h.dir).toBe(realpathSync(h.dir))
})

it("close() removes the temp dir and is idempotent", async () => {
  const h = await createWorkspaceHarness()
  const dir = h.dir
  await h.close()
  await h.close()
  expect(existsSync(dir)).toBe(false)
})

it("supports `await using` auto-disposal", async () => {
  let captured = ""
  {
    await using h = await createWorkspaceHarness()
    captured = h.dir
    expect(existsSync(captured)).toBe(true)
  }
  expect(existsSync(captured)).toBe(false)
})

it("is permissive by default (allows an outside-workspace read)", async () => {
  const h = await harness()
  await expect(h.fs.readFile("/etc/hosts")).resolves.toBeTypeOf("string")
})

it("fails closed for an outside path when a non-interactive store is injected", async () => {
  const permissions = createPermissionsStore({
    appRoot: process.cwd(),
    config: undefined,
    mode: "non-interactive",
  })
  await permissions.load()
  const h = await harness({ permissions })
  await expect(h.fs.readFile("/etc/hosts")).rejects.toThrow(/fail-closed/)
})
