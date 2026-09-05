import assert from "node:assert/strict"
import test from "node:test"
import { createGitHubReader } from "../adapters/github.mjs"
import { createHttpGet } from "../adapters/http.mjs"

const json = (value, headers = {}) =>
  new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json", etag: 'W/"one"', ...headers },
  })
const unchanged = (etag = '"one"', headers = {}) =>
  new Response(null, { status: 304, headers: { etag, ...headers } })
const reader = (fetchImpl, options = {}) =>
  createGitHubReader({
    owner: "cacheplane",
    repo: "dawnai",
    token: "fixture",
    fetchImpl,
    conditionalReads: true,
    ...options,
  })

test("HTTP explicitly retains an empty conditional 304 and its validator", async () => {
  const http = createHttpGet({ fetchImpl: async () => unchanged() })
  const result = await http.getJson({ url: "https://api.github.com/x", allowNotModified: true })
  assert.equal(result.status, "NOT_MODIFIED")
  assert.equal(result.httpStatus, 304)
  assert.equal(result.headers.etag, '"one"')
  assert.equal(result.bodyBytes, 0)
})
test("recovery objects require fresh matching server revalidation and preserve HTTP 304", async () => {
  const calls = []
  const github = reader(async (_url, init) => {
    calls.push(init)
    return calls.length === 1 ? json({ id: 1 }) : unchanged()
  })
  const first = await github.getRepository()
  assert.throws(() => {
    first.value.id = 999
  }, TypeError)
  const second = await github.getRepository()
  assert.equal(calls[1].headers["If-None-Match"], 'W/"one"')
  assert.equal(second.status, "PRESENT")
  assert.equal(second.httpStatus, 304)
  assert.equal(second.code, "NOT_MODIFIED")
  assert.equal(second.value.id, 1)
})
test("a complete single-page collection revalidates with its total; array inventories do not", async () => {
  const calls = []
  const github = reader(async (_url, init) => {
    calls.push(init)
    return calls.length === 1
      ? json({ total_count: 1, workflows: [{ id: 2, name: "fixture" }] })
      : unchanged()
  })
  await github.listRepositoryWorkflowsComplete()
  const result = await github.listRepositoryWorkflowsComplete()
  assert.equal(result.status, "PRESENT")
  assert.equal(result.httpStatus, 304)
  assert.equal(result.value.length, 1)
  const inventoryCalls = []
  const inventory = reader(async (_url, init) => {
    inventoryCalls.push(init)
    return json([])
  })
  await inventory.listReleaseAssets({ releaseId: 1 })
  await inventory.listReleaseAssets({ releaseId: 1 })
  assert.equal(inventoryCalls[1].headers["If-None-Match"], undefined)
})
test("legacy readers remain unconditional", async () => {
  const calls = []
  const github = reader(
    async (_url, init) => {
      calls.push(init)
      return json({ id: 1 })
    },
    { conditionalReads: false },
  )
  await github.getRepository()
  await github.getRepository()
  assert.equal(calls[1].headers["If-None-Match"], undefined)
})

for (const status of [401, 403, 404, 429, 500])
  test(`HTTP ${status} cannot reuse or retain prior authority`, async () => {
    const calls = []
    const github = reader(async (_url, init) => {
      calls.push(init)
      return calls.length === 1
        ? json({ id: 1 })
        : calls.length === 2
          ? new Response('{"message":"failed"}', {
              status,
              headers: { "content-type": "application/json" },
            })
          : json({ id: 2 })
    })
    await github.getRepository()
    assert.notEqual((await github.getRepository()).status, "PRESENT")
    assert.equal((await github.getRepository()).value.id, 2)
    assert.equal(calls[2].headers["If-None-Match"], undefined)
  })
for (const tag of ['"different"', "*", "malformed", 'W/""'])
  test(`mismatched or malformed 304 validator ${tag} fails closed`, async () => {
    let n = 0
    const github = reader(async () => (++n === 1 ? json({ id: 1 }) : unchanged(tag)))
    await github.getRepository()
    assert.notEqual((await github.getRepository()).status, "PRESENT")
  })
