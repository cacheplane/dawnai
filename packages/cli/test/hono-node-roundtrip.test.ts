import { type ChildProcess, spawn } from "node:child_process"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"

import { Client } from "pg"
import { afterAll, beforeAll, describe, expect, test } from "vitest"

import { type Aimock, createAimock } from "../../testing/dist/index.js"
import { createRuntimeFetchHandler as createNodeRuntimeFetchHandler } from "../src/lib/dev/runtime-fetch-handler.js"
import {
  AGUI_HEADERS,
  aguiBody,
  buildFixture,
  createFixtureApp,
  type EdgeContainers,
  edgeBindings,
  eventTypes,
  probeDocker,
  ROUTE_KEY,
  removeFixtureApp,
  replyFor,
  requireDockerFailure,
  startEdgeContainers,
  TURNS,
  turnFixtures,
} from "./helpers/hono-edge-fixture.js"

// ---------------------------------------------------------------------------
// THE HONO-ON-NODE ROUND TRIP — the first test that EXECUTES the emitted files.
//
// Every other suite on this target reads `app.mjs`/`stores.mjs` as text, or
// drives them against stubs. This one builds the fixture app with the `hono`
// target, boots the emitted `app.mjs` — unmodified, in a plain Node child
// process, under `@hono/node-server` — and drives real AG-UI turns over HTTP
// against real Postgres, reached through the same `@neondatabase/serverless`
// WebSocket pool a worker would use.
//
// Ungated: it runs on every CI run, which is the point. The gated workerd lane
// (`workerd-lane.test.ts`) proves the same shape inside the real runtime, from
// the same fixture and the same helper; this proves the emitted files are a
// working program at all, on hardware every contributor has.
//
// …with one qualification, which is why `probeDocker` exists. "Hardware every
// contributor has" is not Docker: before this suite, only the `*-docker` jobs
// needed a daemon and `pnpm test` never did. So it SKIPS without one — and
// because a skip that nobody notices is indistinguishable from a pass, CI sets
// DAWN_REQUIRE_DOCKER=1 on the job that runs `pnpm test`, which turns the skip
// into a hard failure. Both directions are load-bearing.
//
// FOUR requests, not two. The module-scope-pool failure this target is built to
// avoid alternates request-by-request on workerd, so a two-request test passes
// while half of production hangs.
//
// The child process is deliberately NOT given `OPENAI_BASE_URL` in its
// environment. The only path by which the model can reach the local aimock is
// the Workers `env` binding → `seedRuntimeEnv` → `readRuntimeEnv`, so a turn
// that answers at all is itself the proof that the runtime-env seam is wired.
// ---------------------------------------------------------------------------

/**
 * How many `pg_advisory_xact_lock` acquisitions ONE cold start costs: one per
 * store component (threads, permissions, checkpointer), each in its own
 * migration transaction.
 */
const MIGRATION_LOCKS_PER_COLD_START = 3

const docker = await probeDocker()
const requireDocker = process.env.DAWN_REQUIRE_DOCKER === "1"
/** Run when Docker is there — or when a skip is forbidden, so it can FAIL. */
const roundTrip = docker.available || requireDocker ? test : test.skip

const cleanup: Array<() => Promise<void> | void> = []

let containers: EdgeContainers | undefined

beforeAll(async () => {
  if (!docker.available) return
  containers = await startEdgeContainers()
}, 240_000)

afterAll(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
  await containers?.stop()
})

// ---------------------------------------------------------------------------
// Booting the emitted entry
// ---------------------------------------------------------------------------

/**
 * The only file this test adds to the build output: a host adapter, of the kind
 * every non-Workers runtime needs. It supplies the `env` argument Workers would
 * have supplied, and imports `app.mjs` exactly as `wrangler` does — by its
 * default export, untouched.
 *
 * `app.fetch(request, env)` rather than the shorter `serve({ fetch: app.fetch })`
 * ON PURPOSE: passing env explicitly is what makes this a faithful stand-in for
 * a Workers invocation, which is the thing under test. The emitted files also
 * work under the shorter form — DATABASE_URL then falls back to the process
 * environment through `readRuntimeEnv` — but that path proves nothing about
 * bindings, and it would quietly let this suite's OPENAI_BASE_URL omission
 * below stop meaning anything.
 */
const SERVE_ENTRY = `import { serve } from "@hono/node-server"

import app from "./app.mjs"

// The bindings a deployed worker gets from wrangler. Passed as Hono's per
// invocation \`env\`, which is the ONLY channel this process gives the app: its
// own process.env deliberately carries no OPENAI_BASE_URL.
const env = JSON.parse(process.env.DAWN_TEST_WORKER_ENV)

serve({ fetch: (request) => app.fetch(request, env), hostname: "127.0.0.1", port: 0 }, (info) => {
  console.log(JSON.stringify({ port: info.port }))
})
`

