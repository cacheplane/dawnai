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

test("paginated recovery inventories revalidate every numeric-link page with absent 304 Link", async () => {
  const calls = []
  const hits = new Map()
  const next =
    "https://api.github.com/repositories/1210070282/actions/workflows/1/runs?per_page=100&page=2"
  const previous =
    "https://api.github.com/repositories/1210070282/actions/workflows/1/runs?per_page=100&page=1"
  const github = reader(
    async (url, init) => {
      const page = new URL(url).searchParams.get("page") ?? "1"
      calls.push({ url, init })
      const hit = (hits.get(page) ?? 0) + 1
      hits.set(page, hit)
      return hit > 1
        ? unchanged(`"page-${page}"`)
        : json(
            {
              total_count: 101,
              workflow_runs: Array.from({ length: page === "1" ? 100 : 1 }, (_, index) => ({
                id: page === "1" ? index + 1 : 101,
              })),
            },
            {
              etag: `W/"page-${page}"`,
              link:
                page === "1"
                  ? `<${next}>; rel="next", <${next}>; rel="last"`
                  : `<${previous}>; rel="prev", <${previous}>; rel="first"`,
            },
          )
    },
    { repositoryId: "1210070282" },
  )
  const first = await github.listWorkflowRunsAllShasComplete({ workflowId: 1 })
  assert.equal(first.status, "PRESENT")
  assert.equal(first.value.length, 101)
  const second = await github.listWorkflowRunsAllShasComplete({ workflowId: 1 })
  assert.equal(second.status, "PRESENT")
  assert.deepEqual(second.value, first.value)
  assert.equal(second.httpStatus, 304)
  assert.equal(calls.length, 4)
  const canonicalNext = next.replace("/repositories/1210070282/", "/repos/cacheplane/dawnai/")
  assert.equal(calls[1].url, canonicalNext)
  assert.equal(calls[3].url, canonicalNext)
  assert.equal(calls[2].init.headers["If-None-Match"], 'W/"page-1"')
  assert.equal(calls[3].init.headers["If-None-Match"], 'W/"page-2"')
})

test("paginated revalidation preserves actual headers and separates retained navigation metadata", async () => {
  const { createConditionalJsonReader } = await import("../adapters/conditional-json.mjs")
  let count = 0
  const link =
    '<https://api.github.com/repos/cacheplane/dawnai/actions/workflows?per_page=100&page=2>; rel="next"'
  const http = createHttpGet({
    fetchImpl: async () =>
      ++count === 1 ? json({ total_count: 101, workflows: [] }, { link }) : unchanged(),
  })
  const client = createConditionalJsonReader({ http })
  const request = {
    url: "https://api.github.com/repos/cacheplane/dawnai/actions/workflows?per_page=100",
    headers: { Authorization: "Bearer fixture" },
  }
  const policy = {
    canRetain: () => true,
    canRetainPage: (_body, observedLink) => observedLink === link,
  }
  await client.getJson(request, policy)
  const result = await client.getJson(request, policy)
  assert.equal(result.status, "NOT_MODIFIED")
  assert.equal(result.httpStatus, 304)
  assert.equal(result.headers.link, null)
  assert.deepEqual(result.revalidatedPage, { link, source: "retained-200-confirmed-by-304" })
  assert.equal(count, 2)
})

function pageResponse(total, page, { headers = {}, ids } = {}) {
  const count = Math.min(100, Math.max(0, total - (page - 1) * 100))
  const next = `https://api.github.com/repositories/1210070282/actions/workflows/1/runs?per_page=100&page=${page + 1}`
  return json(
    {
      total_count: total,
      workflow_runs: (ids ?? Array.from({ length: count }, (_, i) => (page - 1) * 100 + i + 1)).map(
        (id) => ({ id }),
      ),
    },
    { ...(page * 100 < total ? { link: `<${next}>; rel="next"` } : {}), ...headers },
  )
}
const pageNumber = (url) => Number(new URL(url).searchParams.get("page") ?? 1)
const historyReader = (fetchImpl, options = {}) =>
  reader(fetchImpl, { repositoryId: "1210070282", ...options })
