import assert from "node:assert/strict"
import test from "node:test"
import { canonical, markerAt, wireFixtures } from "./support/recovery-fixture.mjs"

const metadata = await import("../recovery/metadata.mjs").catch(() => ({}))
const observer = await import("../recovery/observe.mjs").catch(() => ({}))

test("v2 metadata round trips canonical bounded wire without a legacy interpretation", () => {
  assert.equal(typeof metadata.renderRecoveryReleaseBody, "function")
  const marker = markerAt("PUBLICATION_READY")
  const body = metadata.renderRecoveryReleaseBody({ marker, body: "Original notes" })
  assert.deepEqual(metadata.parseRecoveryReleaseMarker(body), marker)
  for (const corrupt of [
    body.replace('"schemaVersion":2', '"schemaVersion":3'),
    `${body}\n${body}`,
    body.replace('"revision":5', '"revision":5,"revision":5'),
  ])
    assert.throws(() => metadata.parseRecoveryReleaseMarker(corrupt))
  assert.throws(() =>
    metadata.renderRecoveryReleaseBody({ marker, body: "<!-- DAWN_RELEASE_CONTROLLER_MARKER\n" }),
  )
})

test("fixed finalization reconstructs readiness metadata without recursive digests", () => {
  assert.equal(typeof metadata.renderRecoveryFinalMetadata, "function")
  const f = wireFixtures()
  const rendered = metadata.renderRecoveryFinalMetadata(f.finalization, f.finalRef)
  assert.equal(rendered.title, f.finalization.metadata.title)
  assert.deepEqual(
    metadata.parseRecoveryReleaseMarker(rendered.body),
    markerAt("PUBLICATION_READY", f),
  )
  assert.ok(!JSON.stringify(f.finalization).includes(f.finalRef.sha256))
})

test("independent recovery observer is exported separately from the v1 observation schema", () => {
  assert.equal(typeof observer.observeRecoveryCandidate, "function")
})

import { recoveryRemote } from "./support/recovery-observe-fixture.mjs"

const observe = async (args) => {
  assert.equal(typeof observer.observeRecoveryCandidate, "function")
  return observer.observeRecoveryCandidate(args)
}

test("reserved legacy NPM_COMPLETE independently checks unchanged original assets and all npm versions", async () => {
  const remote = await recoveryRemote()
  const result = await observe(remote.args)
  assert.equal(result.outcome, "recovery-required")
  assert.equal(result.phase, "NPM_COMPLETE")
  assert.equal(result.terminal, false)
  assert.equal(result.facts.manifestPackages.length, remote.base.manifest.packages.length)
  assert.equal(result.facts.npmEvidence.conclusion, "success")
  assert.ok(remote.calls.includes("dispose"))
})

test("adopted draft uses separate recovery facts without a fake v1 smoke or publication proof", async () => {
  const remote = await recoveryRemote()
  remote.release.body = metadata.renderRecoveryReleaseBody({ marker: remote.marker, body: "Notes" })
  remote.setAssets([...remote.baseAssets, remote.adoption.archive, remote.adoptionRef])
  const result = await observe(remote.args)
  assert.equal(result.phase, "RECOVERY_ADOPTED")
  assert.equal(result.outcome, "recovery-required")
  assert.equal(result.terminal, false)
  assert.equal(result.observation, undefined)
})

for (const body of ["corrupt <!-- DAWN_RELEASE_CONTROLLER_MARKER\n{", "", "Human edited notes"]) {
  test(`published immutable finalization remains terminal despite display body ${JSON.stringify(body)}`, async () => {
    const remote = await recoveryRemote({ published: true })
    remote.release.body = body
    remote.release.name = "Human edited title"
    const result = await observe(remote.args)
    assert.equal(result.outcome, "complete", JSON.stringify(result.errors))
    assert.equal(result.phase, "COMPLETE")
    assert.equal(result.terminal, true)
    assert.equal(result.displayDrift, true)
  })
}

