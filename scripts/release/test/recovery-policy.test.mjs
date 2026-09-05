import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

const modulePath = "../recovery/policy.mjs"
const policyModule = await import(modulePath).catch(() => ({}))
const fixture = async () =>
  JSON.parse(await readFile(new URL("../recovery/policy.json", import.meta.url)))

test("recovery policy contract exists", () => {
  assert.equal(typeof policyModule.parseRecoveryPolicy, "function")
})

test("production admission is dormant and its explicit probe closure excludes the policy self-hash", async () => {
  const policy = await fixture()
  const parsed = policyModule.parseRecoveryPolicy(policyModule.canonicalPolicyBytes(policy))
  assert.equal(parsed.status, "DORMANT")
  assert.match(parsed.verifierClosure.sha256, /^[a-f0-9]{64}$/u)
  assert.deepEqual(parsed.receiptVersions, [2])
  assert.deepEqual(
    parsed.lanes.map((x) => x.name),
    ["metadata", "published-harness", "runtime-targets", "scaffold", "storage"],
  )
  assert.ok(parsed.verifierClosure.inputs.includes("scripts/published-artifact-verify.mjs"))
  assert.ok(parsed.verifierClosure.inputs.includes("scripts/release/smoke-command-shim.mjs"))
  assert.ok(!parsed.verifierClosure.inputs.includes("scripts/release/recovery/policy.json"))
  assert.ok(parsed.lanes.every((x) => x.requiredChecks.includes("containment")))
  assert.ok(
    parsed.lanes.find((x) => x.name === "storage").requiredChecks.includes("cleanup-postgres"),
  )
})

test("policy rejects unknown fields, dropped lanes/checks, arbitrary approval, unsupported versions and unsafe data", async () => {
  const policy = await fixture()
  for (const mutate of [
    (p) => {
      p.approved = true
    },
    (p) => {
      p.lanes.pop()
    },
    (p) => {
      p.lanes[0].requiredChecks = []
    },
    (p) => {
      p.receiptVersions = [1]
    },
    (p) => {
      p.retry.readTimeoutMs = 16000
    },
    (p) => {
      p.verifierClosure.inputs.push("scripts/release/recovery/policy.json")
    },
  ]) {
    const bad = structuredClone(policy)
    mutate(bad)
    assert.throws(() => policyModule.parseRecoveryPolicy(policyModule.canonicalPolicyBytes(bad)))
  }
  let touched = false
  const unsafe = {
    get status() {
      touched = true
      return "ADMITTED"
    },
  }
  assert.throws(() => policyModule.canonicalPolicyBytes(unsafe))
  assert.throws(() =>
    policyModule.canonicalPolicyBytes(
      new Proxy(
        {},
        {
          ownKeys() {
            touched = true
            return []
          },
        },
      ),
    ),
  )
  assert.equal(touched, false)
})

test("closure digest commits to path and raw bytes, checks bounds, and never hashes policy JSON", async () => {
  const inputs = ["scripts/a.mjs", "scripts/b.json"]
  const calls = []
  const read = async (x) => {
    calls.push(x)
    return x.path === inputs[0] ? "source\n" : "{}\n"
  }
  const first = await policyModule.hashVerifierClosure(
    { controllerSha: "a".repeat(40), inputs },
    read,
  )
  assert.equal(first.length, 64)
  assert.deepEqual(
    calls.map((x) => x.ref),
    ["a".repeat(40), "a".repeat(40)],
  )
  assert.notEqual(
    first,
    await policyModule.hashVerifierClosure(
      { controllerSha: "a".repeat(40), inputs },
      async () => "changed",
    ),
  )
  await assert.rejects(() =>
    policyModule.hashVerifierClosure(
      {
        controllerSha: "a".repeat(40),
        inputs: ["scripts/release/recovery/policy.json"],
      },
      read,
    ),
  )
  await assert.rejects(() =>
    policyModule.hashVerifierClosure({ controllerSha: "a".repeat(40), inputs }, async () =>
      "x".repeat(2 * 1024 * 1024 + 1),
    ),
  )
})

function clock() {
  let value = 0
  return {
    now: () => value,
    sleep: async (ms) => {
      value += ms
    },
    advance: (ms) => {
      value += ms
    },
  }
}

test("transport retries stop at five retries and all operation calls have 15 second timeouts", async () => {
  const c = clock()
  let attempts = 0
  const result = await policyModule.runRecoveryRead(
    { phaseDeadline: 100000 },
    async ({ timeoutMs, signal }) => {
      attempts++
      assert.equal(timeoutMs, 15000)
      assert.ok(signal instanceof AbortSignal)
      return { status: "ERROR", code: "FETCH_FAILED", httpStatus: null }
    },
    c,
  )
  assert.equal(result.code, "FETCH_FAILED")
  assert.equal(attempts, 6)
  assert.ok(c.now() <= 90000)
})