test("304 with pagination headers cannot reuse a single-page collection", async () => {
  let n = 0
  const github = reader(async () =>
    ++n === 1
      ? json({ total_count: 0, workflows: [] })
      : unchanged('"one"', {
          link: '<https://api.github.com/repos/cacheplane/dawnai/actions/workflows?page=2>; rel="next"',
        }),
  )
  await github.listRepositoryWorkflowsComplete()
  assert.notEqual((await github.listRepositoryWorkflowsComplete()).status, "PRESENT")
})
test("unconditional changed response replaces the validator", async () => {
  const calls = []
  const github = reader(async (_url, init) => {
    calls.push(init)
    return calls.length === 1
      ? json({ id: 1 })
      : calls.length === 2
        ? json({ id: 2 }, { etag: '"two"' })
        : unchanged('W/"two"')
  })
  await github.getRepository()
  await github.getRepository()
  assert.equal((await github.getRepository()).value.id, 2)
  assert.equal(calls[2].headers["If-None-Match"], '"two"')
})
test("disposed recovery reads cannot contact the server", async () => {
  let n = 0
  const github = reader(async () => {
    n++
    return json({ id: 1 })
  })
  await github.getRepository()
  github.dispose()
  assert.notEqual((await github.getRepository()).status, "PRESENT")
  assert.equal(n, 1)
})
test("late successful reads cannot repopulate a disposed runtime", async () => {
  let finish
  const github = reader(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const pending = github.getRepository()
  github.dispose()
  finish(json({ id: 1 }))
  assert.notEqual((await pending).status, "PRESENT")
})
test("a later failed overlapping read invalidates an earlier in-flight representation", async () => {
  let n = 0,
    finish
  const calls = []
  const github = reader(async (_url, init) => {
    calls.push(init)
    n++
    if (n === 2)
      return new Promise((resolve) => {
        finish = resolve
      })
    return n === 3
      ? new Response("{}", { status: 403, headers: { "content-type": "application/json" } })
      : json({ id: 1 })
  })
  await github.getRepository()
  const pending = github.getRepository()
  assert.notEqual((await github.getRepository()).status, "PRESENT")
  finish(unchanged())
  assert.notEqual((await pending).status, "PRESENT")
  await github.getRepository()
  assert.equal(calls[3].headers["If-None-Match"], undefined)
})
test("runtime expiry and clock reversal never return retained data", async () => {
  for (const clock of [1_200_000, -1, NaN]) {
    let current = 0,
      n = 0
    const github = reader(
      async () => {
        n++
        return json({ id: 1 })
      },
      { now: () => current },
    )
    await github.getRepository()
    current = clock
    assert.notEqual((await github.getRepository()).status, "PRESENT")
    assert.equal(n, 1)
  }
})

test("retained bytes obey the current predicate and byte budget", async () => {
  const { createConditionalJsonReader } = await import("../adapters/conditional-json.mjs")
  for (const [maxResponseBytes, canRetain] of [
    [1, () => true],
    [1024, () => false],
  ]) {
    let n = 0
    const client = createConditionalJsonReader({
      http: createHttpGet({ fetchImpl: async () => (++n === 1 ? json({ id: 1 }) : unchanged()) }),
    })
    const request = {
      url: "https://api.github.com/a",
      headers: { Authorization: "Bearer fixture" },
    }
    await client.getJson(request, { canRetain: () => true })
    assert.equal(
      (await client.getJson({ ...request, maxResponseBytes }, { canRetain })).status,
      "ERROR",
    )
  }
})
test("conditional state is isolated by URL, credential, API version and reader instance", async () => {
  const { createConditionalJsonReader } = await import("../adapters/conditional-json.mjs")
  const calls = []
  const http = createHttpGet({
    fetchImpl: async (_url, init) => {
      calls.push(init)
      return json({ id: 1 })
    },
  })
  const client = createConditionalJsonReader({ http })
  const request = {
    url: "https://api.github.com/a",
    headers: { Authorization: "Bearer one", "X-GitHub-Api-Version": "2022-11-28" },
  }
  await client.getJson(request, { canRetain: () => true })
  for (const changed of [
    { ...request, url: "https://api.github.com/b" },
    { ...request, headers: { ...request.headers, Authorization: "Bearer two" } },
    { ...request, headers: { ...request.headers, "X-GitHub-Api-Version": "2026-03-10" } },
  ])
    await client.getJson(changed, { canRetain: () => true })
  await createConditionalJsonReader({ http }).getJson(request, { canRetain: () => true })
  assert.ok(calls.every((c) => c.headers["If-None-Match"] === undefined))
})
test("retention evicts by entry count, aggregate bytes and individual size", async () => {
  const { createConditionalJsonReader } = await import("../adapters/conditional-json.mjs")
  for (const [count, size] of [
    [129, 1],
    [17, 1024 * 1024],
    [1, 2 * 1024 * 1024],
  ]) {
    const calls = []
    const client = createConditionalJsonReader({
      http: createHttpGet({
        fetchImpl: async (_url, init) => {
          calls.push(init)
          return json({ data: "a".repeat(size) })
        },
      }),
    })
    const request = {
      url: "https://api.github.com/a/0",
      headers: { Authorization: "Bearer fixture" },
    }
    for (let i = 0; i < count; i++)
      await client.getJson(
        { ...request, url: `https://api.github.com/a/${i}` },
        { canRetain: () => true },
      )
    await client.getJson(request, { canRetain: () => true })
    assert.equal(calls.at(-1).headers["If-None-Match"], undefined)
  }
})
test("a partial collection with a Link header stays unconditional on both pages", async () => {
  const calls = []
  const github = reader(async (_url, init) => {
    calls.push(init)
    return _url.includes("page=2")
      ? json({ total_count: 2, workflows: [{ id: 2 }] })
      : json(
          { total_count: 2, workflows: [{ id: 1 }] },
          {
            link: '<https://api.github.com/repos/cacheplane/dawnai/actions/workflows?per_page=100&page=2>; rel="next"',
          },
        )
  })
  assert.equal((await github.listRepositoryWorkflowsComplete()).value.length, 2)
  assert.equal((await github.listRepositoryWorkflowsComplete()).value.length, 2)
  assert.ok(calls.every((c) => c.headers["If-None-Match"] === undefined))
})

test("a 304 with actual body bytes is rejected by the bounded transport", async () => {
  const http = createHttpGet({
    fetchImpl: async () => ({
      status: 304,
      headers: new Headers({ etag: '"one"' }),
      body: new Response("unexpected").body,
    }),
  })
  const result = await http.getJson({ url: "https://api.github.com/a", allowNotModified: true })
  assert.equal(result.status, "ERROR")
  assert.equal(result.code, "MALFORMED_NOT_MODIFIED")
})
test("timeout and cancellation invalidate retained representations", async () => {
  for (const abort of [false, true]) {
    let n = 0
    const calls = []
    const controller = new AbortController()
    const github = reader(
      async (_url, init) => {
        calls.push(init)
        if (++n === 2) {
          if (abort) controller.abort()
          return new Promise(() => {})
        }
        return json({ id: 1 })
      },
      { timeoutMs: 15 },
    )
    await github.getRepository()
    assert.notEqual(
      (await github.getRepository({}, abort ? { signal: controller.signal } : {})).status,
      "PRESENT",
    )
    await github.getRepository()
    assert.equal(calls[2].headers["If-None-Match"], undefined)
  }
})

test("an invalid initial clock cannot create an unbounded retention lifetime", async () => {
  let n = 0,
    current = NaN
  const github = reader(
    async () => {
      n++
      return json({ id: 1 })
    },
    { now: () => current },
  )
  current = 0
  assert.notEqual((await github.getRepository()).status, "PRESENT")
  assert.equal(n, 0)
})
