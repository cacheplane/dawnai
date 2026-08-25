import assert from "node:assert/strict"
import test from "node:test"

import {
  parseImmutableReleasesGateEnvironment,
  verifyImmutableReleasesEnabled,
} from "../immutable-releases-gate.mjs"

const SHA = "0123456789abcdef0123456789abcdef01234567"

test("reads the exact repository immutable-Releases setting with an administration-read token", async () => {
  const requests = []
  const result = await verifyImmutableReleasesEnabled({
    environment: productionEnvironment(),
    async fetchImpl(url, init) {
      requests.push({ url, init })
      return new Response(JSON.stringify({ enabled: true, enforced_by_owner: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    },
  })

  assert.deepEqual(result, {
    repository: "cacheplane/dawnai",
    enabled: true,
    enforcedByOwner: false,
  })
  assert.ok(Object.isFrozen(result))
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, "https://api.github.com/repos/cacheplane/dawnai/immutable-releases")
  assert.equal(requests[0].init.method, "GET")
  assert.equal(requests[0].init.redirect, "error")
  assert.equal(requests[0].init.headers.Accept, "application/vnd.github+json")
  assert.equal(requests[0].init.headers["X-GitHub-Api-Version"], "2026-03-10")
  assert.equal(requests[0].init.headers.Authorization, "Bearer dedicated-admin-read-token")
})

test("binds the live guard to the exact release workflow invocation before network access", async () => {
  const cases = [
    ["repository", { GITHUB_REPOSITORY: "fork/dawnai" }],
    ["API origin", { GITHUB_API_URL: "https://example.test" }],
    ["event", { GITHUB_EVENT_NAME: "pull_request" }],
    ["branch", { GITHUB_REF: "refs/heads/feature" }],
    ["SHA", { GITHUB_SHA: "A".repeat(40) }],
    [
      "workflow",
      {
        GITHUB_WORKFLOW_REF: "cacheplane/dawnai/.github/workflows/other.yml@refs/heads/main",
      },
    ],
    ["token", { GITHUB_TOKEN: "" }],
    ["token newline", { GITHUB_TOKEN: "unsafe\ntoken" }],
  ]

  for (const [name, override] of cases) {
    let requests = 0
    await assert.rejects(
      verifyImmutableReleasesEnabled({
        environment: { ...productionEnvironment(), ...override },
        async fetchImpl() {
          requests += 1
          return new Response("{}", { status: 200 })
        },
      }),
      /immutable|environment|invocation|token|repository|workflow|ref|SHA|API/iu,
      name,
    )
    assert.equal(requests, 0, `${name} must fail before sending the credential`)
  }
})

test("accepts the exact tagged release workflow identity", () => {
  const environment = productionEnvironment({ ref: "refs/tags/v0.8.22" })
  assert.deepEqual(parseImmutableReleasesGateEnvironment(environment), {
    repository: "cacheplane/dawnai",
    apiOrigin: "https://api.github.com",
    ref: "refs/tags/v0.8.22",
    commitSha: SHA,
    token: "dedicated-admin-read-token",
  })
})

test("fails closed when immutable Releases are disabled, unavailable, or malformed", async () => {
  const cases = [
    ["disabled", new Response(JSON.stringify({ enabled: false }), { status: 200 })],
    ["absent", new Response("", { status: 404 })],
    ["forbidden", new Response("credential detail must not escape", { status: 403 })],
    ["malformed", new Response("not-json", { status: 200 })],
    ["wrong shape", new Response(JSON.stringify({ enabled: "true" }), { status: 200 })],
    [
      "oversized",
      new Response(JSON.stringify({ enabled: true, padding: "x".repeat(20_000) }), {
        status: 200,
      }),
    ],
  ]

  for (const [name, response] of cases) {
    await assert.rejects(
      verifyImmutableReleasesEnabled({
        environment: productionEnvironment(),
        async fetchImpl() {
          return response
        },
      }),
      (error) => {
        assert.doesNotMatch(String(error?.message), /credential detail|dedicated-admin-read-token/u)
        return /IMMUTABLE_RELEASES_/u.test(String(error?.code))
      },
      name,
    )
  }
})

test("requires an empty argument vector and descriptor-safe dependencies", async () => {
  await assert.rejects(
    verifyImmutableReleasesEnabled({
      argv: ["--repository", "other/repo"],
      environment: productionEnvironment(),
      async fetchImpl() {
        assert.fail("invalid arguments must fail before fetch")
      },
    }),
    /argument/iu,
  )
  await assert.rejects(
    verifyImmutableReleasesEnabled({
      environment: productionEnvironment(),
      fetchImpl: null,
    }),
    /fetch/iu,
  )
})

function productionEnvironment({ ref = "refs/heads/main" } = {}) {
  return {
    GITHUB_REPOSITORY: "cacheplane/dawnai",
    GITHUB_API_URL: "https://api.github.com",
    GITHUB_EVENT_NAME: ref.startsWith("refs/tags/") ? "workflow_dispatch" : "push",
    GITHUB_WORKFLOW_REF: `cacheplane/dawnai/.github/workflows/release.yml@${ref}`,
    GITHUB_REF: ref,
    GITHUB_SHA: SHA,
    GITHUB_TOKEN: "dedicated-admin-read-token",
  }
}
