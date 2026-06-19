import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import type { MemoryRecord } from "@dawn-ai/memory"
import { sqliteMemoryStore } from "@dawn-ai/memory"
import { afterEach, describe, expect, it } from "vitest"

import { runMemoryCommand } from "../src/commands/memory.js"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..")
const scratchRoot = resolve(repoRoot, "packages", "cli", ".tmp-memory-apps")

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })))
})

async function makeApp(): Promise<string> {
  await mkdir(scratchRoot, { recursive: true })
  const root = await mkdtemp(join(scratchRoot, "app-"))
  tempDirs.push(root)
  await writeFile(join(root, "package.json"), '{ "name": "memory-temp-app", "type": "module" }\n')
  return root
}

const baseRecord: MemoryRecord = {
  id: "m1",
  kind: "semantic",
  namespace: "ws=app|route=/r",
  content: "esc",
  data: { subject: "billing" },
  source: { type: "run", id: "run-1" },
  confidence: 0.9,
  tags: [],
  status: "candidate",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
}

describe("dawn memory", () => {
  it("list shows candidate records", async () => {
    const appRoot = await makeApp()
    const store = sqliteMemoryStore({ path: join(appRoot, ".dawn/memory.sqlite") })
    await store.put(baseRecord)

    const lines: string[] = []
    await runMemoryCommand(
      ["list"],
      { cwd: appRoot },
      { stdout: (m) => lines.push(m), stderr: () => {} },
    )

    const output = lines.join("\n")
    expect(output).toContain("m1")
    expect(output).toContain("candidate")
  })

  it("approve flips status to active", async () => {
    const appRoot = await makeApp()
    const store = sqliteMemoryStore({ path: join(appRoot, ".dawn/memory.sqlite") })
    await store.put(baseRecord)

    const io = { stdout: () => {}, stderr: () => {} }
    await runMemoryCommand(["approve", "m1"], { cwd: appRoot }, io)

    const updated = await store.get("m1")
    expect(updated?.status).toBe("active")
  })

  it("forget hard-deletes a record", async () => {
    const appRoot = await makeApp()
    const store = sqliteMemoryStore({ path: join(appRoot, ".dawn/memory.sqlite") })
    await store.put(baseRecord)

    const io = { stdout: () => {}, stderr: () => {} }
    await runMemoryCommand(["forget", "m1"], { cwd: appRoot }, io)

    expect(await store.get("m1")).toBeNull()
  })

  it("search filters by query substring in content/namespace", async () => {
    const appRoot = await makeApp()
    const store = sqliteMemoryStore({ path: join(appRoot, ".dawn/memory.sqlite") })
    await store.put(baseRecord)
    await store.put({
      ...baseRecord,
      id: "m2",
      content: "other topic",
      namespace: "ws=app|route=/x",
    })

    const lines: string[] = []
    await runMemoryCommand(
      ["search", "esc"],
      { cwd: appRoot },
      { stdout: (m) => lines.push(m), stderr: () => {} },
    )

    const output = lines.join("\n")
    expect(output).toContain("m1")
    expect(output).not.toContain("m2")
  })

  it("inspect prints full JSON for a record", async () => {
    const appRoot = await makeApp()
    const store = sqliteMemoryStore({ path: join(appRoot, ".dawn/memory.sqlite") })
    await store.put(baseRecord)

    const lines: string[] = []
    await runMemoryCommand(
      ["inspect", "m1"],
      { cwd: appRoot },
      { stdout: (m) => lines.push(m), stderr: () => {} },
    )

    const output = lines.join("\n")
    expect(output).toContain('"id"')
    expect(output).toContain("m1")
    expect(output).toContain("billing")
  })

  it("reject deletes a candidate record", async () => {
    const appRoot = await makeApp()
    const store = sqliteMemoryStore({ path: join(appRoot, ".dawn/memory.sqlite") })
    await store.put(baseRecord)

    const io = { stdout: () => {}, stderr: () => {} }
    await runMemoryCommand(["reject", "m1"], { cwd: appRoot }, io)

    expect(await store.get("m1")).toBeNull()
  })

  it("unknown subcommand throws CliError", async () => {
    const appRoot = await makeApp()
    const io = { stdout: () => {}, stderr: () => {} }
    await expect(runMemoryCommand(["badcmd"], { cwd: appRoot }, io)).rejects.toThrow(
      /Unknown subcommand/,
    )
  })
})
