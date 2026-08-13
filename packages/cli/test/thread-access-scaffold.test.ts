import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"

import { createRuntimeFetchHandler } from "../src/lib/dev/runtime-fetch-handler.js"
import { loadThreadAccess } from "../src/lib/dev/thread-access-node.js"

/**
 * The SCAFFOLD, executed rather than grepped.
 *
 * `packages/devkit/test/template-thread-access.test.ts` string-matches the
 * template — it can say the file contains a deny, never what the deny does to a
 * request. This file copies the real `thread-access.ts.example` and
 * `auth.ts.example` into a fixture app, loads them through the real loader, and
 * drives the real endpoints, so the scaffold's documented behavior is pinned by
 * the thing that actually decides it.
 *
 * It lives in `packages/cli` because that is where the runtime handler is; the
 * devkit package cannot import it without a build cycle.
 */

const cleanup: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

const TRIVIAL_ROUTE = "export const graph = async () => ({ ok: true })\n"
const ROUTE_KEY = "/hello#graph"

/** The shipped scaffold, verbatim. Not a paraphrase of it. */
const templateSource = (name: string): Promise<string> =>
  readFile(
    fileURLToPath(
      new URL(`../../devkit/templates/app-basic/src/${name}.ts.example`, import.meta.url),
    ),
    "utf8",
  )

type Handler = Awaited<ReturnType<typeof createRuntimeFetchHandler>>

async function setup(): Promise<Handler> {
  const appRoot = await mkdtemp(join(tmpdir(), "dawn-thread-access-scaffold-"))
  cleanup.push(() => rm(appRoot, { force: true, recursive: true }))
  const files: Record<string, string> = {
    "dawn.config.ts": "export default {}\n",
    "package.json": '{ "name": "thread-access-scaffold-fixture", "type": "module" }\n',
    "src/app/hello/index.ts": TRIVIAL_ROUTE,
    // The rename the scaffold's own header tells the app to do.
    "src/auth.ts": await templateSource("auth"),
    "src/thread-access.ts": await templateSource("thread-access"),
  }
  for (const [relativePath, source] of Object.entries(files)) {
    const filePath = join(appRoot, relativePath)
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, source, "utf8")
  }
  // Through the real loader, so a template that stopped binding a policy fails
  // here rather than silently running this suite with no gate at all.
  const threadAccess = await loadThreadAccess(appRoot)
  expect(typeof threadAccess?.fallback).toBe("function")
  const handler = await createRuntimeFetchHandler({
    appRoot,
    drainDeadlineMs: 250,
    ...(threadAccess ? { threadAccess } : {}),
  })
  cleanup.push(() => handler.close())
  return handler
}

/** The scaffolded `principalOf` reads exactly these two headers. */
const ALICE: Record<string, string> = { "x-user-id": "alice", "x-user-org": "acme" }
const BOB: Record<string, string> = { "x-user-id": "bob", "x-user-org": "acme" }
const ANONYMOUS: Record<string, string> = {}

function post(path: string, payload?: unknown, headers: Record<string, string> = {}): Request {
  return new Request(new URL(path, "http://localhost"), {
    headers: { "content-type": "application/json", ...headers },
    method: "POST",
    ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
  })
}

function runStream(threadId: string, headers: Record<string, string>): Request {
  return post(`/threads/${threadId}/runs/stream`, { input: {}, route: ROUTE_KEY }, headers)
}

/** The body CopilotKit posts: the thread id is chosen in the browser. */
function aguiTurn(threadId: string, headers: Record<string, string>): Request {
  return new Request(new URL(`/agui/${encodeURIComponent(ROUTE_KEY)}`, "http://localhost"), {
    body: JSON.stringify({
      context: [],
      forwardedProps: {},
      messages: [{ content: "hi", id: "m1", role: "user" }],
      runId: "r1",
      state: {},
      threadId,
      tools: [],
    }),
    headers: { accept: "text/event-stream", "content-type": "application/json", ...headers },
    method: "POST",
  })
}

async function drain(response: Response): Promise<void> {
  const reader = response.body?.getReader()
  if (!reader) return
  while (!(await reader.read()).done) {
    // Runs release their slot on drain; nothing here reads the frames.
  }
}

/** Mint a thread the way the scaffold supports: server-generated id, stamped owner. */
async function mintThread(handler: Handler, headers: Record<string, string>): Promise<string> {
  const created = await handler.fetch(post("/threads", {}, headers))
  expect(created.status).toBe(200)
  return ((await created.json()) as { readonly thread_id: string }).thread_id
}

