import { type ChildProcess, spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { Client } from "pg"
import {
  GenericContainer,
  Network,
  type StartedNetwork,
  type StartedTestContainer,
  Wait,
} from "testcontainers"
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest"

import { type Aimock, type AimockFixture, createAimock } from "../../testing/dist/index.js"
import { runBuildCommand } from "../src/commands/build.js"
import { createRuntimeFetchHandler as createNodeRuntimeFetchHandler } from "../src/lib/dev/runtime-fetch-handler.js"

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
// proves the same shape inside the real runtime; this proves the emitted files
// are a working program at all, on hardware every contributor has.
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

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..")

/** The route the fixture serves, and the AG-UI key for it. */
const ROUTE_KEY = encodeURIComponent("/chat#agent")

/** Requests driven through the emitted entry. Four is the floor, not a target. */
const TURNS = ["turn one", "turn two", "turn three", "turn four"] as const

/**
 * How many `pg_advisory_xact_lock` acquisitions ONE cold start costs: one per
 * store component (threads, permissions, checkpointer), each in its own
 * migration transaction.
 */
const MIGRATION_LOCKS_PER_COLD_START = 3

/**
 * The WebSocket-to-TCP proxy, pinned by digest rather than `:latest`.
 *
 * This lane is ungated — it runs on every CI run — so a floating tag would let
 * an upstream push red every pull request at once. The digest is the
 * multi-arch OCI index (linux/amd64 for CI, linux/arm64 for a developer's Mac),
 * verified 2026-08-07.
 */
const WSPROXY_IMAGE =
  "ghcr.io/neondatabase/wsproxy@sha256:7f2e2149aa6a57ba382a140102fba44f5053f3e44389ccc18adcecf896054efb"

const cleanup: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

// ---------------------------------------------------------------------------
// Containers
//
// Postgres and a WebSocket-to-TCP proxy on one user-defined network. The proxy
// is not scaffolding for the test's convenience: the emitted `stores.mjs`
// connects with `@neondatabase/serverless`, which speaks the Postgres wire
// protocol over a WebSocket, and a stock Postgres does not accept one. It is
// the same pairing the gated workerd lane uses.
//
// `log_statement=all` turns the server's own log into the observable for
// "migrations ran once" — see `countMigrationLocks`.
// ---------------------------------------------------------------------------

let network: StartedNetwork
let postgres: StartedPostgreSqlContainer
let wsproxy: StartedTestContainer
/** Everything Postgres has logged since it started, as it arrives. */
let postgresLog = ""

beforeAll(async () => {
  network = await new Network().start()
  postgres = await new PostgreSqlContainer("postgres:16-alpine")
    .withNetwork(network)
    .withNetworkAliases("dawn-pg")
    .withCommand(["postgres", "-c", "log_statement=all"])
    .withStartupTimeout(180_000)
    .start()
  const logs = await postgres.logs()
  logs.on("data", (chunk: unknown) => {
    postgresLog += String(chunk)
  })
  wsproxy = await new GenericContainer(WSPROXY_IMAGE)
    .withNetwork(network)
    // Any address: the only thing reachable on this network is the database
    // container beside it.
    .withEnvironment({ ALLOW_ADDR_REGEX: ".*" })
    .withExposedPorts(80)
    .withWaitStrategy(Wait.forListeningPorts())
    .withStartupTimeout(180_000)
    .start()
}, 240_000)

afterAll(async () => {
  await wsproxy?.stop().catch(() => {})
  await postgres?.stop().catch(() => {})
  await network?.stop().catch(() => {})
})

// ---------------------------------------------------------------------------
// Fixture app
// ---------------------------------------------------------------------------

/**
 * Packages the emitted files import by bare specifier, symlinked into the
 * fixture's own `node_modules`.
 *
 * The child process is plain Node with no vitest resolver, so every one of
 * these is resolved for real, from `dist`. That is deliberate: it is the same
 * resolution a deployed bundle performs, and it means this suite fails if the
 * published entry points ever stop lining up with what the target emits.
 */
const LINKED_PACKAGES: readonly (readonly [string, string])[] = [
  // app.mjs + modules.edge.mjs
  ["@dawn-ai/cli", join(repoRoot, "packages", "cli")],
  ["hono", join(repoRoot, "packages", "cli", "node_modules", "hono")],
  ["@hono/node-server", join(repoRoot, "packages", "cli", "node_modules", "@hono", "node-server")],
  // stores.mjs
  ["@dawn-ai/postgres-storage", join(repoRoot, "packages", "postgres-storage")],
  [
    "@neondatabase/serverless",
    join(repoRoot, "packages", "cli", "node_modules", "@neondatabase", "serverless"),
  ],
  // the route module, and the provider package app.mjs's static importer names
  ["@dawn-ai/sdk", join(repoRoot, "packages", "sdk")],
  [
    "@langchain/openai",
    join(repoRoot, "packages", "langchain", "node_modules", "@langchain", "openai"),
  ],
]

async function createFixtureApp(): Promise<string> {
  // realpath: macOS tmpdir sits behind a /var → /private/var symlink and the
  // loader resolves module URLs to real paths — keep every path resolved.
  const appRoot = await realpath(await mkdtemp(join(tmpdir(), "dawn-hono-roundtrip-")))
  cleanup.push(() => rm(appRoot, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 }))

  const files: Record<string, string> = {
    "dawn.config.ts": 'export default { build: { targets: ["hono"] } }\n',
    "package.json": `${JSON.stringify({
      dependencies: {
        "@dawn-ai/cli": "workspace:*",
        "@dawn-ai/postgres-storage": "workspace:*",
        "@neondatabase/serverless": "^1.1.0",
        hono: "^4.12.28",
      },
      name: "hono-roundtrip-fixture",
      type: "module",
    })}\n`,
    "src/app/chat/index.ts": `import { agent } from "@dawn-ai/sdk"

export default agent({
  model: "gpt-5-mini",
  systemPrompt: "Answer questions.",
})
`,
  }
  await Promise.all(
    Object.entries(files).map(async ([relativePath, source]) => {
      const filePath = join(appRoot, relativePath)
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, source, "utf8")
    }),
  )

  for (const [name, target] of LINKED_PACKAGES) {
    if (!existsSync(target)) throw new Error(`fixture dependency not installed: ${target}`)
    const linkPath = join(appRoot, "node_modules", ...name.split("/"))
    await mkdir(dirname(linkPath), { recursive: true })
    await symlink(target, linkPath, "dir")
  }

  return appRoot
}