interface EmittedServer {
  readonly origin: string
  readonly output: () => string
}

/**
 * Boot the emitted app under `@hono/node-server` in a child process and wait
 * for it to report its port.
 *
 * A child, not an in-process import, for two reasons: vitest's resolver would
 * alias `@dawn-ai/*` to TypeScript sources the emitted files never see, and the
 * process-global `seedRuntimeEnv` state the entry installs belongs to the
 * program under test, not to the test runner.
 */
async function startEmittedServer(
  buildDir: string,
  env: Record<string, string>,
): Promise<EmittedServer> {
  await writeFile(join(buildDir, "serve.test.mjs"), SERVE_ENTRY, "utf8")

  const childEnv: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") childEnv[key] = value
  }
  // The load-bearing omission: the app can only learn the model's base URL
  // through the Workers env binding below.
  delete childEnv.OPENAI_BASE_URL
  // And the same for the database, so a fallback to the process environment
  // cannot stand in for the binding either.
  delete childEnv.DATABASE_URL
  childEnv.OPENAI_API_KEY = childEnv.OPENAI_API_KEY ?? "test-not-used"
  childEnv.DAWN_TEST_WORKER_ENV = JSON.stringify(env)

  const child: ChildProcess = spawn(process.execPath, [join(buildDir, "serve.test.mjs")], {
    cwd: buildDir,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  })
  let output = ""
  child.stdout?.on("data", (chunk: unknown) => {
    output += String(chunk)
  })
  child.stderr?.on("data", (chunk: unknown) => {
    output += String(chunk)
  })
  cleanup.push(
    () =>
      new Promise<void>((done) => {
        if (child.exitCode !== null || child.signalCode !== null) return done()
        child.once("exit", () => done())
        child.kill("SIGKILL")
      }),
  )

  const port = await new Promise<number>((settle, fail) => {
    const timer = setTimeout(
      () => fail(new Error(`emitted app never reported a port. Output:\n${output}`)),
      60_000,
    )
    const finish = (error?: Error, value?: number): void => {
      clearTimeout(timer)
      if (error) fail(error)
      else settle(value as number)
    }
    child.once("error", (error) => finish(error as Error))
    child.once("exit", (code) =>
      finish(new Error(`emitted app exited with code ${code}. Output:\n${output}`)),
    )
    child.stdout?.on("data", () => {
      const match = /\{"port":(\d+)\}/.exec(output)
      if (match?.[1]) finish(undefined, Number(match[1]))
    })
  })

  return { origin: `http://127.0.0.1:${port}`, output: () => output }
}

async function startAimock(): Promise<Aimock> {
  const aimock = await createAimock({ fixtures: [] })
  aimock.addFixtures(turnFixtures())
  cleanup.push(() => aimock.close())
  return aimock
}

// ---------------------------------------------------------------------------
// The Postgres-side observables
// ---------------------------------------------------------------------------

/**
 * Count the migration transactions the database actually served.
 *
 * The log, not a row count: a re-run migration is idempotent, so no table can
 * tell "migrated once" from "migrated on every request" — but every pass takes
 * `pg_advisory_xact_lock`, and the server logs the statement.
 *
 * Log delivery is asynchronous, so the count is taken behind a barrier rather
 * than after a sleep: a uniquely-named statement is issued on a direct
 * connection and the log is read only once that statement appears. Postgres
 * writes its log in order, so everything earlier is already there.
 */
async function countMigrationLocks(client: Client, log: () => string): Promise<number> {
  const marker = `dawn_log_barrier_${Math.random().toString(36).slice(2)}`
  await client.query(`SELECT '${marker}'`)
  const deadline = Date.now() + 60_000
  while (!log().includes(marker)) {
    if (Date.now() > deadline) throw new Error("postgres never logged the barrier statement")
    await new Promise((done) => setTimeout(done, 50))
  }
  return log().split("pg_advisory_xact_lock").length - 1
}

// ---------------------------------------------------------------------------
// The test
// ---------------------------------------------------------------------------

