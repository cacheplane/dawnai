import { type ChildProcess, spawn } from "node:child_process"
import { existsSync, mkdirSync, rmSync } from "node:fs"
import { createServer } from "node:net"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { sqliteMemoryStore } from "@dawn-ai/memory"
import { afterAll, beforeAll, expect, it } from "vitest"

const gated = process.env.DAWN_TEST_INSPECTOR === "1"
const pkgRoot = fileURLToPath(new URL("..", import.meta.url))
const fixtureApp = join(pkgRoot, "test/fixtures/app")
const serverJs = join(pkgRoot, ".next/standalone/packages/inspector/server.js")

let child: ChildProcess | undefined
let base = ""

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.on("error", reject)
    srv.unref()
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address()
      if (address && typeof address === "object") srv.close(() => resolve(address.port))
      else reject(new Error("no port"))
    })
  })
}

async function waitReady(url: string): Promise<void> {
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(url)
      if (res.ok) return
    } catch {}
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`server never became ready at ${url}`)
}

beforeAll(async () => {
  if (!gated) return
  if (!existsSync(serverJs)) {
    throw new Error(`${serverJs} missing — run \`pnpm --filter @dawn-ai/inspector build\` first`)
  }
  rmSync(join(fixtureApp, ".dawn"), { recursive: true, force: true })
  mkdirSync(join(fixtureApp, ".dawn"), { recursive: true })
  const store = sqliteMemoryStore({ path: join(fixtureApp, ".dawn", "memory.sqlite") })
  await store.put({
    id: "memory_spike_1",
    kind: "semantic",
    namespace: "route=/notes",
    content: "spike memory row",
    data: { subject: "spike", predicate: "works", value: "yes" },
    source: { type: "tool", id: "remember" },
    confidence: 1,
    tags: [],
    status: "candidate",
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
  })
  const port = await freePort()
  base = `http://127.0.0.1:${port}`
  const spawned = spawn(process.execPath, [serverJs], {
    env: { ...process.env, DAWN_APP_ROOT: fixtureApp, PORT: String(port), HOSTNAME: "127.0.0.1" },
    stdio: "inherit",
  })
  child = spawned
  // Fail fast if the server dies at startup instead of polling out the clock.
  const exited = new Promise<never>((_, reject) => {
    spawned.once("exit", (code, signal) => {
      reject(new Error(`inspector server exited before ready (code ${code}, signal ${signal})`))
    })
  })
  await Promise.race([waitReady(`${base}/healthz`), exited])
})

afterAll(async () => {
  const spawned = child
  if (spawned && spawned.exitCode === null && spawned.signalCode === null) {
    // SIGTERM → short grace → SIGKILL, and await the exit before cleaning up
    // the fixture .dawn dir the server may still have open.
    const exited = new Promise<void>((resolve) => {
      spawned.once("exit", () => resolve())
    })
    spawned.kill("SIGTERM")
    const backstop = setTimeout(() => spawned.kill("SIGKILL"), 2_000)
    await exited
    clearTimeout(backstop)
  }
  rmSync(join(fixtureApp, ".dawn"), { recursive: true, force: true })
})

it.skipIf(!gated)("serves the live config-defined store through the API", async () => {
  const res = await fetch(`${base}/api/memory/list`)
  expect(res.status).toBe(200)
  const body = (await res.json()) as { records: { id: string; content: string }[] }
  expect(body.records.map((r) => r.id)).toContain("memory_spike_1")
})
