import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { ThreadAccessPolicy, ThreadOperation } from "@dawn-ai/sdk"
import { afterEach, describe, expect, it } from "vitest"

import { buildRouteTable } from "../src/lib/dev/runtime-fetch-core.js"
import { createRuntimeFetchHandler } from "../src/lib/dev/runtime-fetch-handler.js"

const cleanup: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

function routeKey(method: string, pattern: RegExp): string {
  return `${method} ${pattern.source}`
}

/**
 * Gated in PR A: the five endpoints that ran no middleware at all.
 *
 * Gated in PR B: the four run endpoints (`runs/stream`, `runs/wait`,
 * `resume`, and `POST /agui/:routeId`, which carries no "threads" in its
 * pattern but still resolves a client-supplied thread id) plus
 * `GET /pending_interrupts`. That last one is the exception whose gating is
 * not the whole story: it arrived with PR #443 already gated on ROUTE
 * IDENTITY, and PR B adds the thread-access axis on top, the two composing as
 * AND rather than one replacing the other. The endpoint reads back the parked
 * prompt's `interruptId`/`resumeKey` pair — the credential for resuming
 * someone else's turn — and middleware that merely authenticates admits every
 * caller alike, so the weaker gate cannot be the one in front of it.
 */
const GATED: readonly string[] = [
  routeKey("POST", /^\/threads(?:\?.*)?$/),
  routeKey("GET", /^\/threads\/(?<thread_id>[^/?#]+)(?:\?.*)?$/),
  routeKey("DELETE", /^\/threads\/(?<thread_id>[^/?#]+)(?:\?.*)?$/),
  routeKey("GET", /^\/threads\/(?<thread_id>[^/?#]+)\/state(?:\?.*)?$/),
  routeKey("POST", /^\/threads\/(?<thread_id>[^/?#]+)\/cancel(?:\?.*)?$/),
  routeKey("POST", /^\/threads\/(?<thread_id>[^/?#]+)\/runs\/stream(?:\?.*)?$/),
  routeKey("POST", /^\/threads\/(?<thread_id>[^/?#]+)\/runs\/wait(?:\?.*)?$/),
  routeKey("POST", /^\/threads\/(?<thread_id>[^/?#]+)\/resume(?:\?.*)?$/),
  routeKey("POST", /^\/agui\/(?<routeId>[^/?#]+)(?:\?.*)?$/),
  routeKey("GET", /^\/threads\/(?<thread_id>[^/?#]+)\/pending_interrupts(?:\?.*)?$/),
]

/**
 * Empty since PR B. Every thread-scoped route is now gated on the thread-access
 * axis. A new thread endpoint belongs on GATED; putting it here again needs a
 * reason written down, because "deferred" was a slice boundary, not a category.
 */
const DEFERRED: readonly string[] = []

/**
 * Not thread-scoped, so there is no thread subject to authorize against. A
 * memory candidate is addressed by candidate id, with no thread id in its route
 * and no ThreadsStore read on its path. That a candidate may have been
 * distilled FROM a thread's conversation is real, and it means memory needs its
 * own authorization story — it does not make it a thread-access one.
 */
const EXEMPT: readonly string[] = [
  routeKey("GET", /^\/healthz(?:\?.*)?$/),
  routeKey("GET", /^\/memory\/candidates(?:\?.*)?$/),
  routeKey("POST", /^\/memory\/candidates\/(?<id>[^/?#]+)\/approve(?:\?.*)?$/),
  routeKey("POST", /^\/memory\/candidates\/(?<id>[^/?#]+)\/reject(?:\?.*)?$/),
]

// The ctx is never read: buildRouteTable only destructures it and closes over
// the values, and this test invokes no handler.
const routes = buildRouteTable({} as unknown as Parameters<typeof buildRouteTable>[0])
const actual = routes.map((route) => `${route.method} ${route.pattern.source}`)

describe("route-table coverage", () => {
  it("has 14 entries on this branch", () => {
    // 14 since PR #443 merged and this branch took `main` in, adding
    // `GET /threads/:thread_id/pending_interrupts`. It is CLASSIFIED (see
    // GATED) rather than counted, which is the whole point of this pair of
    // assertions: bumping the number without adding the route to a list would
    // let a new thread endpoint ship ungated and silent.
    expect(actual).toHaveLength(14)
  })

  it("classifies every route as gated, deferred or exempt", () => {
    const classified = new Set([...GATED, ...DEFERRED, ...EXEMPT])
    expect(actual.filter((key) => !classified.has(key))).toEqual([])
  })

  it("lists no route that the table does not serve", () => {
    const served = new Set(actual)
    expect([...GATED, ...DEFERRED, ...EXEMPT].filter((key) => !served.has(key))).toEqual([])
  })

  it("keys on method AND pattern, so GET and DELETE on one pattern stay distinct", () => {
    expect(new Set(actual).size).toBe(actual.length)
    const sharedPattern = /^\/threads\/(?<thread_id>[^/?#]+)(?:\?.*)?$/.source
    expect(actual.filter((key) => key.endsWith(sharedPattern))).toHaveLength(2)
  })
})

describe("emitted thread operations", () => {
  it("emits exactly the five thread.* members in PR A", async () => {
    const emitted: ThreadOperation[] = []
    const policy: ThreadAccessPolicy = {
      fallback: (req) => {
        emitted.push(req.operation)
        return { decision: "allow" }
      },
    }
    const appRoot = await mkdtemp(join(tmpdir(), "dawn-thread-access-coverage-"))
    cleanup.push(() => rm(appRoot, { force: true, recursive: true }))
    for (const [relativePath, source] of Object.entries({
      "dawn.config.ts": "export default {}\n",
      "package.json": '{ "name": "coverage-fixture", "type": "module" }\n',
      "src/app/hello/index.ts": "export const graph = async () => ({ ok: true })\n",
    })) {
      const filePath = join(appRoot, relativePath)
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, source, "utf8")
    }
    const handler = await createRuntimeFetchHandler({ appRoot, threadAccess: policy })
    cleanup.push(() => handler.close())

    const created = await handler.fetch(new Request("http://localhost/threads", { method: "POST" }))
    const { thread_id } = (await created.json()) as { thread_id: string }
    await handler.fetch(new Request(`http://localhost/threads/${thread_id}`))
    await handler.fetch(new Request(`http://localhost/threads/${thread_id}/state`))
    await handler.fetch(
      new Request(`http://localhost/threads/${thread_id}/cancel`, { method: "POST" }),
    )
    await handler.fetch(new Request(`http://localhost/threads/${thread_id}`, { method: "DELETE" }))

    // thread.create appears twice per create — once as action "create", once as
    // the action "update" recheck against the row the store returned.
    expect(emitted).toEqual([
      "thread.create",
      "thread.create",
      "thread.get",
      "thread.state",
      "thread.cancel",
      "thread.delete",
    ])
    expect(new Set(emitted)).toEqual(
      new Set(["thread.create", "thread.get", "thread.state", "thread.cancel", "thread.delete"]),
    )
  })
})