const history = (github, options) =>
  github.listWorkflowRunsAllShasComplete({ workflowId: 1 }, options)

for (const total of [0, 1, 100, 101])
  test(`paginated total ${total} retains every complete page and fetches each again`, async () => {
    const calls = []
    const github = historyReader(async (url, init) => {
      calls.push(init)
      return init.headers["If-None-Match"] ? unchanged() : pageResponse(total, pageNumber(url))
    })
    assert.equal((await history(github)).value.length, total)
    assert.equal((await history(github)).value.length, total)
    const pages = Math.max(1, Math.ceil(total / 100))
    assert.equal(calls.length, pages * 2)
    assert.ok(calls.slice(pages).every((call) => call.headers["If-None-Match"] === 'W/"one"'))
  })

test("paginated changed 200 uses its own total and links without retained navigation", async () => {
  let total = 101
  const calls = []
  const github = historyReader(async (url, init) => {
    calls.push({ url, init })
    return pageResponse(total, pageNumber(url), { headers: { etag: `"total-${total}"` } })
  })
  assert.equal((await history(github)).value.length, 101)
  total = 1
  assert.equal((await history(github)).value.length, 1)
  assert.equal(calls.length, 3)
  total = 201
  assert.equal((await history(github)).value.length, 201)
  assert.equal(calls.length, 6)
  assert.equal(calls[3].init.headers["If-None-Match"], '"total-1"')
})

for (const defect of [
  "total",
  "duplicate",
  "missing-next",
  "unsafe-next",
  "wrong-repository",
  "missing-etag",
  "different-etag",
  "conflicting-link",
  "incomplete",
]) {
  test(`paginated fresh confirmation rejects ${defect}`, async () => {
    let second = false
    const github = historyReader(async (url) => {
      const page = pageNumber(url)
      if (!second) return pageResponse(101, page)
      if (defect === "missing-etag") return new Response(null, { status: 304 })
      if (defect === "different-etag") return unchanged('"changed"')
      if (defect === "conflicting-link")
        return unchanged('"one"', { link: '<https://invalid.example/>; rel="next"' })
      if (page === 2)
        return defect === "total"
          ? pageResponse(102, page)
          : defect === "duplicate"
            ? pageResponse(101, page, { ids: [1] })
            : unchanged()
      if (defect === "missing-next")
        return json({
          total_count: 101,
          workflow_runs: Array.from({ length: 100 }, (_, i) => ({ id: i + 1 })),
        })
      if (defect === "unsafe-next" || defect === "wrong-repository")
        return pageResponse(101, page, {
          headers: {
            link: `<https://api.github.com/repositories/${defect === "wrong-repository" ? "999" : "1210070282"}/actions/workflows/1/runs?per_page=100&page=${defect === "unsafe-next" ? "3" : "2"}>; rel="next"`,
          },
        })
      if (defect === "incomplete") return pageResponse(101, page, { ids: [1] })
      return unchanged()
    })
    assert.equal((await history(github)).status, "PRESENT")
    second = true
    assert.notEqual((await history(github)).status, "PRESENT")
  })
}

test("paginated 200 without validators is admitted and never retained", async () => {
  const calls = []
  const github = historyReader(async (url, init) => {
    calls.push(init)
    const response = pageResponse(101, pageNumber(url))
    response.headers.delete("etag")
    return response
  })
  assert.equal((await history(github)).value.length, 101)
  assert.equal((await history(github)).value.length, 101)
  assert.equal(calls.length, 4)
  assert.ok(calls.every((call) => call.headers["If-None-Match"] === undefined))
})

