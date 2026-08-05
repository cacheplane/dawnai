import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { PermissionsStore } from "@dawn-ai/permissions"
import type { ThreadsStore } from "@dawn-ai/sqlite-storage"
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createRuntimeFetchHandler } from "../src/lib/dev/runtime-fetch-handler.js"
import { prepareRouteExecution } from "../src/lib/runtime/execute-route.js"

// Count sqlite store constructions at the seam execute-route.ts actually
// calls: createThreadsStore / sqliteCheckpointer each open exactly one
// DatabaseSync via the package-internal openDb, so counting factory calls
// counts sqlite opens. The mock passes through to the real implementations.
vi.mock("@dawn-ai/sqlite-storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dawn-ai/sqlite-storage")>()
  return {
    ...actual,
    createThreadsStore: vi.fn(actual.createThreadsStore),
    sqliteCheckpointer: vi.fn(actual.sqliteCheckpointer),
  }
})

import { createThreadsStore, sqliteCheckpointer } from "@dawn-ai/sqlite-storage"

const cleanup: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

async function fixtureApp(overrides: Record<string, string> = {}): Promise<string> {
  const appRoot = await mkdtemp(join(tmpdir(), "dawn-boot-passthrough-"))
  cleanup.push(() => rm(appRoot, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 }))
  const files: Record<string, string> = {
    "dawn.config.ts": "export default {}\n",
    "package.json": '{ "name": "boot-passthrough-fixture", "type": "module" }\n',
    "src/app/probe/index.ts": "export const workflow = async (_input: unknown) => ({ ok: true })\n",
    ...overrides,
  }
  for (const [rel, body] of Object.entries(files)) {
    const filePath = join(appRoot, rel)
    await mkdir(join(filePath, ".."), { recursive: true })
    await writeFile(filePath, body, "utf8")
  }
  return appRoot
}

/** Fixture whose workflow route reads a file OUTSIDE the workspace via ctx.fs,
 * so every request runs the permission gate against the live store. The route
 * catches the denial so the AP runs/wait output reports the decision. */
async function permissionProbeApp(): Promise<{ appRoot: string; secretPath: string }> {
  const appRoot = await mkdtemp(join(tmpdir(), "dawn-boot-passthrough-perm-"))
  cleanup.push(() => rm(appRoot, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 }))
  const secretPath = join(appRoot, "secret.txt")
  const files: Record<string, string> = {
    "dawn.config.ts": "export default {}\n",
    "package.json": '{ "name": "boot-passthrough-perm-fixture", "type": "module" }\n',
    "secret.txt": "top-secret",
    "src/app/probe/index.ts": [
      "export const workflow = async (",
      "  _input: unknown,",
      "  ctx: { fs: { readFile: (path: string) => Promise<string> } },",
      ") => {",
      "  try {",
      `    const content = await ctx.fs.readFile(${JSON.stringify(secretPath)})`,
      "    return { allowed: true, content }",
      "  } catch (error) {",
      "    return { allowed: false, message: String(error) }",
      "  }",
      "}",
      "",
    ].join("\n"),
  }
  for (const [rel, body] of Object.entries(files)) {
    const filePath = join(appRoot, rel)
    await mkdir(join(filePath, ".."), { recursive: true })
    await writeFile(filePath, body, "utf8")
  }
  return { appRoot, secretPath }
}

function fakePermissionsStore(): PermissionsStore {
  return {
    addAllow: async () => {},
    load: async () => {},
    match: () => "unknown" as const,
    mode: "interactive" as const,
  }
}

async function runsWait(
  handler: Awaited<ReturnType<typeof createRuntimeFetchHandler>>,
  threadId: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await handler.fetch(
    new Request(`http://localhost/threads/${threadId}/runs/wait`, {
      body: JSON.stringify({ input: {}, route: "/probe#workflow" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }),
  )
  return { body: (await response.json()) as Record<string, unknown>, status: response.status }
}

async function writeAllowAllReads(appRoot: string): Promise<void> {
  const dir = join(appRoot, ".dawn")
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, "permissions.json"),
    `${JSON.stringify({ version: 1, allow: { readFile: ["/"] }, deny: {} }, null, 2)}\n`,
    "utf8",
  )
}

// ---------------------------------------------------------------------------
// (a) Identity: boot-resolved instances flow into the execution context
// ---------------------------------------------------------------------------

