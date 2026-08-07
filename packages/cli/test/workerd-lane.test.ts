import { type ChildProcess, spawn } from "node:child_process"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"

import { Client } from "pg"
import { afterAll, beforeAll, describe, expect, test } from "vitest"

import { type Aimock, createAimock } from "../../testing/dist/index.js"
import {
  AGUI_HEADERS,
  aguiBody,
  buildFixture,
  createFixtureApp,
  type EdgeContainers,
  edgeBindings,
  eventTypes,
  freePort,
  ROUTE_KEY,
  removeFixtureApp,
  replyFor,
  repoRoot,
  startEdgeContainers,
  TURNS,
  turnFixtures,
} from "./helpers/hono-edge-fixture.js"

// ---------------------------------------------------------------------------
// THE WORKERD LANE — the merge gate for the whole edge claim.
//
// A Dawn app, built by `dawn build` with the `hono` target and deployed exactly
// as an operator would (the emitted `wrangler.toml`, untouched, plus a
// `.dev.vars` standing in for `wrangler secret`), serving real AG-UI turns with
// DURABLE POSTGRES STATE inside real Cloudflare workerd. No Cloudflare account
// is involved: `wrangler dev --local` runs the same workerd binary the platform
// runs, against local containers.
//
// Gated on DAWN_TEST_WORKERD=1 — it needs Docker, the workerd binary, and about
// a minute. The ungated round-trip beside it (`hono-node-roundtrip.test.ts`)
// covers the same fixture on Node every run.
//
// ASSERT ON THE PAYLOAD, NEVER THE STATUS. A dead model wiring still returns
// HTTP 200 with an SSE stream — the round-trip found that the hard way — so
// every turn below is checked for the model's actual reply text.
//
// WHAT THIS LANE CANNOT SETTLE, even once it is green: workerd-in-miniflare does
// not enforce Cloudflare's ~6-simultaneous-outbound-connection cap or the
// 1000-subrequest limit, and a wsproxy on the same machine hides per-query
// latency — which matters, because `putWrites` issues one INSERT per write
// inside the transaction. Hyperdrive is untested here; it needs an account.
//
// ═══════════════════════════════════════════════════════════════════════════
// ⚠ THIS LANE IS RED AS OF 2026-08-07, AND THAT IS ITS FINDING.
//
// It is deliberately NOT wired into CI yet — an `edge-workerd` job would red
// every pull request. Both blockers below live outside this file, and both were
// reduced to standalone reproductions rather than inferred.
//
// BLOCKER 1 — the bundle does not link. wrangler fails at startup with:
//
//   Uncaught Error: No such module "node:async_hooks". imported from "app.js"
//   …The package "node:async_hooks" wasn't found… Imported from:
//     @langchain/core/dist/callbacks/dispatch/index.js
//
//   ONE specifier, and it is Dawn's own: `packages/langchain/src` imports
//   `dispatchCustomEvent` from "@langchain/core/callbacks/dispatch" in
//   `tool-converter.ts` and `subagent-tool-bridge.ts`. That entry statically
//   imports `node:async_hooks` so it can INFER the config off AsyncLocalStorage
//   when a caller omits it. Upstream ships "@langchain/core/callbacks/dispatch/web"
//   for exactly this case; it requires an explicit config, which BOTH Dawn call
//   sites already pass. Switching the two imports makes the bundle link (an
//   esbuild scan on `platform: browser` then reports zero `node:` specifiers)
//   and the worker boot — verified locally. The ALS instance the default entry
//   installs as a side effect is unaffected on Node: `@langchain/langgraph`'s
//   main entry installs it too, and Dawn always loads that (checked directly).
//
//   NOT DONE HERE because two tests inherited from main —
//   `packages/langchain/test/{tool-converter,planning}.test.ts` — do
//   `vi.mock("@langchain/core/callbacks/dispatch", …)`, so the source change
//   forces a one-token edit to each mock specifier. That is a call for whoever
//   owns those files. Note the `fetch-entry-purity` gate structurally cannot
//   catch this class: it externalizes `@langchain/*`.
//
// BLOCKER 2 — behind it, and larger. With blocker 1 patched locally, the worker
// boots and the FIRST request is served end to end: `GET /healthz` returns 200,
// which means the per-request Neon pool connected through the wsproxy and all
// three migrations ran inside workerd. Every request AFTER the first fails:
//
//   Error: Cannot perform I/O on behalf of a different request. I/O objects
//   (such as streams, request/response bodies, and others) created in the
//   context of one request handler cannot be accessed from a different
//   request's handler. (I/O type: RefcountedCanceler)
//     at Object.fetch (…/lib/dev/runtime-fetch-core.js)
//
//   The cause is `runtime-fetch-core.ts`'s handler-scoped `shutdownController`
//   (`const shutdownController = new AbortController()`). On workerd the
//   handler is necessarily constructed inside the FIRST request — global scope
//   cannot build one, since `new AbortController()` there is itself a
//   "Disallowed operation called within global scope" — so the controller
//   belongs to request one's I/O context, and requests two onward throw the
//   moment anything touches `shutdownController.signal`: the `.aborted` read in
//   the catch, the `dispatch(…, signal)` hand-off, and the three
//   `runRegistry.begin(threadId, signal)` calls.
//
//   Reduced to a twelve-line worker with no Dawn code in it: lazily create one
//   AbortController on the first request and read `.signal.aborted`. Request
//   one answers `{"first":true,"readAborted":false}`; every later request
//   throws. `AbortSignal.any([…])` over it throws identically.
//
//   This is not a storage finding, and an in-memory fallback would not dodge
//   it: a Dawn app on workerd currently serves exactly ONE request per isolate.
//   The fix is to make the shutdown signal per-request — the file already has
//   the pattern (`getRunRegistry(request)`, `getCheckpointer(request)`), so it
//   becomes `getShutdownSignal(request)` with `close()` aborting the live set —
//   but that changes shutdown/drain semantics the node path depends on, and
//   `runtime-fetch-core.ts` belongs to another task in this plan.
//
// Leave the assertions below exactly as they are. They are what the edge claim
// has to survive, and softening them to get a green is the one thing that would
// make this file worse than not having it.
// ═══════════════════════════════════════════════════════════════════════════
// ---------------------------------------------------------------------------

