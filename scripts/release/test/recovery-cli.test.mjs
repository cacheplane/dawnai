import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { recoveryRemote } from "./support/recovery-observe-fixture.mjs"

const cli = await import("../recovery/cli.mjs").catch(() => ({}))
const runtime = await import("../recovery/runtime.mjs").catch(() => ({}))

test("strict named command paths reject missing duplicate unknown and positional inputs", () => {
  assert.equal(typeof cli.parseRecoveryArgs, "function")
  for (const argv of [
    [],
    ["unknown"],
    ["inspect"],
    ["inspect", "--request", "/a"],
    ["inspect", "--request", "/a", "--output", "/b", "--force"],
    ["inspect", "--request", "/a", "--request", "/c", "--output", "/b"],
    ["inspect", "--request", "relative", "--output", "/b"],
    ["inspect", "--request", "/a", "--output", "/b", "extra"],
  ])
    assert.throws(() => cli.parseRecoveryArgs(argv))
  assert.deepEqual(cli.parseRecoveryArgs(["inspect", "--request", "/a", "--output", "/b"]), {
    command: "inspect",
    request: "/a",
    output: "/b",
  })
})

test("canonical requests reject JSON authority unknown keys duplicate keys and wrong digest", () => {
  assert.equal(typeof runtime.parseRecoveryRequest, "function")
  for (const raw of [
    '{"candidate":{},"authority":{}}\n',
    '{"candidate":{},"candidate":{}}\n',
    "{}\n",
  ])
    assert.throws(() => runtime.parseRecoveryRequest("adopt", Buffer.from(raw)))
})