describe("prepareRouteExecution — boot-instance passthrough", () => {
  it("uses the exact provided checkpointer/threadsStore/permissionsStore instances", async () => {
    const appRoot = await fixtureApp()
    const checkpointer = { __probe: "checkpointer" } as unknown as BaseCheckpointSaver
    const threadsStore = { __probe: "threadsStore" } as unknown as ThreadsStore
    const permissionsStore = fakePermissionsStore()

    const prepared = await prepareRouteExecution({
      appRoot,
      checkpointer,
      permissionsStore,
      routeFile: join(appRoot, "src/app/probe/index.ts"),
      routeId: "/probe",
      routePath: "src/app/probe/index.ts",
      threadsStore,
    })

    if (!prepared.ok) throw new Error(`route prep failed: ${prepared.message}`)
    expect(prepared.checkpointer).toBe(checkpointer)
    expect(prepared.threadsStore).toBe(threadsStore)
    expect(prepared.permissionsStore).toBe(permissionsStore)
  })

  it("awaits a permissions-store factory and uses its result", async () => {
    const appRoot = await fixtureApp()
    const permissionsStore = fakePermissionsStore()
    const factory = vi.fn(async () => permissionsStore)

    const prepared = await prepareRouteExecution({
      appRoot,
      permissionsStore: factory,
      routeFile: join(appRoot, "src/app/probe/index.ts"),
      routeId: "/probe",
      routePath: "src/app/probe/index.ts",
    })

    if (!prepared.ok) throw new Error(`route prep failed: ${prepared.message}`)
    expect(factory).toHaveBeenCalledTimes(1)
    expect(prepared.permissionsStore).toBe(permissionsStore)
  })
})

// ---------------------------------------------------------------------------
// (b) No per-request sqlite opens through the fetch handler
// ---------------------------------------------------------------------------

describe("createRuntimeFetchHandler — no per-request sqlite opens", () => {
  it("constructs no new threads/checkpoint stores after boot across sequential requests", async () => {
    const appRoot = await fixtureApp()
    const handler = await createRuntimeFetchHandler({ appRoot })
    cleanup.push(() => handler.close())

    const threadsOpensAtBoot = vi.mocked(createThreadsStore).mock.calls.length
    const checkpointerOpensAtBoot = vi.mocked(sqliteCheckpointer).mock.calls.length

    const first = await runsWait(handler, "th-boot-1")
    expect(first.status).toBe(200)
    expect(first.body).toEqual({ ok: true })

    const second = await runsWait(handler, "th-boot-2")
    expect(second.status).toBe(200)
    expect(second.body).toEqual({ ok: true })

    expect(vi.mocked(createThreadsStore).mock.calls.length).toBe(threadsOpensAtBoot)
    expect(vi.mocked(sqliteCheckpointer).mock.calls.length).toBe(checkpointerOpensAtBoot)
  }, 30_000)
})

// ---------------------------------------------------------------------------
// (c) Permissions dev-freshness: per-request re-load vs boot snapshot
// ---------------------------------------------------------------------------

describe("createRuntimeFetchHandler — permissions mode", () => {
  it("per-request (default): an Always grant written mid-process applies on the next request", async () => {
    const { appRoot } = await permissionProbeApp()
    const handler = await createRuntimeFetchHandler({ appRoot })
    cleanup.push(() => handler.close())

    const before = await runsWait(handler, "th-perm-fresh-1")
    expect(before.status).toBe(200)
    expect(before.body.allowed).toBe(false)

    await writeAllowAllReads(appRoot)

    const after = await runsWait(handler, "th-perm-fresh-2")
    expect(after.status).toBe(200)
    expect(after.body).toEqual({ allowed: true, content: "top-secret" })
  }, 30_000)

  it("boot mode: the boot snapshot is used — a grant written mid-process is NOT re-read", async () => {
    const { appRoot } = await permissionProbeApp()
    const handler = await createRuntimeFetchHandler({ appRoot, permissionsMode: "boot" })
    cleanup.push(() => handler.close())

    const before = await runsWait(handler, "th-perm-boot-1")
    expect(before.status).toBe(200)
    expect(before.body.allowed).toBe(false)

    await writeAllowAllReads(appRoot)

    const after = await runsWait(handler, "th-perm-boot-2")
    expect(after.status).toBe(200)
    expect(after.body.allowed).toBe(false)
  }, 30_000)
})