test("bounded Retry-After and operation/phase deadlines prevent extra reads", async () => {
  const c = clock()
  let attempts = 0
  const result = await policyModule.runRecoveryRead(
    { phaseDeadline: 4000 },
    async () => {
      attempts++
      return {
        status: "AMBIGUOUS",
        code: "HTTP_429",
        httpStatus: 429,
        retryAfterMs: 999999,
      }
    },
    c,
  )
  assert.equal(attempts, 1)
  assert.equal(result.code, "RECOVERY_DEADLINE")
  assert.ok(c.now() <= 4000)
  c.advance(4001)
  await policyModule.runRecoveryRead(
    { phaseDeadline: 4000 },
    async () => {
      attempts++
    },
    c,
  )
  assert.equal(attempts, 1)
})

test("schema, identity and signature failures are never retried even with a transient HTTP status", async () => {
  for (const code of [
    "MALFORMED_SCHEMA",
    "IDENTITY_MISMATCH",
    "INVALID_SIGNATURE",
    "UNSUPPORTED_SCHEMA",
  ]) {
    let calls = 0
    const result = await policyModule.runRecoveryRead(
      { phaseDeadline: 100000 },
      async () => {
        calls++
        return { status: "ERROR", code, httpStatus: 503 }
      },
      clock(),
    )
    assert.equal(calls, 1)
    assert.equal(result.code, code)
  }
})

test("only recognized metadata-present tarball propagation is retried", async () => {
  for (const metadataPresent of [false, true]) {
    let attempts = 0
    await policyModule.runRecoveryRead(
      { phaseDeadline: 100000, registryMetadataPresent: metadataPresent },
      async () => {
        attempts++
        return attempts === 1
          ? {
              status: "AMBIGUOUS",
              operation: "package-tarball",
              code: "HTTP_404",
              httpStatus: 404,
            }
          : { status: "PRESENT" }
      },
      clock(),
    )
    assert.equal(attempts, metadataPresent ? 2 : 1)
  }
})

test("pinned current probe closure is complete and v2 obligations include explicit aggregate cleanup and registry checks", async () => {
  const policy = await fixture()
  assert.match(policy.verifierClosure.sha256, /^[a-f0-9]{64}$/u)
  assert.ok(policy.lanes.every((lane) => lane.requiredChecks.includes("cleanup")))
  assert.ok(policy.lanes[0].requiredChecks.includes("registry-packages"))
  assert.ok(policy.verifierClosure.inputs.includes("scripts/release/recovery/schema.mjs"))
})

test("raw policy rejects malformed Unicode, byte proxies and decorated buffers without calling getters", async () => {
  const p = await fixture()
  let touched = false
  const raw = policyModule.canonicalPolicyBytes(p)
  const decorated = Buffer.from(raw)
  Object.defineProperty(decorated, "toString", {
    get() {
      touched = true
      return () => raw.toString()
    },
  })
  for (const value of [
    decorated,
    new Proxy(raw, {}),
    raw.toString().replace('"DORMANT"', '"\ud800"'),
    Buffer.from([0xff]),
  ]) {
    assert.throws(() => policyModule.parseRecoveryPolicy(value))
  }
  assert.equal(touched, false)
})

test("an unacknowledged timed out read stops without overlapping retry or accepting its late value", async () => {
  const c = clock()
  let timer,
    calls = 0,
    aborted = false,
    finish
  const dependencies = {
    ...c,
    setTimer: (callback) => {
      timer = callback
      return 1
    },
    clearTimer: () => {},
  }
  const pending = policyModule.runRecoveryRead(
    { phaseDeadline: 100000 },
    ({ signal }) => {
      calls++
      signal.addEventListener("abort", () => {
        aborted = true
      })
      return new Promise((resolve) => {
        finish = resolve
      })
    },
    dependencies,
  )
  await Promise.resolve()
  assert.equal(typeof timer, "function")
  c.advance(15000)
  timer()
  const result = await pending
  assert.equal(result.code, "READ_TIMEOUT_UNSETTLED")
  assert.equal(calls, 1)
  assert.equal(aborted, true)
  finish({ status: "PRESENT", value: "late authority" })
  assert.equal(result.code, "READ_TIMEOUT_UNSETTLED")
})