for (const [name, mutate] of [
  [
    "absent npm package",
    (r) => {
      r.args.npm.observePackageVersion = async () => ({ status: "ABSENT", httpStatus: 404 })
    },
  ],
  [
    "conflicting npm tarball",
    (r) => {
      r.args.npm.downloadRegistryTarball = async () => ({
        status: "PRESENT",
        tarball: { contentBase64: "Y29uZmxpY3Q=" },
      })
    },
  ],
  [
    "wrong canonical release ID",
    (r) => {
      r.release.id = 999
    },
  ],
  [
    "wrong annotated tag",
    (r) => {
      r.args.github.getGitTag = async () => ({
        status: "PRESENT",
        value: {
          tag: r.c.tag,
          sha: r.c.tagObjectSha,
          object: { type: "commit", sha: "e".repeat(40) },
        },
      })
    },
  ],
  [
    "original asset byte replacement",
    (r) => {
      r.raws.set("manifest.json", Buffer.from("tampered"))
    },
  ],
  [
    "unknown marker schema",
    (r) => {
      r.release.body = metadata
        .renderRecoveryReleaseBody({ marker: r.marker, body: "Notes" })
        .replace('"schemaVersion":2', '"schemaVersion":3')
    },
  ],
  [
    "invalid original attestation",
    (r) => {
      r.args.attestations = { verify: async () => ({ status: "INVALID" }) }
    },
  ],
  [
    "npm source mismatch",
    (r) => {
      r.args.npmAuditFactory = {
        create: async () => ({
          verifyPackage: async () => ({ status: "verified", signature: { status: "valid" } }),
          dispose: async () => {},
        }),
      }
    },
  ],
])
  test(`${name} blocks recovery without opening legacy ownership`, async () => {
    const r = await recoveryRemote()
    mutate(r)
    const result = await observe(r.args)
    assert.equal(result.outcome, "blocked")
    assert.equal(result.terminal, false)
    assert.ok(result.errors.length > 0)
  })

test("terminal chain cannot fabricate reviewed-main-ci from a policy and source digest", async () => {
  const r = await recoveryRemote({ published: true })
  r.args.github.getCommitCheckRuns = async () => ({ status: "PRESENT", value: [] })
  const result = await observe(r.args)
  assert.equal(result.outcome, "blocked")
  assert.equal(result.terminal, false)
})

import { runRecoveryRead } from "../recovery/policy.mjs"

test("large release payload uses an explicit bounded transport budget, preserving the receipt JSON cap", async () => {
  const base64 = Buffer.alloc(12_107_594, 1).toString("base64")
  const result = await runRecoveryRead(
    { phaseDeadline: Date.now() + 10000, responseBytes: base64.length + 256 },
    async () => ({ status: "PRESENT", contentBase64: base64 }),
  )
  assert.equal(result.contentBase64, base64)
  await assert.rejects(
    runRecoveryRead({ phaseDeadline: Date.now() + 10000 }, async () => ({
      status: "PRESENT",
      contentBase64: base64,
    })),
    /byte limit/,
  )
})
for (const options of [
  { operations: ["adopt"] },
  { ownerWorkflow: ".github/workflows/unapproved.yml" },
  { ownerWorkflow: ".github/workflows/release-postpublication-audit.yml" },
  { platform: "darwin" },
])
  test(`coherent terminal chain rejects ineligible historical authority ${JSON.stringify(options)}`, async () => {
    const r = await recoveryRemote({ published: true, ...options })
    const result = await observe(r.args)
    assert.equal(result.outcome, "blocked")
    assert.equal(result.terminal, false)
  })
test("unknown retained receipt cannot become valid by appearing in the final inventory", async () => {
  const r = await recoveryRemote({ published: true, retainedRaw: '{"schemaVersion":99}\n' })
  const result = await observe(r.args)
  assert.equal(result.outcome, "blocked")
  assert.equal(result.terminal, false)
})
for (const [phase, ref] of [
  ["VERIFICATION_COMPLETE", "setRef"],
  ["AUDIT_PENDING", "dispatchRef"],
  ["AUDIT_VERIFIED", "auditRef"],
])
  test(`${phase} collects and verifies its selected intermediate recovery evidence`, async () => {
    const r = await recoveryRemote()
    const marker = {
      ...r.marker,
      phase,
      revision: phase === "VERIFICATION_COMPLETE" ? 2 : phase === "AUDIT_PENDING" ? 3 : 4,
      verificationSet: r.setRef,
      audit: phase === "VERIFICATION_COMPLETE" ? null : r[ref],
    }
    r.release.body = metadata.renderRecoveryReleaseBody({ marker, body: "notes" })
    r.setAssets(r.allAssets.filter((a) => a.assetName !== "recovery-v2-finalization.json"))
    const result = await observe(r.args)
    assert.equal(result.outcome, "recovery-required", JSON.stringify(result.errors))
    assert.ok(result.facts.verification)
    if (phase !== "VERIFICATION_COMPLETE") assert.ok(result.facts.audit)
  })