describe("the scaffolded thread-access policy, driven end to end", () => {
  it("serves the owner and denies everyone else, on every axis", async () => {
    const handler = await setup()
    const threadId = await mintThread(handler, ALICE)

    const mine = await handler.fetch(runStream(threadId, ALICE))
    expect(mine.status).toBe(200)
    await drain(mine)

    const theirs = await handler.fetch(runStream(threadId, BOB))
    expect(theirs.status).toBe(403)
    await drain(theirs)

    const anon = await handler.fetch(runStream(threadId, ANONYMOUS))
    expect(anon.status).toBe(403)
    await drain(anon)

    expect(
      (await handler.fetch(new Request(`http://localhost/threads/${threadId}`, { headers: ALICE })))
        .status,
    ).toBe(200)
    expect(
      (await handler.fetch(new Request(`http://localhost/threads/${threadId}`, { headers: BOB })))
        .status,
    ).toBe(404)
    expect(
      (
        await handler.fetch(
          new Request(`http://localhost/threads/${threadId}`, { headers: BOB, method: "DELETE" }),
        )
      ).status,
    ).toBe(403)
  }, 30_000)

  it("runs AG-UI turns on a thread the caller minted, and keeps running them", async () => {
    const handler = await setup()
    // The recipe the scaffold documents for a client that picks its own thread
    // id: mint the id through POST /threads, which is the ONLY path that stamps
    // an owner, then hand that id to the AG-UI client as its `threadId`.
    const threadId = await mintThread(handler, ALICE)

    const first = await handler.fetch(aguiTurn(threadId, ALICE))
    expect(first.status).toBe(200)
    await drain(first)

    // The second turn, deliberately. A thread whose row exists but carries no
    // stamp is admin-only under this policy, so a recipe that authorizes turn
    // one and denies turn two would pass a one-turn test and brick a real
    // conversation.
    const second = await handler.fetch(aguiTurn(threadId, ALICE))
    expect(second.status).toBe(200)
    await drain(second)

    const intruder = await handler.fetch(aguiTurn(threadId, BOB))
    expect(intruder.status).toBe(403)
    await drain(intruder)
  }, 30_000)

  it("denies a run on an unminted id, identically for every caller", async () => {
    const handler = await setup()
    const threadId = "t-client-chosen"

    // The scaffold's documented limitation, pinned so it stays a decision. The
    // run endpoints create the row they are given, and that implicit create
    // writes NO access stamp — so there is no owner for a later turn to match,
    // and permitting the first turn here would authorize a thread that nothing
    // can own afterwards. The scaffold denies instead, and says so.
    const authenticated = await handler.fetch(aguiTurn(threadId, ALICE))
    const other = await handler.fetch(aguiTurn(threadId, BOB))
    const anonymous = await handler.fetch(aguiTurn(threadId, ANONYMOUS))

    expect(authenticated.status).toBe(403)
    expect(other.status).toBe(403)
    expect(anonymous.status).toBe(403)

    // And no row was created by the denial, so a denied caller cannot squat an
    // id the way an allowed one would.
    const probe = await handler.fetch(
      new Request(`http://localhost/threads/${threadId}`, { headers: ALICE }),
    )
    expect(probe.status).toBe(404)

    const streamed = await handler.fetch(runStream(threadId, ALICE))
    expect(streamed.status).toBe(403)
    await drain(streamed)
  }, 30_000)

  it("keeps the missing-row oracle shut on read and delete", async () => {
    const handler = await setup()
    const owned = await mintThread(handler, ALICE)

    // "not yours" and "never existed" must be the same answer, or a caller who
    // can guess ids learns which ones are real.
    const notYours = await handler.fetch(
      new Request(`http://localhost/threads/${owned}`, { headers: BOB }),
    )
    const neverExisted = await handler.fetch(
      new Request("http://localhost/threads/t-never-existed", { headers: BOB }),
    )
    expect(notYours.status).toBe(neverExisted.status)
    expect(await notYours.text()).toBe(await neverExisted.text())
    expect(notYours.status).toBe(404)

    const deleteNotYours = await handler.fetch(
      new Request(`http://localhost/threads/${owned}`, { headers: BOB, method: "DELETE" }),
    )
    const deleteNeverExisted = await handler.fetch(
      new Request("http://localhost/threads/t-never-existed", { headers: BOB, method: "DELETE" }),
    )
    expect(deleteNotYours.status).toBe(deleteNeverExisted.status)
    expect(await deleteNotYours.text()).toBe(await deleteNeverExisted.text())
    expect(deleteNotYours.status).toBe(403)
  }, 30_000)
})