test("reviewed probe inventory equals independently discovered local executable closure and actual source digest", async () => {
  const { createRequire } = await import("node:module")
  const path = await import("node:path")
  const { fileURLToPath } = await import("node:url")
  const root = fileURLToPath(new URL("../../../", import.meta.url))
  const ts = createRequire(path.join(root, "packages/core/package.json"))("typescript")
  const roots = [
    "scripts/published-artifact-verify.mjs",
    "scripts/release/smoke/published-harness.mjs",
    "scripts/release/smoke/runtime-targets.mjs",
    "scripts/release/smoke/scaffold.mjs",
    "scripts/release/smoke/storage.mjs",
    "scripts/release/recovery/schema.mjs",
    "scripts/release/recovery/smoke.mjs",
    "scripts/release/recovery/audit.mjs",
    "scripts/release/recovery/finalize.mjs",
  ]
  const seen = new Set(),
    pending = [...roots]
  while (pending.length) {
    const file = pending.pop()
    if (seen.has(file)) continue
    seen.add(file)
    const source = await readFile(path.join(root, file), "utf8")
    const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
    const add = (specifier) => {
      assert.ok(
        specifier.startsWith("node:") || specifier.startsWith("."),
        `Unreviewed bare executable import in ${file}: ${specifier}`,
      )
      if (specifier.startsWith(".")) {
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier))
        assert.ok(!target.startsWith("../"), "closure may not escape repository")
        pending.push(target)
      }
    }
    const visit = (node) => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier)
        add(node.moduleSpecifier.text)
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === "require"))
      ) {
        assert.ok(
          node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0]),
          `Unbounded dynamic executable import in ${file}`,
        )
        add(node.arguments[0].text)
      }
      if (
        ts.isNewExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "URL" &&
        node.arguments?.length === 2 &&
        node.arguments[1].getText(parsed) === "import.meta.url"
      ) {
        assert.ok(ts.isStringLiteralLike(node.arguments[0]), `Unbounded executable URL in ${file}`)
        add(node.arguments[0].text)
      }
      ts.forEachChild(node, visit)
    }
    visit(parsed)
  }
  const policy = await fixture()
  assert.deepEqual(policy.verifierClosure.inputs, [...seen].sort())
  assert.equal(
    await policyModule.hashVerifierClosure(
      { controllerSha: "a".repeat(40), inputs: policy.verifierClosure.inputs },
      ({ path: file }) => readFile(path.join(root, file), "utf8"),
    ),
    policy.verifierClosure.sha256,
  )
})

test("policy source permits reviewable whitespace while its canonical token identity rejects duplicates", async () => {
  const policy = await fixture()
  const compact = policyModule.canonicalPolicyBytes(policy)
  const pretty = `${JSON.stringify(JSON.parse(compact), null, 2)}\n`
  assert.deepEqual(
    policyModule.parseRecoveryPolicy(pretty),
    policyModule.parseRecoveryPolicy(compact),
  )
  assert.throws(() =>
    policyModule.parseRecoveryPolicy(
      pretty.replace('"schemaVersion": 2', '"schemaVersion": 2, "schemaVersion": 2'),
    ),
  )
})

test("adapter binding never reads a callable's own bind accessor", () => {
  let touched = false
  const callback = function () {
    return this.value
  }
  Object.defineProperty(callback, "bind", {
    get() {
      touched = true
      throw new Error("unsafe accessor")
    },
  })
  const reader = policyModule.recoveryMethods({ value: 42, read: callback }, ["read"])
  assert.equal(reader.read(), 42)
  assert.equal(touched, false)
})

test("a stalled retry backoff is bounded and cannot start another read", async () => {
  const c = clock()
  let timer,
    entered = false,
    reads = 0,
    finish
  const dependencies = {
    now: c.now,
    sleep: () => {
      entered = true
      return new Promise((resolve) => {
        finish = resolve
      })
    },
    setTimer: (callback) => {
      timer = callback
      return 1
    },
    clearTimer: () => {
      timer = null
    },
  }
  const pending = policyModule.runRecoveryRead(
    { phaseDeadline: 20000 },
    async () => {
      reads++
      return { status: "ERROR", code: "FETCH_FAILED", httpStatus: null }
    },
    dependencies,
  )
  for (let i = 0; i < 20 && !entered; i++) await Promise.resolve()
  assert.equal(entered, true)
  assert.equal(typeof timer, "function")
  c.advance(20000)
  timer()
  assert.equal((await pending).code, "RECOVERY_DEADLINE")
  assert.equal(reads, 1)
  finish()
  await Promise.resolve()
  assert.equal(reads, 1)
})