test("observer rejects dependency accessors before executing them", async () => {
  const r = await recoveryRemote()
  let calls = 0
  Object.defineProperty(r.args, "github", {
    get() {
      calls++
      return {}
    },
  })
  await assert.rejects(observe(r.args), /descriptor|safe|accessor/)
  assert.equal(calls, 0)
})
test("missing current recovery policy blocks durable ownership rather than dropping to legacy", async () => {
  const r = await recoveryRemote({ published: true })
  r.args.controllerRef = "f".repeat(40)
  const original = r.args.git.showFile
  r.args.git.showFile = async (args) => {
    if (args.ref === r.args.controllerRef && args.path === "scripts/release/recovery/policy.json")
      throw new Error("policy missing")
    return original(args)
  }
  const result = await observe(r.args)
  assert.equal(result.outcome, "blocked")
  assert.equal(result.terminal, false)
})
test("timed out verifier cleanup waits for settlement and runs exactly once without accepting late proof", async () => {
  assert.equal(typeof observer.createRecoveryWorkBudget, "function")
  let timeout,
    resolveWork,
    cleanups = 0
  const budget = observer.createRecoveryWorkBudget(
    { phaseDeadline: 100 },
    {
      now: () => 0,
      setTimer: (fn) => {
        timeout = fn
        return 1
      },
      clearTimer: () => {},
    },
  )
  const delayed = new Promise((resolve) => {
    resolveWork = resolve
  })
  const result = budget.work(
    () => delayed,
    async () => {
      cleanups++
    },
  )
  await Promise.resolve()
  timeout()
  await assert.rejects(result, /deadline/)
  assert.equal(cleanups, 0)
  resolveWork({ status: "verified" })
  await delayed
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(cleanups, 1)
  assert.equal(budget.settled(), false)
  await assert.rejects(
    budget.work(async () => "late authority"),
    /not settled/,
  )
})
test("asset budgets admit separate original and retained limits and reject a namespace overflow", () => {
  assert.equal(typeof observer.normalizeRecoveryAssetInventory, "function")
  const assets = Array.from({ length: 40 }, (_, i) => ({
    id: i + 1,
    name: `package-${i}.tgz`,
    size: 1024 * 1024,
    digest: `sha256:${"a".repeat(64)}`,
  })).concat(
    Array.from({ length: 40 }, (_, i) => ({
      id: i + 41,
      name: `recovery-v2-retained-${i}.json`,
      size: 1024 * 1024,
      digest: `sha256:${"b".repeat(64)}`,
    })),
  )
  assert.equal(observer.normalizeRecoveryAssetInventory(assets).length, 80)
  assets.push(
    ...Array.from({ length: 25 }, (_, i) => ({
      id: i + 81,
      name: `recovery-v2-retained-extra-${i}.json`,
      size: 1024 * 1024,
      digest: `sha256:${"b".repeat(64)}`,
    })),
  )
  assert.throws(() => observer.normalizeRecoveryAssetInventory(assets), /budget/)
})

test("idle npm verifier is disposed when an ordinary read exhausts the observation deadline", async () => {
  const r = await recoveryRemote()
  const originalNow = Date.now
  let tick = originalNow()
  let cleanupCalls = 0
  const create = r.args.npmAuditFactory.create
  r.args.npmAuditFactory.create = async () => {
    const verifier = await create()
    return {
      ...verifier,
      async dispose() {
        cleanupCalls++
        return verifier.dispose()
      },
    }
  }
  const read = r.args.npm.observePackageVersion
  r.args.npm.observePackageVersion = async (args) => {
    tick += 1_200_001
    return read(args)
  }
  Date.now = () => tick
  try {
    const result = await observe(r.args)
    assert.equal(result.outcome, "blocked")
    assert.equal(result.terminal, false)
    assert.equal(cleanupCalls, 1)
  } finally {
    Date.now = originalNow
  }
})

test("canonical published recovery metadata is terminal without display drift", async () => {
  const r = await recoveryRemote({ published: true })
  const rendered = metadata.renderRecoveryFinalMetadata(r.finalization, r.finalRef)
  r.release.name = rendered.title
  r.release.body = rendered.body
  const result = await observe(r.args)
  assert.equal(result.outcome, "complete", JSON.stringify(result.errors))
  assert.equal(result.terminal, true)
  assert.equal(result.facts.publication.metadata, "matching")
  assert.equal(result.displayDrift, false)
})