describe("hono target — the emitted app on Node, against real Postgres", () => {
  roundTrip(
    "serves four sequential turns and leaves durable state in Postgres",
    async () => {
      // Reached only under DAWN_REQUIRE_DOCKER=1: without the flag this test is
      // `test.skip` and never runs at all.
      if (!docker.available || !containers) throw requireDockerFailure(docker)

      const appRoot = await createFixtureApp("dawn-hono-roundtrip-")
      cleanup.push(() => removeFixtureApp(appRoot))
      const buildDir = await buildFixture(appRoot)

      // ---- The node baseline -------------------------------------------------
      // The same fixture, the same turn, through the node handler in-process —
      // the AG-UI shape the rest of Dawn is held to. Captured BEFORE the edge run
      // so a later failure cannot be explained away by shared state: it uses its
      // own aimock and its own (sqlite, on-disk) stores.
      const nodeAimock = await startAimock()
      const previousBaseUrl = process.env.OPENAI_BASE_URL
      process.env.OPENAI_BASE_URL = nodeAimock.baseUrl
      process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "test-not-used"
      cleanup.push(() => {
        if (previousBaseUrl === undefined) delete process.env.OPENAI_BASE_URL
        else process.env.OPENAI_BASE_URL = previousBaseUrl
      })
      const nodeHandler = await createNodeRuntimeFetchHandler({ appRoot })
      let nodeEventTypes: string[]
      try {
        const response = await nodeHandler.fetch(
          new Request(`http://localhost/agui/${ROUTE_KEY}`, {
            body: aguiBody("th-node", TURNS[0], 0),
            headers: AGUI_HEADERS,
            method: "POST",
          }),
        )
        expect(response.status).toBe(200)
        nodeEventTypes = eventTypes(await response.text())
      } finally {
        await nodeHandler.close()
      }
      // An anchor before the comparison: two equally-broken runs must not be able
      // to agree on an empty or truncated stream.
      expect(nodeEventTypes[0]).toBe("RUN_STARTED")
      expect(nodeEventTypes.at(-1)).toBe("RUN_FINISHED")
      expect(nodeEventTypes).toContain("TEXT_MESSAGE_CONTENT")

      // ---- The emitted entry, booted for real --------------------------------
      const edgeAimock = await startAimock()
      const server = await startEmittedServer(
        buildDir,
        edgeBindings(containers, {
          OPENAI_API_KEY: "test-not-used",
          OPENAI_BASE_URL: edgeAimock.baseUrl,
        }),
      )

      const threadId = "th-edge-roundtrip"
      const edgeEventTypes: string[][] = []
      for (const [index, userMessage] of TURNS.entries()) {
        const response = await fetch(`${server.origin}/agui/${ROUTE_KEY}`, {
          body: aguiBody(threadId, userMessage, index),
          headers: AGUI_HEADERS,
          method: "POST",
        })
        expect(
          response.status,
          `turn ${index + 1} failed. Server output:\n${server.output()}`,
        ).toBe(200)
        const sse = await response.text()
        expect(
          sse,
          `turn ${index + 1} produced no events. Server output:\n${server.output()}`,
        ).not.toBe("")
        edgeEventTypes.push(eventTypes(sse))
        // The reply really came from the model, which the process could only
        // reach through the seeded OPENAI_BASE_URL.
        expect(sse).toContain(replyFor(userMessage))
      }

      // 1. All four turns completed, and the first matches the node path exactly.
      expect(edgeEventTypes[0]).toEqual(nodeEventTypes)
      // …and so did the other three: the module-scope-pool failure alternates,
      // so the later turns are the ones that matter.
      for (const types of edgeEventTypes) expect(types).toEqual(nodeEventTypes)

      // 2. The conversation was read BACK out of Postgres between requests: the
      // fourth model request carries the first turn's message, which only the
      // checkpoint written by request 1 and loaded by request 4 can supply.
      const modelRequests = edgeAimock.getRequests()
      expect(modelRequests).toHaveLength(TURNS.length)
      expect(JSON.stringify(modelRequests.at(-1)?.body?.messages)).toContain(TURNS[0])

      // 3. The rows themselves, over a direct TCP connection — not the WebSocket
      // pool the app used, and not inferred from an HTTP response.
      const client = new Client({ connectionString: containers.postgres.getConnectionUri() })
      await client.connect()
      try {
        const threads = await client.query<{ thread_id: string; status: string }>(
          "SELECT thread_id, status FROM dawn_threads",
        )
        // `idle` and not `busy`: the run's own bookkeeping write, issued after
        // the stream finished, landed on a pool that was still open. A pool
        // closed when `fetch` resolved rather than when the body settled would
        // leave this thread wedged at `busy` while every turn still looked fine
        // over HTTP.
        expect(threads.rows).toEqual([{ status: "idle", thread_id: threadId }])

        const checkpoints = await client.query<{ n: string }>(
          "SELECT count(*) AS n FROM dawn_checkpoints WHERE thread_id = $1",
          [threadId],
        )
        expect(Number(checkpoints.rows[0]?.n)).toBeGreaterThanOrEqual(TURNS.length)

        const writes = await client.query<{ n: string }>(
          "SELECT count(*) AS n FROM dawn_writes WHERE thread_id = $1",
          [threadId],
        )
        expect(Number(writes.rows[0]?.n)).toBeGreaterThan(0)

        // 4. Migrations ran ONCE for the isolate, not once per request. Without
        // the `assumeMigrated` flag the emitted stores.mjs carries, each request
        // pays three migration transactions — every one of them taking an
        // advisory lock that also serializes concurrent requests.
        expect(await countMigrationLocks(client, containers.log)).toBe(
          MIGRATION_LOCKS_PER_COLD_START,
        )
      } finally {
        await client.end()
      }
    },
    240_000,
  )
})