test("real GitHub primary-rate-limit responses retry within policy while ordinary forbidden reads do not", async () => {
  const { createGitHubReader } = await import("../adapters/github.mjs")
  for (const rateLimited of [true, false]) {
    let reads = 0
    const reader = createGitHubReader({
      owner: "example",
      repo: "dawn",
      fetchImpl: async () => {
        reads++
        return new Response(
          JSON.stringify(reads === 1 ? { message: "Forbidden" } : { ref: "refs/heads/main" }),
          {
            status: reads === 1 ? 403 : 200,
            headers: {
              "content-type": "application/json",
              ...(rateLimited && reads === 1 ? { "x-ratelimit-remaining": "0" } : {}),
            },
          },
        )
      },
    })
    const result = await policyModule.runRecoveryRead(
      { phaseDeadline: 100000 },
      () => reader.getRef({ ref: "heads/main" }),
      clock(),
    )
    assert.equal(reads, rateLimited ? 2 : 1)
    assert.equal(result.status, rateLimited ? "PRESENT" : "AMBIGUOUS")
  }
})

test("real adapter TIMEOUT is terminal when an abort-ignoring fetch has not settled", async () => {
  const { createGitHubReader } = await import("../adapters/github.mjs")
  const pending = []
  let reads = 0,
    active = 0,
    maximumActive = 0
  const reader = createGitHubReader({
    owner: "example",
    repo: "dawn",
    timeoutMs: 1,
    fetchImpl: () => {
      reads++
      active++
      maximumActive = Math.max(maximumActive, active)
      return new Promise((resolve) =>
        pending.push(() => {
          active--
          resolve(
            new Response("{}", {
              headers: { "content-type": "application/json" },
            }),
          )
        }),
      )
    },
  })
  try {
    const result = await policyModule.runRecoveryRead(
      { phaseDeadline: 100000 },
      () => reader.getRef({ ref: "heads/main" }),
      clock(),
    )
    assert.equal(result.code, "TIMEOUT")
    assert.equal(reads, 1)
    assert.equal(maximumActive, 1)
  } finally {
    for (const finish of pending) finish()
  }
})

test("stalled transient HTTP bodies cannot become retryable server or throttle responses", async () => {
  const { createGitHubReader } = await import("../adapters/github.mjs")
  for (const status of [503, 429, 403]) {
    const pending = []
    let reads = 0,
      active = 0,
      maximumActive = 0
    const reader = createGitHubReader({
      owner: "example",
      repo: "dawn",
      timeoutMs: 1,
      fetchImpl: async () => ({
        status,
        headers: new Headers({
          "content-type": "application/json",
          ...(status === 403 ? { "x-ratelimit-remaining": "0" } : {}),
        }),
        body: {
          getReader: () => ({
            read: () => {
              reads++
              active++
              maximumActive = Math.max(maximumActive, active)
              return new Promise((resolve) =>
                pending.push(() => {
                  active--
                  resolve({ done: true })
                }),
              )
            },
            cancel: () => new Promise((resolve) => pending.push(resolve)),
            releaseLock() {},
          }),
        },
      }),
    })
    try {
      const result = await policyModule.runRecoveryRead(
        { phaseDeadline: 100000 },
        () => reader.getRef({ ref: "heads/main" }),
        clock(),
      )
      assert.equal(result.code, "TIMEOUT")
      assert.equal(result.httpStatus, status)
      assert.equal(reads, 1)
      assert.equal(maximumActive, 1)
    } finally {
      for (const finish of pending) finish()
    }
  }
})

test("transient HTTP status cannot make unknown or deterministic transport errors retryable", async () => {
  for (const status of ["ERROR", "AMBIGUOUS"]) {
    for (const httpStatus of [429, 503]) {
      for (const code of [
        "ABORTED",
        "RESPONSE_TOO_LARGE",
        "UNEXPECTED_CONTENT_TYPE",
        "INVALID_JSON",
        "UNKNOWN_ERROR",
      ]) {
        let reads = 0
        const result = await policyModule.runRecoveryRead(
          { phaseDeadline: 100000 },
          async () => {
            reads++
            return { status, code, httpStatus }
          },
          clock(),
        )
        assert.equal(result.code, code)
        assert.equal(reads, 1)
      }
    }
  }
})

test("dormant image inventory includes the actual sandbox image and recovery collector closure", async () => {
  const policy = policyModule.parseRecoveryPolicy(
    policyModule.canonicalPolicyBytes(await fixture()),
  )
  assert.deepEqual(policy.environment.dockerImages, [
    "node:22-slim",
    "pgvector/pgvector:pg16",
    "postgres:16",
  ])
  assert.ok(policy.verifierClosure.inputs.includes("scripts/release/recovery/smoke.mjs"))
})