test("paginated revalidated bytes obey a reduced caller budget", async () => {
  const { createConditionalJsonReader } = await import("../adapters/conditional-json.mjs")
  let n = 0
  const client = createConditionalJsonReader({
    http: createHttpGet({
      fetchImpl: async () => (++n === 1 ? pageResponse(101, 1) : unchanged()),
    }),
  })
  const request = { url: "https://api.github.com/a", headers: { Authorization: "Bearer fixture" } }
  const policy = { canRetainPage: () => true }
  await client.getJson(request, policy)
  const result = await client.getJson({ ...request, maxResponseBytes: 10 }, policy)
  assert.equal(result.status, "ERROR")
  assert.equal(result.code, "RESPONSE_TOO_LARGE")
})

test("paginated revalidation obeys the original operation deadline", async () => {
  let current = 0,
    second = false
  const github = historyReader(
    async (url) => {
      if (second) {
        current += 100
        return unchanged()
      }
      return pageResponse(101, pageNumber(url))
    },
    { now: () => current },
  )
  assert.equal((await history(github)).status, "PRESENT")
  second = true
  const result = await history(github, { timeoutMs: 50 })
  assert.notEqual(result.status, "PRESENT")
  assert.equal(result.code, "TIMEOUT")
})

test("paginated metadata is bounded, mode-isolated, evicted and rechecked with the active predicate", async () => {
  const { createConditionalJsonReader } = await import("../adapters/conditional-json.mjs")
  for (const mode of ["predicate", "mode", "link-size", "eviction"]) {
    const calls = []
    const client = createConditionalJsonReader({
      http: createHttpGet({
        fetchImpl: async (_url, init) => {
          calls.push(init)
          return init.headers["If-None-Match"]
            ? unchanged()
            : json({ id: 1 }, mode === "link-size" ? { link: "x".repeat(8193) } : {})
        },
      }),
    })
    const request = {
      url: "https://api.github.com/a",
      headers: { Authorization: "Bearer fixture" },
    }
    await client.getJson(request, { canRetainPage: () => true })
    if (mode === "eviction")
      for (let i = 0; i < 128; i++)
        await client.getJson(
          { ...request, url: `https://api.github.com/a/${i}` },
          { canRetainPage: () => true },
        )
    const result = await client.getJson(
      request,
      mode === "mode" ? { canRetain: () => true } : { canRetainPage: () => mode !== "predicate" },
    )
    if (mode === "predicate") assert.equal(result.status, "ERROR")
    else assert.equal(calls.at(-1).headers["If-None-Match"], undefined)
  }
})

test("paginated history preserves fence authority fields within unchanged snapshot limits", async () => {
  const { snapshotRecoveryData } = await import("../recovery/schema.mjs")
  const { fenceTerminalRuns } = await import("../recovery/fence-evidence.mjs")
  const identity = {
    workflowId: "1",
    workflow: ".github/workflows/release.yml",
    repository: "cacheplane/dawnai",
    repositoryId: "1210070282",
  }
  const runs = Array.from({ length: 514 }, (_, i) => ({
    id: i + 1,
    run_attempt: 1,
    workflow_id: 1,
    path: identity.workflow,
    repository: { id: 1210070282, full_name: identity.repository, description: "fixture" },
    head_sha: "a".repeat(40),
    status: "completed",
    conclusion: "success",
    metadata: Object.fromEntries(Array.from({ length: 220 }, (_, j) => [`field${j}`, `value${j}`])),
  }))
  assert.throws(() => snapshotRecoveryData(runs, 8 * 1024 * 1024), /snapshot.*limit/)
  const github = historyReader(async (url) => {
    const page = pageNumber(url)
    const response = pageResponse(514, page)
    return json(
      { total_count: 514, workflow_runs: runs.slice((page - 1) * 100, page * 100) },
      Object.fromEntries(response.headers),
    )
  })
  const result = await history(github)
  assert.equal(result.status, "PRESENT")
  const projected = snapshotRecoveryData(result.value, 8 * 1024 * 1024)
  assert.deepEqual(fenceTerminalRuns(projected, identity), fenceTerminalRuns(runs, identity))
  assert.deepEqual(Object.keys(projected[0]).sort(), [
    "conclusion",
    "head_sha",
    "id",
    "path",
    "repository",
    "run_attempt",
    "status",
    "workflow_id",
  ])
  assert.deepEqual(projected[0].repository, { id: 1210070282, full_name: identity.repository })
})