const enabled = process.env.DAWN_TEST_WORKERD === "1"
const workerdTest = enabled ? test : test.skip

/**
 * How long `wrangler dev` gets to bundle the worker and report a listening
 * address. ~18s on a loaded developer machine; the budget is generous because
 * the failure mode being guarded against is a hung startup, not a slow one.
 */
const WRANGLER_READY_TIMEOUT_MS = 120_000

const cleanup: Array<() => Promise<void> | void> = []

let containers: EdgeContainers | undefined

beforeAll(async () => {
  if (!enabled) return
  containers = await startEdgeContainers()
}, 300_000)

afterAll(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
  await containers?.stop()
})

// ---------------------------------------------------------------------------
// wrangler
// ---------------------------------------------------------------------------

interface WorkerdServer {
  readonly origin: string
  readonly output: () => string
  /** The output, after giving wrangler time to flush an async crash report. */
  readonly settledOutput: () => Promise<string>
}

/**
 * Boot the built fixture under `wrangler dev --local` and wait for it to serve.
 *
 * Bindings are supplied through `.dev.vars`, which is wrangler's own local
 * stand-in for `wrangler secret put` — deliberately NOT by editing the emitted
 * `wrangler.toml`, which stays exactly as `dawn build` wrote it so that what
 * boots here is what an operator deploys. If the scaffold ever needs a
 * `nodejs_compat` flag or a `compatibility_flags` entry to work, this lane goes
 * red rather than quietly compensating.
 */
async function startWorkerd(
  appRoot: string,
  bindings: Readonly<Record<string, string>>,
): Promise<WorkerdServer> {
  await writeFile(
    join(appRoot, ".dev.vars"),
    `${Object.entries(bindings)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n")}\n`,
    "utf8",
  )

  const port = await freePort()
  const wrangler = join(repoRoot, "packages", "cli", "node_modules", ".bin", "wrangler")
  const child: ChildProcess = spawn(
    wrangler,
    ["dev", "--local", "--ip", "127.0.0.1", "--port", String(port)],
    {
      cwd: appRoot,
      env: {
        ...process.env,
        // No account, no telemetry, no interactive dev session.
        CI: "1",
        WRANGLER_SEND_METRICS: "false",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  )
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
        // SIGTERM first: wrangler owns a workerd child of its own, and SIGKILL
        // to the parent leaves it holding the port.
        child.kill("SIGTERM")
        setTimeout(() => child.kill("SIGKILL"), 5_000).unref()
      }),
  )

  const origin = `http://127.0.0.1:${port}`
  const deadline = Date.now() + WRANGLER_READY_TIMEOUT_MS
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`wrangler exited with code ${child.exitCode}. Output:\n${output}`)
    }
    if (Date.now() > deadline) {
      throw new Error(`wrangler never became ready in ${WRANGLER_READY_TIMEOUT_MS}ms:\n${output}`)
    }
    // `/healthz` and not the log line: "Ready on …" is printed before the
    // worker has necessarily linked, and a link failure (a stray `node:`
    // import) surfaces as a 500 rather than a missing line. A 200 here means
    // the bundle loaded AND the per-request store factory reached Postgres
    // through the proxy — the two things most likely to be broken.
    try {
      const response = await fetch(`${origin}/healthz`)
      if (response.ok) break
    } catch {
      // Not listening yet.
    }
    await new Promise((done) => setTimeout(done, 500))
  }

  // Anything workerd fails to link with is reported as a build warning by
  // wrangler and as a 500 by the worker; both are in `output`. Fail loudly on
  // the specific compensation this lane exists to forbid.
  if (output.includes("nodejs_compat")) {
    throw new Error(
      `wrangler asked for the nodejs_compat flag, which this target deliberately omits — the ` +
        `emitted bundle reached a node: builtin. Fix the import, do not add the flag:\n${output}`,
    )
  }

  return {
    origin,
    output: () => output,
    settledOutput: async () => {
      await new Promise((done) => setTimeout(done, 3_000))
      return output
    },
  }
}