test("inspect uses only read adapters and writes useful unreserved output", async () => {
  assert.equal(typeof cli.runRecoveryCli, "function")
  const r = await recoveryRemote()
  r.args.git.listTree = async () => ""
  const directory = await mkdtemp(path.join(os.tmpdir(), "recovery-cli-"))
  try {
    const request = path.join(directory, "request.json"),
      output = path.join(directory, "result.json")
    await writeFile(
      request,
      runtime.canonicalRequestBytes({ candidate: r.c, expectedControllerSha: r.e.controllerSha }),
    )
    const result = await cli.runRecoveryCli(["inspect", "--request", request, "--output", output], {
      root: directory,
      environment: {},
      createRuntime: async ({ command }) => {
        assert.equal(command, "inspect")
        return { observation: r.args }
      },
    })
    assert.equal(result.exitCode, 0)
    const wire = JSON.parse(await readFile(output, "utf8"))
    assert.equal(wire.result.status, "unreserved")
    assert.equal(Object.hasOwn(wire.result, "facts"), false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("valid output receives bounded failure diagnostics even when runtime throws secrets", async () => {
  assert.equal(typeof cli.runRecoveryCli, "function")
  const r = await recoveryRemote(),
    directory = await mkdtemp(path.join(os.tmpdir(), "recovery-failure-"))
  try {
    const request = path.join(directory, "request.json"),
      output = path.join(directory, "result.json")
    await writeFile(
      request,
      runtime.canonicalRequestBytes({ candidate: r.c, expectedControllerSha: r.e.controllerSha }),
    )
    const result = await cli.runRecoveryCli(["inspect", "--request", request, "--output", output], {
      root: directory,
      environment: { GITHUB_TOKEN: "private-secret" },
      createRuntime: async () => {
        throw new Error("Bearer private-secret https://secret.invalid/?token=private-secret")
      },
    })
    assert.equal(result.exitCode, 1)
    assert.ok(!(await readFile(output, "utf8")).includes("private-secret"))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("smoke child environment preserves actual host identity and drops credentials", () => {
  assert.equal(typeof runtime.recoveryChildEnvironment, "function")
  assert.deepEqual(
    runtime.recoveryChildEnvironment({
      PATH: "/bin",
      HOME: "/tmp/home",
      ImageOS: "ubuntu24",
      ImageVersion: "actual",
      GITHUB_TOKEN: "secret",
      NODE_AUTH_TOKEN: "secret",
      DAWN_RECOVERY_POLICY_TOKEN: "secret",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "secret",
      NODE_OPTIONS: "--require=evil",
      NPM_CONFIG_USERCONFIG: "evil",
    }),
    { PATH: "/bin", HOME: "/tmp/home", ImageOS: "ubuntu24", ImageVersion: "actual" },
  )
})

test("invalid request arguments still retain failure output when destination is unambiguous", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "recovery-invalid-"))
  try {
    const output = path.join(directory, "result.json")
    const result = await cli.runRecoveryCli(["inspect", "--output", output, "--unknown", "/bad"], {
      environment: {},
    })
    assert.equal(result.exitCode, 1)
    assert.equal(JSON.parse(await readFile(output, "utf8")).status, "blocked")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
test("real read-only runtime never constructs invocation or policy readers and hides publisher helper", async () => {
  const r = await recoveryRemote(),
    calls = []
  const result = runtime.createRecoveryRuntime(
    {
      root: process.cwd(),
      environment: { GITHUB_TOKEN: "api-token", DAWN_RECOVERY_POLICY_TOKEN: "policy-secret" },
      command: "inspect",
      request: { candidate: r.c },
    },
    {
      createGitReader: () => r.args.git,
      createGitHubReader: (options) => {
        calls.push(options)
        return r.args.github
      },
      createNpmReader: () => r.args.npm,
      createAttestationVerifier: (options) => {
        calls.push(options)
        return r.args.attestations
      },
      createNpmAuditVerifier: async (options) => {
        calls.push(options)
        return {
          verifyPackage: async () => "verified",
          verifyPackages: async () => ["batch verified"],
          dispose: async () => {},
          publisherEnvironment: () => {
            throw new Error("forbidden")
          },
        }
      },
      createRunner: () => () => {},
    },
  )
  assert.equal(result.authority, undefined)
  const verifier = await result.observation.npmAuditFactory.create()
  assert.deepEqual(Object.keys(verifier).sort(), ["dispose", "verifyPackage", "verifyPackages"])
  assert.ok(!JSON.stringify(calls).includes("policy-secret"))
  assert.equal(await verifier.verifyPackage({}), "verified")
  assert.deepEqual(await verifier.verifyPackages({}), ["batch verified"])
  await verifier.dispose()
})
test("composed recovery attestation child excludes policy npm and OIDC credentials on success and failure", async () => {
  const { createCliAttestationVerifier } = await import("../artifact-store.mjs")
  const r = await recoveryRemote()
  const environment = {
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_SHA: r.e.controllerSha,
    GITHUB_REF: "refs/heads/main",
    GITHUB_REPOSITORY: r.c.repository,
    GITHUB_REPOSITORY_ID: r.c.repositoryId,
    GITHUB_RUN_ID: r.e.runId,
    GITHUB_RUN_ATTEMPT: r.e.runAttempt,
    GITHUB_WORKFLOW_REF: `${r.c.repository}/.github/workflows/release-postpublication.yml@refs/heads/main`,
    PATH: "/usr/bin",
    HOME: "/home/runner",
    TMPDIR: "/tmp",
    ImageOS: "ubuntu24",
    ImageVersion: "20260901.1",
    GITHUB_TOKEN: "github-token",
    GH_TOKEN: "ambient-gh-token",
    DAWN_RECOVERY_POLICY_TOKEN: "policy-token",
    NPM_TOKEN: "npm-token",
    NODE_AUTH_TOKEN: "node-auth-token",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-token",
    ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.invalid",
    ACTIONS_RUNTIME_TOKEN: "runtime-token",
    NODE_OPTIONS: "--require=/untrusted.js",
  }
  for (const command of ["finalize", "publish"]) {
    for (const fail of [false, true]) {
      const calls = []
      const value = runtime.createRecoveryRuntime(
        { root: process.cwd(), environment, command, request: { candidate: r.c } },
        {
          createAttestationVerifier: (options) =>
            createCliAttestationVerifier({
              ...options,
              async runGh(_args, options) {
                calls.push(options.env)
                if (fail) throw new Error("fixture verification failure")
              },
            }),
        },
      )
      const result = await value.observation.attestations.verify({
        source: "actions",
        record: r.base.record,
        subjects: [{ name: "manifest.json", sha256: r.c.manifestSha256 }],
        files: [{ name: "manifest.json", bytes: Buffer.from("manifest") }],
        bundles: [],
      })
      assert.equal(result.status, fail ? "INVALID" : "VERIFIED")
      assert.ok(
        calls.every(
          (env) =>
            Object.keys(env).sort().join(",") === "GH_TOKEN,HOME,ImageOS,ImageVersion,PATH,TMPDIR",
        ),
        "child environment contains only projected host and attestation keys",
      )
      assert.deepEqual(calls, [
        {
          PATH: "/usr/bin",
          HOME: "/home/runner",
          TMPDIR: "/tmp",
          ImageOS: "ubuntu24",
          ImageVersion: "20260901.1",
          GH_TOKEN: "github-token",
        },
      ])
      assert.equal(environment.DAWN_RECOVERY_POLICY_TOKEN, "policy-token")
    }
  }
})

test("audit dispatch resolver binds input hash and canonical exact persisted intent before audit", async () => {
  const { auditResultRemote } = await import("./support/recovery-audit-fixture.mjs")
  const r = await auditResultRemote()
  r.args.git.listTree = async () => r.intentPath
  const runtimeInput = {
    observation: r.args,
    authority: r.dependencies.authority,
    phaseDeadline: r.dependencies.authority.now() + 1200000,
  }
  const inputs = {
    request_id: r.request.requestId,
    intent_sha256: r
      .assets()
      .find((a) => a.assetName === `recovery-v2-audit-intent-${r.request.requestId}.json`).sha256,
    expected_controller_sha: r.e.controllerSha,
    release_id: r.c.releaseId,
  }
  const result = await runtime.resolveRecoveryAuditRequest(inputs, runtimeInput, r.e.controllerSha)
  assert.deepEqual(result, r.request)
  for (const changed of [
    { intent_sha256: "0".repeat(64) },
    { expected_controller_sha: "d".repeat(40) },
    { release_id: "999" },
    { request_id: "foreign" },
  ])
    await assert.rejects(
      runtime.resolveRecoveryAuditRequest(
        { ...inputs, ...changed },
        runtimeInput,
        r.e.controllerSha,
      ),
    )
  assert.equal(r.effects.length, 0)
})
test("child launch drops credentials on both success and failure", async () => {
  const { EventEmitter } = await import("node:events")
  for (const code of [0, 1]) {
    const spawn = (_command, _args, options) => {
      assert.deepEqual(options.env, { PATH: "/bin", ImageOS: "ubuntu24" })
      const child = new EventEmitter()
      queueMicrotask(() => child.emit("close", code))
      return child
    }
    const run = runtime.runRecoverySmokeChild(
      "/tmp/prepared.json",
      {
        PATH: "/bin",
        ImageOS: "ubuntu24",
        GITHUB_TOKEN: "secret",
        ACTIONS_RUNTIME_TOKEN: "secret",
        DAWN_RECOVERY_POLICY_TOKEN: "secret",
      },
      spawn,
    )
    if (code) await assert.rejects(run, /child failed/)
    else await run
  }
})

test("audit failure and stalled writer stages are non-success despite empty errors", () => {
  assert.equal(
    cli.recoveryCommandExitCode("reconcile-audit", {
      phase: "AUDIT_PENDING",
      outcome: "recovery-required",
      errors: [],
      facts: { audit: { failure: "failed" } },
    }),
    1,
  )
  for (const [command, phase] of [
    ["adopt", "NPM_COMPLETE"],
    ["reconcile-verification", "RECOVERY_ADOPTED"],
    ["dispatch-audit", "VERIFICATION_COMPLETE"],
    ["finalize", "AUDIT_VERIFIED"],
    ["publish", "PUBLICATION_READY"],
  ])
    assert.equal(
      cli.recoveryCommandExitCode(command, { phase, outcome: "recovery-required", errors: [] }),
      1,
    )
})

test("unreserved inspection cannot authorize any writer entrypoint", async () => {
  const { recoveryWriteRemote } = await import("./support/recovery-write-fixture.mjs")
  for (const command of [
    "adopt",
    "reconcile-verification",
    "dispatch-audit",
    "reconcile-audit",
    "finalize",
    "publish",
  ]) {
    const r = await recoveryWriteRemote()
    const show = r.args.git.showFile
    r.args.git.showFile = async (args) => {
      if (args.path === r.intentPath) throw new Error("No committed admission")
      return show(args)
    }
    const request = {
      ...r.request,
      ...(["dispatch-audit", "reconcile-audit"].includes(command)
        ? { requestId: "cannot-authorize" }
        : {}),
    }
    await assert.rejects(
      runtime.executeRecoveryCommand(command, request, { ...r.dependencies, config: r.config }, {}),
    )
    assert.equal(r.effects.length, 0, command)
  }
})
test("writer-unavailable commands have zero effects", async () => {
  const { recoveryWriteRemote } = await import("./support/recovery-write-fixture.mjs")
  for (const command of [
    "adopt",
    "reconcile-verification",
    "dispatch-audit",
    "reconcile-audit",
    "finalize",
    "publish",
  ]) {
    const r = await recoveryWriteRemote()
    const request = {
      ...r.request,
      ...(["dispatch-audit", "reconcile-audit"].includes(command)
        ? { requestId: "unavailable" }
        : {}),
    }
    try {
      const result = await runtime.executeRecoveryCommand(
        command,
        request,
        { ...r.dependencies, config: { ...r.config, token: null } },
        {},
      )
      assert.equal(cli.recoveryCommandExitCode(command, result), 1)
    } catch (error) {
      assert.ok(error instanceof Error)
    }
    assert.equal(r.effects.length, 0, command)
  }
})

test("prototype flag names cannot escape the exact argument allowlist", () => {
  for (const flag of ["constructor", "toString", "__proto__"])
    assert.throws(() =>
      cli.parseRecoveryArgs(["inspect", "--request", "/a", "--output", "/b", flag, "/c"]),
    )
})
test("report still freshly observes when the workflow results file is unavailable", async () => {
  const r = await recoveryRemote({ published: true }),
    directory = await mkdtemp(path.join(os.tmpdir(), "recovery-report-"))
  try {
    const request = path.join(directory, "request.json"),
      output = path.join(directory, "result.json")
    await writeFile(
      request,
      runtime.canonicalRequestBytes({
        candidate: r.c,
        expectedControllerSha: r.e.controllerSha,
        intentPath: r.intentPath,
      }),
    )
    const result = await cli.runRecoveryCli(
      [
        "report",
        "--request",
        request,
        "--output",
        output,
        "--needs",
        path.join(directory, "missing.json"),
      ],
      { environment: {}, createRuntime: async () => ({ observation: r.args }) },
    )
    assert.equal(result.exitCode, 1)
    const report = JSON.parse(await readFile(output, "utf8"))
    assert.equal(report.result.phase, "COMPLETE")
    assert.equal(report.workflowResults, null)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("child timeout first requests strict cleanup and cannot produce successful evidence", async () => {
  const { EventEmitter } = await import("node:events"),
    timers = [],
    signals = []
  const child = new EventEmitter()
  child.kill = (signal) => signals.push(signal)
  const promise = runtime.runRecoverySmokeChild("/tmp/request.json", {}, () => child, {
    phaseDeadline: 1010,
    now: () => 1000,
    setTimer: (callback, delay) => {
      timers.push({ callback, delay })
      return timers.length
    },
    clearTimer: () => {},
  })
  assert.equal(timers[0]?.delay, 10)
  timers[0].callback()
  assert.deepEqual(signals, ["SIGTERM"])
  assert.equal(timers[1].delay, 180000)
  timers[1].callback()
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"])
  child.emit("close", 0)
  await assert.rejects(promise, /cleanup is unverified/)
})

test("separate policy credential is confined to finalization and publication policy GETs", async () => {
  const r = await recoveryRemote()
  const environment = {
    GITHUB_TOKEN: "api-token",
    DAWN_RECOVERY_POLICY_TOKEN: "policy-token",
    GITHUB_REPOSITORY: r.c.repository,
    GITHUB_REPOSITORY_ID: r.c.repositoryId,
    GITHUB_SHA: r.e.controllerSha,
    GITHUB_REF: "refs/heads/main",
    GITHUB_RUN_ID: r.e.runId,
    GITHUB_RUN_ATTEMPT: r.e.runAttempt,
    GITHUB_WORKFLOW_REF: `${r.c.repository}/.github/workflows/release-postpublication.yml@refs/heads/main`,
  }
  for (const command of ["adopt", "finalize", "publish"]) {
    const requests = []
    const fetchImpl = async (url, options) => {
      requests.push({ url, options })
      return new Response(
        JSON.stringify(
          url.endsWith("/immutable-releases")
            ? { enabled: true, enforced_by_owner: false }
            : { id: Number(r.c.repositoryId), full_name: r.c.repository },
        ),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }
    const value = runtime.createRecoveryRuntime(
      { root: process.cwd(), environment, command, request: { candidate: r.c } },
      { fetchImpl },
    )
    assert.equal(value.fetchImpl, fetchImpl)
    await value.observation.github.getRepository()
    assert.equal(requests[0].options.headers.Authorization, "Bearer api-token")
    requests.length = 0
    if (command === "adopt") {
      await assert.rejects(value.observeImmutableReleasePolicy({ candidate: r.c }), /unavailable/)
      assert.equal(requests.length, 0)
    } else {
      await value.observeImmutableReleasePolicy({ candidate: r.c })
      assert.equal(requests.length, 2)
      assert.ok(
        requests.every(
          (r) =>
            r.options.method === "GET" && r.options.headers.Authorization === "Bearer policy-token",
        ),
      )
    }
  }
})

test("final report preserves requested identity, verified receipts and next action without inventing history", async () => {
  const r = await recoveryRemote({ published: true }),
    directory = await mkdtemp(path.join(os.tmpdir(), "recovery-context-"))
  const { RECOVERY_WORKFLOW_NEEDS } = await import("../recovery/workflow.mjs")
  try {
    const request = path.join(directory, "request.json"),
      output = path.join(directory, "result.json"),
      needs = path.join(directory, "needs.json")
    await writeFile(
      request,
      runtime.canonicalRequestBytes({
        candidate: r.c,
        expectedControllerSha: r.e.controllerSha,
        intentPath: r.intentPath,
      }),
    )
    await writeFile(
      needs,
      runtime.canonicalRequestBytes(
        Object.fromEntries(
          Object.keys(RECOVERY_WORKFLOW_NEEDS).map((job) => [
            job,
            {
              result: "success",
              outputs: { phase: "NPM_COMPLETE", effects: [{ assetName: "forged-receipt.json" }] },
            },
          ]),
        ),
      ),
    )
    const result = await cli.runRecoveryCli(
      ["report", "--request", request, "--output", output, "--needs", needs],
      { environment: {}, createRuntime: async () => ({ observation: r.args }) },
    )
    assert.equal(result.exitCode, 0)
    const report = JSON.parse(await readFile(output, "utf8"))
    assert.ok(report.context, "Diagnostic outcome context is retained")
    assert.deepEqual(report.context.requestedCandidate, r.c)
    assert.equal(report.context.controllerSha, r.e.controllerSha)
    assert.equal(report.context.endingDurablePhase, "COMPLETE")
    assert.equal(report.context.startingDurablePhase, null)
    assert.equal(report.context.completedMutations, null)
    assert.equal(report.context.historyStatus, "unavailable")
    assert.equal(report.context.observationStatus, "verified")
    assert.equal(report.context.nextAction, "report")
    assert.equal(
      report.context.selectedReceiptLocations.find((ref) => ref.role === "finalization").sha256,
      r.finalRef.sha256,
    )
    assert.ok(!JSON.stringify(report.context).includes("forged-receipt"))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
test("failed command retains requested identity and explicitly unavailable observation and history", async () => {
  const r = await recoveryRemote(),
    directory = await mkdtemp(path.join(os.tmpdir(), "recovery-context-failure-"))
  try {
    const request = path.join(directory, "request.json"),
      output = path.join(directory, "result.json")
    await writeFile(
      request,
      runtime.canonicalRequestBytes({ candidate: r.c, expectedControllerSha: r.e.controllerSha }),
    )
    await cli.runRecoveryCli(["inspect", "--request", request, "--output", output], {
      environment: { GITHUB_TOKEN: "private-secret" },
      createRuntime: async () => {
        throw new Error("Failure Bearer private-secret")
      },
    })
    const report = JSON.parse(await readFile(output, "utf8"))
    assert.ok(report.context, "Diagnostic outcome context is retained")
    assert.deepEqual(report.context.requestedCandidate, r.c)
    assert.equal(report.context.controllerSha, r.e.controllerSha)
    assert.equal(report.context.endingDurablePhase, null)
    assert.equal(report.context.selectedReceiptLocations, null)
    assert.equal(report.context.completedMutations, null)
    assert.equal(report.context.observationStatus, "unavailable")
    assert.equal(report.context.nextAction, "inspect")
    assert.ok(!JSON.stringify(report).includes("private-secret"))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("an already reserved inspect is non-success and exposes the exact committed intent", async () => {
  const r = await recoveryRemote(),
    directory = await mkdtemp(path.join(os.tmpdir(), "recovery-reserved-"))
  try {
    const request = path.join(directory, "request.json"),
      output = path.join(directory, "result.json")
    await writeFile(
      request,
      runtime.canonicalRequestBytes({ candidate: r.c, expectedControllerSha: r.e.controllerSha }),
    )
    const command = await cli.runRecoveryCli(
      ["inspect", "--request", request, "--output", output],
      { environment: {}, createRuntime: async () => ({ observation: r.args }) },
    )
    assert.equal(command.exitCode, 1)
    const report = JSON.parse(await readFile(output, "utf8"))
    assert.equal(report.result.status, "recovery-required")
    assert.equal(report.result.proposal, null)
    assert.equal(report.context.intentPath, r.intentPath)
    assert.equal(report.context.endingDurablePhase, "NPM_COMPLETE")
    assert.equal(report.context.nextAction, "inspect")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
test("diagnostic next actions follow every durable phase and fixed-finalization repair", async () => {
  const { recoveryDiagnosticContext } = await import("../recovery/diagnostics.mjs")
  const { recoveryFacts } = await import("./support/recovery-fixture.mjs")
  for (const [phase, action] of [
    ["NPM_COMPLETE", "adopt"],
    ["RECOVERY_ADOPTED", "smoke"],
    ["VERIFICATION_COMPLETE", "dispatch-audit"],
    ["AUDIT_PENDING", "reconcile-audit"],
    ["AUDIT_VERIFIED", "finalize"],
    ["PUBLICATION_READY", "publish"],
    ["COMPLETE", "report"],
  ]) {
    const facts = recoveryFacts({ phase })
    facts.assets = facts.fresh.assets
    facts.auditBookkeeping = []
    if (facts.finalization) {
      const { renderRecoveryFinalMetadata } = await import("../recovery/metadata.mjs")
      const metadata = renderRecoveryFinalMetadata(
        facts.finalization.receipt,
        facts.finalization.ref,
      )
      facts.release = { name: metadata.title, body: metadata.body }
    }
    if (phase === "RECOVERY_ADOPTED") facts.verification = null
    const context = recoveryDiagnosticContext(
      { candidate: facts.candidate, expectedControllerSha: facts.executor.controllerSha },
      {
        phase,
        outcome: phase === "COMPLETE" ? "complete" : "recovery-required",
        facts,
        errors: [],
      },
    )
    assert.equal(context.nextAction, action, phase)
    assert.equal(context.endingDurablePhase, phase)
  }
  const facts = recoveryFacts({ phase: "PUBLICATION_READY" })
  facts.assets = facts.fresh.assets
  facts.marker = null
  const context = recoveryDiagnosticContext(null, {
    phase: "UNKNOWN",
    outcome: "recovery-required",
    facts,
    errors: [],
  })
  assert.equal(context.nextAction, "finalize")
  assert.equal(
    context.selectedReceiptLocations.find((ref) => ref.role === "finalization").sha256,
    facts.finalization.ref.sha256,
  )
})