test("history projection follows raw validation and preserves malformed authority values", async () => {
  const { fenceTerminalRuns } = await import("../recovery/fence-evidence.mjs")
  const identity = {
    workflowId: "1",
    workflow: ".github/workflows/release.yml",
    repository: "cacheplane/dawnai",
    repositoryId: "1210070282",
  }
  const valid = {
    id: 1,
    run_attempt: 1,
    workflow_id: 1,
    path: identity.workflow,
    repository: { id: 1210070282, full_name: identity.repository },
    head_sha: "a".repeat(40),
    status: "completed",
    conclusion: "success",
  }
  for (const change of [
    { status: "in_progress" },
    { workflow_id: 2 },
    { head_sha: "invalid" },
    { repository: null },
    { repository: [] },
    { repository: {} },
  ]) {
    const record = { ...valid, ...change }
    const github = historyReader(async () => json({ total_count: 1, workflow_runs: [record] }))
    const result = await history(github)
    assert.equal(result.status, "PRESENT")
    for (const [key, value] of Object.entries(change)) assert.deepEqual(result.value[0][key], value)
    assert.throws(() => fenceTerminalRuns(result.value, identity))
  }
  const unsafe = historyReader(async () =>
    json({ total_count: 1, workflow_runs: [{ ...valid, unused: { secret: "unsafe" } }] }),
  )
  assert.equal((await history(unsafe)).code, "UNSAFE_RESPONSE_KEY")
  const missing = { ...valid }
  delete missing.head_sha
  const github = historyReader(async () => json({ total_count: 1, workflow_runs: [missing] }))
  const result = await history(github)
  assert.equal(Object.hasOwn(result.value[0], "head_sha"), false)
  assert.throws(() => fenceTerminalRuns(result.value, identity))
})

test("history projection cannot mutate retained raw metadata or reduce its byte charge", async () => {
  const calls = []
  const raw = {
    total_count: 1,
    workflow_runs: [
      {
        id: 1,
        repository: { id: 2, full_name: "a/b", description: "retained" },
        metadata: "x".repeat(2000),
      },
    ],
  }
  const github = historyReader(async (_url, init) => {
    calls.push(init)
    return calls.length === 1 ? json(raw) : unchanged()
  })
  const first = await history(github)
  assert.throws(() => {
    first.value[0].id = 9
  }, TypeError)
  assert.throws(() => {
    first.value[0].repository.id = 9
  }, TypeError)
  const second = await history(github)
  assert.deepEqual(second.value, first.value)
  assert.equal(second.httpStatus, 304)
  assert.equal(calls[1].headers["If-None-Match"], 'W/"one"')
  assert.equal(raw.workflow_runs[0].metadata.length, 2000)
  // Initial response fits, but the two-page cumulative byte limit cannot fit both
  // raw bodies even though their projected records are tiny.
  const bounded = historyReader(
    async (url) => {
      const page = pageNumber(url)
      const body = {
        total_count: 101,
        workflow_runs: Array.from({ length: page === 1 ? 100 : 1 }, (_, i) => ({
          id: page === 1 ? i + 1 : 101,
          metadata: "x".repeat(page === 1 ? 20 : 3000),
        })),
      }
      return json(
        body,
        page === 1
          ? {
              link: '<https://api.github.com/repos/cacheplane/dawnai/actions/workflows/1/runs?per_page=100&page=2>; rel="next"',
            }
          : {},
      )
    },
    { maxResponseBytes: 6000 },
  )
  assert.equal((await history(bounded)).code, "OPERATION_TOO_LARGE")
})