async function startAimock(): Promise<Aimock> {
  const aimock = await createAimock({ fixtures: [] })
  aimock.addFixtures(turnFixtures())
  cleanup.push(() => aimock.close())
  return aimock
}

// ---------------------------------------------------------------------------
// The test
// ---------------------------------------------------------------------------

describe("hono target — the emitted app inside real Cloudflare workerd", () => {
  workerdTest(
    "serves four sequential turns and leaves durable state in Postgres",
    async () => {
      if (!containers) throw new Error("containers were not started")

      const appRoot = await createFixtureApp("dawn-workerd-lane-")
      cleanup.push(() => removeFixtureApp(appRoot))
      await buildFixture(appRoot)

      const aimock = await startAimock()
      const server = await startWorkerd(
        appRoot,
        edgeBindings(containers, {
          OPENAI_API_KEY: "test-not-used",
          // The model is reachable ONLY through this binding: workerd has no
          // `process`, so the value can only arrive via the Workers env →
          // `seedRuntimeEnv` → `readRuntimeEnv` seam. A turn that answers is
          // itself the proof that seam works in the runtime it was built for.
          OPENAI_BASE_URL: aimock.baseUrl,
        }),
      )

      const threadId = "th-workerd-lane"
      const turnEventTypes: string[][] = []

      // ---- 1. Four sequential turns, each answered by the real model -------
      // FOUR, not two: the module-scope-pool failure this target avoids
      // alternates request-by-request, so a two-request test passes while half
      // of production hangs for ~30s until workerd cancels it.
      for (const [index, userMessage] of TURNS.entries()) {
        const response = await fetch(`${server.origin}/agui/${ROUTE_KEY}`, {
          body: aguiBody(threadId, userMessage, index),
          headers: AGUI_HEADERS,
          method: "POST",
        })
        const sse = await response.text()
        if (response.status !== 200) {
          // Built by hand, not as an `expect` message, because the log is only
          // worth reading after a pause: workerd reports an uncaught exception
          // through wrangler asynchronously, so a message assembled the instant
          // the response lands says "Internal Server Error" and nothing more.
          // An `expect` message argument would pay that pause on every passing
          // turn as well.
          expect.fail(
            `turn ${index + 1} answered ${response.status}. Body:\n${sse}\n` +
              `Worker output:\n${await server.settledOutput()}`,
          )
        }
        // The payload, never the status: a dead model wiring still answers 200
        // with a well-formed but empty stream.
        expect(sse, `turn ${index + 1} carried no model reply:\n${server.output()}`).toContain(
          replyFor(userMessage),
        )
        const types = eventTypes(sse)
        expect(types[0]).toBe("RUN_STARTED")
        expect(types.at(-1)).toBe("RUN_FINISHED")
        expect(types).toContain("TEXT_MESSAGE_CONTENT")
        turnEventTypes.push(types)
      }

      // Every turn produced the identical AG-UI shape — the later ones are the
      // ones that matter, for the alternating-failure reason above.
      for (const types of turnEventTypes) expect(types).toEqual(turnEventTypes[0])

      // ---- 2. The model was genuinely reached, four times ------------------
      const modelRequests = aimock.getRequests()
      expect(modelRequests).toHaveLength(TURNS.length)
      // And the conversation was read BACK out of Postgres between requests:
      // the fourth model request carries the first turn's message, which only
      // the checkpoint written by request 1 and loaded by request 4 supplies.
      expect(JSON.stringify(modelRequests.at(-1)?.body?.messages)).toContain(TURNS[0])

      // ---- 3. The rows, out of band ----------------------------------------
      // A direct TCP client — not the WebSocket pool the worker used, and not
      // inferred from any HTTP response.
      const client = new Client({ connectionString: containers.postgres.getConnectionUri() })
      await client.connect()
      try {
        const threads = await client.query<{ thread_id: string; status: string }>(
          "SELECT thread_id, status FROM dawn_threads",
        )
        // `idle`, not `busy`: the run's bookkeeping write is issued AFTER the
        // SSE body finishes, so this is also the assertion that the per-request
        // pool outlived the response on workerd rather than being torn down
        // when `fetch` resolved.
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
      } finally {
        await client.end()
      }
    },
    600_000,
  )
})
