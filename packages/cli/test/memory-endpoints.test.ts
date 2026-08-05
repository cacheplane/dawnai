import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { MemoryRecord } from "@dawn-ai/memory"
import { sqliteMemoryStore } from "@dawn-ai/memory"
import { afterEach, describe, expect, test } from "vitest"

import { startRuntimeServer } from "../src/lib/dev/runtime-server.js"

const tempDirs: string[] = []
const servers: Array<{ close: () => Promise<void> }> = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })))
})

describe("memory-candidate HTTP endpoints", () => {
  test("GET /memory/candidates lists seeded candidates", async () => {
    const appRoot = await createFixtureApp()
    await seedRecord(appRoot, {
      id: "memory_cand_list",
      content: "The user prefers concise summaries.",
      status: "candidate",
    })
    const server = await startRuntimeServer({ appRoot })
    servers.push(server)

    const response = await fetch(new URL("/memory/candidates", server.url))
    expect(response.status).toBe(200)
    const body = (await response.json()) as { candidates: MemoryRecord[] }
    expect(body.candidates).toHaveLength(1)
    expect(body.candidates[0]?.id).toBe("memory_cand_list")
    expect(body.candidates[0]?.status).toBe("candidate")
  })

  test("POST /memory/candidates/:id/approve flips a candidate to active", async () => {
    const appRoot = await createFixtureApp()
    await seedRecord(appRoot, {
      id: "memory_cand_approve",
      content: "The user wants primary sources cited.",
      status: "candidate",
    })
    const server = await startRuntimeServer({ appRoot })
    servers.push(server)

    const response = await fetch(
      new URL("/memory/candidates/memory_cand_approve/approve", server.url),
      { method: "POST" },
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      record: MemoryRecord
      action: string
      superseded: MemoryRecord[]
    }
    expect(body.record.id).toBe("memory_cand_approve")
    expect(body.record.status).toBe("active")
    expect(body.action).toBe("activated")
    expect(body.superseded).toEqual([])

    // No longer a candidate.
    const listResponse = await fetch(new URL("/memory/candidates", server.url))
    const listBody = (await listResponse.json()) as { candidates: MemoryRecord[] }
    expect(listBody.candidates.find((rec) => rec.id === "memory_cand_approve")).toBeUndefined()
  })

  test("POST /memory/candidates/:id/approve supersedes a contradicting active record", async () => {
    const appRoot = await createFixtureApp()
    // Same identity (default keys [subject, predicate]), different value —
    // approval must supersede the active row, not leave two actives.
    await seedRecord(appRoot, {
      id: "memory_active_old",
      content: "The user prefers long summaries.",
      status: "active",
      data: { subject: "user", predicate: "prefers", object: "long summaries" },
    })
    await seedRecord(appRoot, {
      id: "memory_cand_contradiction",
      content: "The user prefers short summaries.",
      status: "candidate",
      data: { subject: "user", predicate: "prefers", object: "short summaries" },
    })
    const server = await startRuntimeServer({ appRoot })
    servers.push(server)

    const response = await fetch(
      new URL("/memory/candidates/memory_cand_contradiction/approve", server.url),
      { method: "POST" },
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      record: MemoryRecord
      action: string
      superseded: MemoryRecord[]
    }
    expect(body.record.id).toBe("memory_cand_contradiction")
    expect(body.record.status).toBe("active")
    expect(body.action).toBe("superseded")
    expect(body.superseded.map((rec) => rec.id)).toEqual(["memory_active_old"])

    // The old record is demoted in the store — no two-actives state.
    const store = sqliteMemoryStore({ path: join(appRoot, ".dawn", "memory.sqlite") })
    const oldRecord = await store.get("memory_active_old")
    expect(oldRecord?.status).toBe("superseded")
    const approved = await store.get("memory_cand_contradiction")
    expect(approved?.status).toBe("active")
    expect(approved?.supersedes).toContain("memory_active_old")
  })

  test("POST /memory/candidates/:id/approve returns 404 for an unknown id", async () => {
    const appRoot = await createFixtureApp()
    const server = await startRuntimeServer({ appRoot })
    servers.push(server)

    const response = await fetch(new URL("/memory/candidates/no-such-id/approve", server.url), {
      method: "POST",
    })
    expect(response.status).toBe(404)
    const body = (await response.json()) as { error?: { kind?: string; message?: string } }
    expect(body.error?.kind).toBe("request_error")
    expect(body.error?.message).toMatch(/no-such-id/)
  })

  test("POST /memory/candidates/:id/approve returns 409 for a non-candidate record", async () => {
    const appRoot = await createFixtureApp()
    await seedRecord(appRoot, {
      id: "memory_already_active",
      content: "Already active, not a candidate.",
      status: "active",
    })
    const server = await startRuntimeServer({ appRoot })
    servers.push(server)

    const response = await fetch(
      new URL("/memory/candidates/memory_already_active/approve", server.url),
      { method: "POST" },
    )
    expect(response.status).toBe(409)
    const body = (await response.json()) as { error?: { kind?: string; message?: string } }
    expect(body.error?.kind).toBe("request_error")
    expect(body.error?.message).toMatch(/not a candidate/)
  })

  test("POST /memory/candidates/:id/reject deletes the record", async () => {
    const appRoot = await createFixtureApp()
    await seedRecord(appRoot, {
      id: "memory_cand_reject",
      content: "The user wants footnotes.",
      status: "candidate",
    })
    const server = await startRuntimeServer({ appRoot })
    servers.push(server)

    const response = await fetch(
      new URL("/memory/candidates/memory_cand_reject/reject", server.url),
      { method: "POST" },
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as { ok: boolean }
    expect(body.ok).toBe(true)

    // Gone: a follow-up approve on the same id now 404s.
    const approveResponse = await fetch(
      new URL("/memory/candidates/memory_cand_reject/approve", server.url),
      { method: "POST" },
    )
    expect(approveResponse.status).toBe(404)
  })
})

async function seedRecord(
  appRoot: string,
  overrides: Pick<MemoryRecord, "id" | "content" | "status"> & Partial<Pick<MemoryRecord, "data">>,
): Promise<void> {
  const store = sqliteMemoryStore({ path: join(appRoot, ".dawn", "memory.sqlite") })
  const record: MemoryRecord = {
    kind: "semantic",
    namespace: "workspace=fixture|route=/noop",
    data: {},
    source: { type: "eval", id: "seed" },
    confidence: 1,
    tags: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  }
  await store.put(record)
}

async function createFixtureApp(): Promise<string> {
  const appRoot = await mkdtemp(join(tmpdir(), "dawn-cli-memory-endpoints-"))
  tempDirs.push(appRoot)
  const files: Readonly<Record<string, string>> = {
    "dawn.config.ts": "export default {};\n",
    "package.json": "{}\n",
    "src/app/noop/index.ts": "export const graph = async () => ({ ok: true });\n",
  }
  await Promise.all(
    Object.entries(files).map(async ([relativePath, source]) => {
      const filePath = join(appRoot, relativePath)
      await mkdir(join(filePath, ".."), { recursive: true })
      await writeFile(filePath, source, "utf8")
    }),
  )
  return appRoot
}
