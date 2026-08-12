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

/** Gated in PR A: the five endpoints that ran no middleware at all. */
const GATED: readonly string[] = [
  routeKey("POST", /^\/threads(?:\?.*)?$/),
  routeKey("GET", /^\/threads\/(?<thread_id>[^/?#]+)(?:\?.*)?$/),
  routeKey("DELETE", /^\/threads\/(?<thread_id>[^/?#]+)(?:\?.*)?$/),
  routeKey("GET", /^\/threads\/(?<thread_id>[^/?#]+)\/state(?:\?.*)?$/),
  routeKey("POST", /^\/threads\/(?<thread_id>[^/?#]+)\/cancel(?:\?.*)?$/),
]

/**
 * Thread-scoped and NOT gated by this PR — they are gated by route middleware
 * only. PR B moves the first four onto GATED. `POST /agui/:routeId` is on this
 * list precisely because its pattern contains no "threads" — it still resolves
 * a client-supplied thread id, creates the row and writes its metadata.
 *
 * `GET /pending_interrupts` arrived with PR #443, which gates it on ROUTE
 * IDENTITY. Whether it also moves onto the thread-access axis in PR B is the
 * spec's open question and is still undecided; it sits here either way, because
 * under both answers this PR leaves it gated by route middleware alone. If the
 * answer is "one axis" it joins GATED in PR B; if it is "two axes" it moves to
 * its own documented list rather than staying here.
 */
const DEFERRED: readonly string[] = [
  routeKey("POST", /^\/threads\/(?<thread_id>[^/?#]+)\/runs\/stream(?:\?.*)?$/),
  routeKey("POST", /^\/threads\/(?<thread_id>[^/?#]+)\/runs\/wait(?:\?.*)?$/),
  routeKey("POST", /^\/threads\/(?<thread_id>[^/?#]+)\/resume(?:\?.*)?$/),
  routeKey("POST", /^\/agui\/(?<routeId>[^/?#]+)(?:\?.*)?$/),
  routeKey("GET", /^\/threads\/(?<thread_id>[^/?#]+)\/pending_interrupts(?:\?.*)?$/),
]

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
    // DEFERRED) rather than counted, which is the whole point of this pair of
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
