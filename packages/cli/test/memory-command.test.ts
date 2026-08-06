import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
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

  it("approve supersedes a contradicting active row", async () => {
    // No src/app or route memory.ts → identity resolution falls back to the
    // default [subject, predicate] keys.
    const appRoot = await makeApp()
    const store = sqliteMemoryStore({ path: join(appRoot, ".dawn/memory.sqlite") })
    await store.put({
      ...baseRecord,
      id: "old",
      status: "active",
      data: { subject: "acme", predicate: "threshold", value: "500" },
    })
    await store.put({
      ...baseRecord,
      id: "cand",
      status: "candidate",
      data: { subject: "acme", predicate: "threshold", value: "750" },
    })

    const lines: string[] = []
    await runMemoryCommand(
      ["approve", "cand"],
      { cwd: appRoot },
      { stdout: (m) => lines.push(m), stderr: () => {} },
    )

    expect((await store.get("cand"))?.status).toBe("active")
    expect((await store.get("old"))?.status).toBe("superseded")
    const output = lines.join("\n")
    expect(output).toContain("approved cand (superseded)")
    expect(output).toContain("superseded old")
    expect(output).toContain("default identity")
  })

  it("approve respects a route's custom identity", async () => {
    const appRoot = await makeApp()
    // Full Dawn app shape so discoverRoutes finds the /notes route and its
    // memory.ts (mirrors packages/inspector/test/fixtures/app).
    await writeFile(join(appRoot, "dawn.config.ts"), "export default {}\n")
    const routeDir = join(appRoot, "src", "app", "notes")
    await mkdir(routeDir, { recursive: true })
    await writeFile(join(routeDir, "index.ts"), "export const agent = {}\n")
    await mkdir(join(appRoot, "node_modules"), { recursive: true })
    await symlink(
      join(repoRoot, "node_modules", ".pnpm", "zod@4.4.3", "node_modules", "zod"),
      join(appRoot, "node_modules", "zod"),
      "dir",
    )
    await writeFile(
      join(routeDir, "memory.ts"),
      [
        'import { z } from "zod"',
        "export default {",
        '  kind: "semantic",',
        '  scope: ["route"],',
        "  schema: z.object({ subject: z.string(), predicate: z.string(), value: z.string() }),",
        '  identity: ["subject"],',
        "}",
      ].join("\n"),
    )

    const store = sqliteMemoryStore({ path: join(appRoot, ".dawn/memory.sqlite") })
    // Same subject, different predicate+value: contradicts under identity
    // ["subject"] but would be a plain ADD under the default [subject, predicate].
    await store.put({
      ...baseRecord,
      id: "old",
      status: "active",
      namespace: "route=/notes",
      data: { subject: "acme", predicate: "threshold", value: "500" },
    })
    await store.put({
      ...baseRecord,
      id: "cand",
      status: "candidate",
      namespace: "route=/notes",
      data: { subject: "acme", predicate: "limit", value: "750" },
    })

    const lines: string[] = []
    await runMemoryCommand(
      ["approve", "cand"],
      { cwd: appRoot },
      { stdout: (m) => lines.push(m), stderr: () => {} },
    )

    expect((await store.get("cand"))?.status).toBe("active")
    expect((await store.get("old"))?.status).toBe("superseded")
    const output = lines.join("\n")
    expect(output).toContain("approved cand (superseded)")
    expect(output).not.toContain("default identity")
  })

  it("approve fails loudly when a route's memory.ts exists but cannot load", async () => {
    // A broken memory.ts must NOT silently fall back to default identity keys
    // (wrong keys could miss or mis-target a supersede).
    const appRoot = await makeApp()
    await writeFile(join(appRoot, "dawn.config.ts"), "export default {}\n")
    const routeDir = join(appRoot, "src", "app", "notes")
    await mkdir(routeDir, { recursive: true })
    await writeFile(join(routeDir, "index.ts"), "export const agent = {}\n")
    await writeFile(join(routeDir, "memory.ts"), "export default {{{ not valid ts\n")

    const store = sqliteMemoryStore({ path: join(appRoot, ".dawn/memory.sqlite") })
    await store.put({
      ...baseRecord,
      id: "old",
      status: "active",
      namespace: "route=/notes",
      data: { subject: "acme", predicate: "threshold", value: "500" },
    })
    await store.put({
      ...baseRecord,
      id: "cand",
      status: "candidate",
      namespace: "route=/notes",
      data: { subject: "acme", predicate: "threshold", value: "750" },
    })

    const io = { stdout: () => {}, stderr: () => {} }
    await expect(runMemoryCommand(["approve", "cand"], { cwd: appRoot }, io)).rejects.toThrow(
      /Failed to load .*memory\.ts/,
    )
    // No reconciliation with (fallback) keys happened.
    expect((await store.get("cand"))?.status).toBe("candidate")
    expect((await store.get("old"))?.status).toBe("active")
  })

  it("approve dedupes an identical-data candidate", async () => {
    const appRoot = await makeApp()
    const store = sqliteMemoryStore({ path: join(appRoot, ".dawn/memory.sqlite") })
    await store.put({
      ...baseRecord,
      id: "old",
      status: "active",
      data: { subject: "acme", predicate: "threshold", value: "500" },
    })
    await store.put({
      ...baseRecord,
      id: "cand",
      status: "candidate",
      data: { subject: "acme", predicate: "threshold", value: "500" },
    })

    const lines: string[] = []
    await runMemoryCommand(
      ["approve", "cand"],
      { cwd: appRoot },
      { stdout: (m) => lines.push(m), stderr: () => {} },
    )

    expect(lines.join("\n")).toContain("approved old (deduped)")
    expect(await store.get("cand")).toBeNull()
    expect((await store.get("old"))?.status).toBe("active")
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

  it("prune deletes expired rows and reports counts", async () => {
    const appRoot = await makeApp()
    const store = sqliteMemoryStore({ path: join(appRoot, ".dawn/memory.sqlite") })
    await store.put({
      ...baseRecord,
      id: "expired",
      status: "active",
      expiresAt: "2020-01-01T00:00:00.000Z",
    })
    await store.put({
      ...baseRecord,
      id: "live",
      kind: "episodic",
      status: "active",
      effectiveAt: new Date().toISOString(),
    })

    const lines: string[] = []
    await runMemoryCommand(
      ["prune"],
      { cwd: appRoot },
      { stdout: (m) => lines.push(m), stderr: () => {} },
    )

    const output = lines.join("\n")
    expect(output).toMatch(/1 expired/)
    expect(output).toMatch(/0 over-cap/)
    expect(await store.get("expired")).toBeNull()
    expect(await store.get("live")).not.toBeNull()
  })

  it("prune --cap enforces the episodic cap", async () => {
    const appRoot = await makeApp()
    const store = sqliteMemoryStore({ path: join(appRoot, ".dawn/memory.sqlite") })
    for (let i = 1; i <= 4; i++) {
      await store.put({
        ...baseRecord,
        id: `ep-${i}`,
        kind: "episodic",
        status: "active",
        effectiveAt: `2026-08-0${i}T00:00:00.000Z`,
      })
    }

    const lines: string[] = []
    await runMemoryCommand(
      ["prune", "--cap", "2"],
      { cwd: appRoot },
      { stdout: (m) => lines.push(m), stderr: () => {} },
    )

    // The two oldest (ep-1, ep-2) are pruned; the two newest survive.
    expect(await store.get("ep-1")).toBeNull()
    expect(await store.get("ep-2")).toBeNull()
    expect(await store.get("ep-3")).not.toBeNull()
    expect(await store.get("ep-4")).not.toBeNull()
    expect(lines.join("\n")).toMatch(/2 over-cap/)
  })

  it("prune without --cap defaults to the resolved memory.episodes.cap", async () => {
    const appRoot = await makeApp()
    // Configure a cap of 2; `dawn memory prune` (no --cap) must enforce it —
    // the docs promise the default retention pass applies the configured cap.
    await writeFile(
      join(appRoot, "dawn.config.ts"),
      "export default { memory: { episodes: { cap: 2 } } }\n",
    )
    const store = sqliteMemoryStore({ path: join(appRoot, ".dawn/memory.sqlite") })
    for (let i = 1; i <= 4; i++) {
      await store.put({
        ...baseRecord,
        id: `ep-${i}`,
        kind: "episodic",
        status: "active",
        effectiveAt: `2026-08-0${i}T00:00:00.000Z`,
      })
    }

    const lines: string[] = []
    await runMemoryCommand(
      ["prune"],
      { cwd: appRoot },
      { stdout: (m) => lines.push(m), stderr: () => {} },
    )

    // The two oldest (ep-1, ep-2) are pruned; the two newest survive.
    expect(await store.get("ep-1")).toBeNull()
    expect(await store.get("ep-2")).toBeNull()
    expect(await store.get("ep-3")).not.toBeNull()
    expect(await store.get("ep-4")).not.toBeNull()
    expect(lines.join("\n")).toMatch(/2 over-cap/)
  })

  it("unknown subcommand throws CliError", async () => {
    const appRoot = await makeApp()
    const io = { stdout: () => {}, stderr: () => {} }
    await expect(runMemoryCommand(["badcmd"], { cwd: appRoot }, io)).rejects.toThrow(
      /Unknown subcommand/,
    )
  })
})