for (const omitArchive of [false, true])
  test(`legacy NPM_COMPLETE with fixed finalization blocks even with ${omitArchive ? "invalid" : "valid"} final inventory`, async () => {
    const r = await recoveryRemote()
    const finalization = omitArchive
      ? {
          ...r.finalization,
          assets: r.finalization.assets.filter((a) => a.assetName !== r.adoption.archive.assetName),
        }
      : r.finalization
    const finalRef = r.add("recovery-v2-finalization.json", finalization)
    r.setAssets([...r.allAssets.filter((a) => a.assetName !== finalRef.assetName), finalRef])
    const result = await observe(r.args)
    assert.equal(result.outcome, "blocked")
    assert.equal(result.terminal, false)
    assert.match(result.errors.join("; "), /legacy.*finalization|finalization.*legacy/)
  })

test("observer supplies canonical independently downloaded installation proofs", async () => {
  const remote = await recoveryRemote({ published: true })
  const result = await observe(remote.args)
  assert.equal(result.outcome, "complete", result.errors.join("; "))
  assert.deepEqual(
    Object.keys(result.facts.verification.installations).sort(),
    remote.installationAssets.map((ref) => ref.assetName).sort(),
  )
  for (const ref of remote.installationAssets) {
    assert.deepEqual(result.facts.verification.installations[ref.assetName], {
      ref,
      bytes: remote.raws.get(ref.assetName).toString("utf8"),
    })
  }
})
for (const [name, options] of [
  [
    "metadata omits one actual manifest package",
    {
      mutateLane(lane) {
        if (lane.lane === "metadata")
          lane.checks = lane.checks.filter((c) => c.name !== "package-dawn-ai-sdk")
      },
    },
  ],
  [
    "storage reports only postgres",
    {
      mutateLane(lane) {
        if (lane.lane === "storage") lane.environment.dockerImages.shift()
      },
    },
  ],
  [
    "harness omits Docker identity",
    {
      mutateLane(lane) {
        if (lane.lane === "published-harness") lane.environment.dockerImages = []
      },
    },
  ],
  [
    "runtime reports storage Docker image",
    {
      mutateLane(lane) {
        if (lane.lane === "runtime-targets")
          lane.environment.dockerImages = [
            { reference: "postgres:16", digest: `sha256:${"a".repeat(64)}` },
          ]
      },
    },
  ],
  [
    "wrong sidecar count",
    {
      mutateLane(lane) {
        if (lane.lane === "storage") lane.installations[0].count++
      },
    },
  ],
  [
    "sidecar was not retained",
    {
      mutateSet(set) {
        set.retainedReceipts.pop()
      },
    },
  ],
  [
    "sidecar belongs to wrong executor",
    {
      mutateInstallation(value) {
        value.executor = { ...value.executor, runId: "999" }
      },
    },
  ],
  [
    "known subject hidden as dependency",
    {
      mutateInstallation(value) {
        value.resolutions.push({
          ...value.resolutions[0],
          installPath: "node_modules/z/node_modules/@dawn-ai/sdk",
          subject: false,
          requested: "^0.7.0",
          resolved: "0.7.0",
        })
      },
    },
  ],
]) {
  test(`observer blocks canonical evidence when ${name}`, async () => {
    const remote = await recoveryRemote({ published: true, ...options })
    const result = await observe(remote.args)
    assert.equal(result.outcome, "blocked")
    assert.equal(result.terminal, false)
  })
}

for (const mode of ["missing", "different"]) {
  test(`observer blocks ${mode} remotely downloaded installation bytes`, async () => {
    const remote = await recoveryRemote({ published: true })
    const ref = remote.installationAssets[0]
    const download = remote.args.github.downloadReleaseAsset.bind(remote.args.github)
    remote.args.github.downloadReleaseAsset = async (args) => {
      if (String(args.assetId) === ref.id)
        return mode === "missing"
          ? { status: "ABSENT", httpStatus: 404 }
          : {
              status: "PRESENT",
              contentBase64: Buffer.from("different bytes").toString("base64"),
            }
      return download(args)
    }
    const result = await observe(remote.args)
    assert.equal(result.outcome, "blocked")
    assert.equal(result.terminal, false)
  })
}

test("valid older installation receipts remain retained diagnostic evidence", async () => {
  const previous = await recoveryRemote()
  const older = structuredClone(Object.values(previous.installationReceipts)[0])
  older.executor.runAttempt = "2"
  const remote = await recoveryRemote({
    published: true,
    retainedRaw: canonical(older).toString("utf8"),
  })
  const result = await observe(remote.args)
  assert.equal(result.outcome, "complete", result.errors.join("; "))
  assert.equal(Object.keys(result.facts.verification.installations).length, 7)
  assert.equal(result.facts.verification.set.retainedReceipts.length, 8)
})