/** Build the fixture with the `hono` target, returning `.dawn/build`. */
async function buildFixture(appRoot: string): Promise<string> {
  await runBuildCommand({ clean: true, cwd: appRoot }, { stderr: () => {}, stdout: () => {} })
  const buildDir = join(appRoot, ".dawn", "build")
  for (const name of ["app.mjs", "stores.mjs", "modules.edge.mjs"]) {
    expect(existsSync(join(buildDir, name))).toBe(true)
  }
  return buildDir
}

// ---------------------------------------------------------------------------
// Booting the emitted entry
// ---------------------------------------------------------------------------

/**
 * The only file this test adds to the build output: a host adapter, of the kind
 * every non-Workers runtime needs. It supplies the `env` argument Workers would
 * have supplied, and imports `app.mjs` exactly as `wrangler` does — by its
 * default export, untouched.
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

// ---------------------------------------------------------------------------
// Driving turns
// ---------------------------------------------------------------------------

/** One AG-UI turn's request body. */
function aguiBody(threadId: string, userMessage: string, index: number): string {
  return JSON.stringify({
    context: [],
    forwardedProps: {},
    messages: [{ content: userMessage, id: `u${index}`, role: "user" }],
    runId: `rn-${index}`,
    state: {},
    threadId,
    tools: [],
  })
}

const AGUI_HEADERS = {
  accept: "text/event-stream",
  "content-type": "application/json",
} as const

/** Parse an SSE body (`data: <json>\n\n` frames) into event payloads. */
function parseSseEvents(text: string): unknown[] {
  return text
    .split("\n\n")
    .map((block) =>
      block
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice("data: ".length))
        .join(""),
    )
    .filter((data) => data.length > 0)
    .map((data) => JSON.parse(data) as unknown)
}

function eventTypes(sse: string): string[] {
  return parseSseEvents(sse).map((event) =>
    typeof (event as { type?: unknown }).type === "string"
      ? (event as { type: string }).type
      : "<no-type>",
  )
}

/** One aimock reply per turn, matched on the message that turn sends. */
function turnFixtures(): AimockFixture[] {
  return TURNS.map((userMessage, index) => ({
    match: { turnIndex: index, userMessage },
    response: { content: `ack ${userMessage}` },
  }))
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
async function countMigrationLocks(client: Client): Promise<number> {
  const marker = `dawn_log_barrier_${Math.random().toString(36).slice(2)}`
  await client.query(`SELECT '${marker}'`)
  const deadline = Date.now() + 60_000
  while (!postgresLog.includes(marker)) {
    if (Date.now() > deadline) throw new Error("postgres never logged the barrier statement")
    await new Promise((done) => setTimeout(done, 50))
  }
  return postgresLog.split("pg_advisory_xact_lock").length - 1
}

// ---------------------------------------------------------------------------
// The test
// ---------------------------------------------------------------------------

describe("hono target — the emitted app on Node, against real Postgres", () => {
  test("serves four sequential turns and leaves durable state in Postgres", async () => {
    const appRoot = await createFixtureApp()
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
    const server = await startEmittedServer(buildDir, {
      DATABASE_URL: `postgres://${postgres.getUsername()}:${postgres.getPassword()}@dawn-pg:5432/${postgres.getDatabase()}`,
      // Bare host:port — `@neondatabase/serverless` prefixes the scheme itself.
      DAWN_PG_WS_PROXY: `${wsproxy.getHost()}:${wsproxy.getMappedPort(80)}`,
      OPENAI_API_KEY: "test-not-used",
      OPENAI_BASE_URL: edgeAimock.baseUrl,
    })

    const threadId = "th-edge-roundtrip"
    const edgeEventTypes: string[][] = []
    for (const [index, userMessage] of TURNS.entries()) {
      const response = await fetch(`${server.origin}/agui/${ROUTE_KEY}`, {
        body: aguiBody(threadId, userMessage, index),
        headers: AGUI_HEADERS,
        method: "POST",
      })
      expect(response.status, `turn ${index + 1} failed. Server output:\n${server.output()}`).toBe(
        200,
      )
      const sse = await response.text()
      expect(
        sse,
        `turn ${index + 1} produced no events. Server output:\n${server.output()}`,
      ).not.toBe("")
      edgeEventTypes.push(eventTypes(sse))
      // The reply really came from the model, which the process could only
      // reach through the seeded OPENAI_BASE_URL.
      expect(sse).toContain(`ack ${userMessage}`)
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
    const client = new Client({ connectionString: postgres.getConnectionUri() })
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
      expect(await countMigrationLocks(client)).toBe(MIGRATION_LOCKS_PER_COLD_START)
    } finally {
      await client.end()
    }
  }, 240_000)
})
