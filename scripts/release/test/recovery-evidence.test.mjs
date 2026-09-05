import assert from "node:assert/strict"
import test from "node:test"
import { canonicalRecoveryBytes, parseRecovery } from "../recovery/schema.mjs"
import { evidenceRemote } from "./support/recovery-evidence-fixture.mjs"
import { canonical, digest } from "./support/recovery-fixture.mjs"

const module = await import("../recovery/evidence.mjs").catch(() => ({}))
const collect = (r) => {
  assert.equal(typeof module.collectRecoveryEvidence, "function")
  return module.collectRecoveryEvidence(r.request, r.config, r.dependencies)
}
test("escrows five independently observed lanes and every installation before immutable selection", async () => {
  const r = await evidenceRemote()
  const result = await collect(r)
  assert.equal(result.phase, "VERIFICATION_COMPLETE")
  assert.equal(result.terminal, false)
  const set = result.facts.verification.set
  assert.equal(set.lanes.length, 5)
  assert.equal(
    set.retainedReceipts.filter((ref) => ref.assetName.startsWith("recovery-v2-installation-"))
      .length,
    7,
  )
  assert.equal(
    set.retainedReceipts.filter((ref) => ref.assetName.startsWith("recovery-v2-provenance-"))
      .length,
    5,
  )
  assert.equal(r.effects.at(-1).method, "PATCH")
  for (const selected of set.lanes) {
    const lane = parseRecovery(r.raws.get(selected.receipt.assetName))
    assert.deepEqual(lane, r.lanes[selected.lane])
  }
  assert.notEqual(r.c.candidateSha, set.executor.controllerSha)
})

test("accepted durable selection replays without Actions downloads after artifact expiry", async () => {
  const r = await evidenceRemote()
  await collect(r)
  const downloads = r.downloads(),
    effects = r.effects.length
  r.artifacts.forEach((a) => {
    a.expired = true
  })
  r.args.github.downloadActionsArtifact = async () => {
    throw new Error("expired")
  }
  const result = await collect(r)
  assert.equal(result.phase, "VERIFICATION_COMPLETE")
  assert.equal(r.effects.length, effects)
  assert.equal(r.downloads(), downloads)
})

for (const lane of ["missing", "failed"])
  test(`${lane} lane leaves recovery nonterminal with diagnostics`, async () => {
    const r = await evidenceRemote()
    if (lane === "missing") r.artifacts.pop()
    else {
      r.jobs.at(-1).conclusion = "failure"
      const value = {
        ...r.lanes.storage,
        checks: r.lanes.storage.checks.map((c, i) =>
          i === 0 ? { ...c, conclusion: "failure" } : c,
        ),
        conclusion: "failure",
      }
      r.replaceFiles("storage", [
        { ...r.archives.get("204").files[0], bytes: canonicalRecoveryBytes(value) },
        ...r.archives.get("204").files.slice(1),
      ])
    }
    const result = await collect(r)
    assert.equal(result.phase, "RECOVERY_ADOPTED")
    assert.equal(result.terminal, false)
    assert.ok(result.errors.length > 0)
    assert.equal(
      r.effects.some((e) => e.method === "PATCH"),
      false,
    )
  })

for (const [name, mutate] of [
  ["duplicate artifact", (r) => r.artifacts.push({ ...r.artifacts[0], id: 999 })],
  [
    "foreign artifact",
    (r) => {
      r.artifacts[0].workflow_run.repository_id = 999
    },
  ],
  [
    "wrong run",
    (r) => {
      r.artifacts[0].workflow_run.id = 999
    },
  ],
  [
    "wrong attempt",
    (r) => {
      r.jobs[0].runAttempt = 2
    },
  ],
  [
    "wrong SHA",
    (r) => {
      r.run.head_sha = r.c.candidateSha
    },
  ],
  [
    "wrong job",
    (r) => {
      r.jobs[0].id = 999
    },
  ],
  [
    "expired proof",
    (r) => {
      r.artifacts[0].expired = true
    },
  ],
  [
    "wrong service digest",
    (r) => {
      r.artifacts[0].digest = `sha256:${"0".repeat(64)}`
    },
  ],
  [
    "foreign ZIP file",
    (r) =>
      r.replaceFiles("metadata", [
        ...r.archives.get("200").files,
        { name: "foreign.json", bytes: Buffer.from("{}") },
      ]),
  ],
  [
    "missing installation",
    (r) => r.replaceFiles("published-harness", r.archives.get("201").files.slice(0, -1)),
  ],
  [
    "noncanonical receipt",
    (r) =>
      r.replaceFiles("metadata", [
        { ...r.archives.get("200").files[0], bytes: Buffer.from(JSON.stringify(r.lanes.metadata)) },
      ]),
  ],
  [
    "forged self identity",
    (r) =>
      r.replaceFiles("metadata", [
        {
          ...r.archives.get("200").files[0],
          bytes: canonicalRecoveryBytes({
            ...r.lanes.metadata,
            executor: { ...r.e, jobId: "999" },
          }),
        },
      ]),
  ],
])
  test(`${name} cannot advance or upload unverified evidence`, async () => {
    const r = await evidenceRemote()
    mutate(r)
    await assert.rejects(collect(r))
    assert.equal(r.effects.length, 0)
  })

test("interrupted raw escrow resumes all installation bytes before selecting", async () => {
  const r = await evidenceRemote()
  r.interruptAfter(3)
  await assert.rejects(collect(r), /uncertain|resume|write failed/)
  assert.equal(r.effects.length, 3)
  const result = await collect(r)
  assert.equal(result.phase, "VERIFICATION_COMPLETE")
  assert.equal(new Set(r.assets().map((ref) => ref.assetName)).size, r.assets().length)
})

test("second-precision GitHub job completion contains millisecond lane completion", async () => {
  const r = await evidenceRemote()
  r.jobs[0].completedAt = "2026-09-04T10:02:00Z"
  const lane = { ...r.lanes.metadata, finishedAt: "2026-09-04T10:02:00.500Z" }
  r.replaceFiles("metadata", [
    { ...r.archives.get("200").files[0], bytes: canonicalRecoveryBytes(lane) },
  ])
  const result = await collect(r)
  assert.equal(result.phase, "VERIFICATION_COMPLETE")
})

test("failed before containment retains honest diagnostics without requiring successful toolchain/images", async () => {
  const r = await evidenceRemote()
  const lane = {
    ...r.lanes.storage,
    environment: { ...r.lanes.storage.environment, packageManager: null, dockerImages: [] },
    checks: [
      { name: "cleanup", conclusion: "success" },
      { name: "containment", conclusion: "failure" },
    ],
    conclusion: "failure",
    installations: [],
    resolutions: [],
  }
  r.jobs.at(-1).conclusion = "failure"
  r.replaceFiles("storage", [
    { ...r.archives.get("204").files[0], bytes: canonicalRecoveryBytes(lane) },
  ])
  const result = await collect(r)
  assert.equal(result.phase, "RECOVERY_ADOPTED")
  assert.ok(result.errors.some((e) => /Failed storage/.test(e)))
  assert.ok(
    result.facts.escrow.some((e) => e.lane.lane === "storage" && e.lane.conclusion === "failure"),
  )
})

test("complete escrow survives interruption before marker and later artifact expiry", async () => {
  const r = await evidenceRemote()
  r.interruptAfter(18) // 7 sidecars + 5 lanes + 5 descriptors + immutable set
  await assert.rejects(collect(r), /uncertain|resume|write failed/)
  r.artifacts.forEach((a) => {
    a.expired = true
  })
  r.args.github.downloadActionsArtifact = async () => {
    throw new Error("expired")
  }
  const result = await collect(r)
  assert.equal(result.phase, "VERIFICATION_COMPLETE")
  assert.equal(r.effects.length, 19)
})

test("collector deadline consumed before and between uploads never permits a later mutation", async () => {
  const r = await evidenceRemote()
  const start = r.dependencies.authority.now()
  let time = start,
    first = true
  r.dependencies.authority.now = () => time
  const release = r.args.github.getRelease
  r.args.github.getRelease = async (args) => {
    if (first) {
      first = false
      time += 1000
    }
    return release(args)
  }
  const fence = r.dependencies.authority.observeLegacyFence
  r.dependencies.authority.observeLegacyFence = async () => ({
    ...(await fence()),
    observedAt: time,
    expiresAt: time + 30000,
  })
  const transport = r.dependencies.fetchImpl
  r.dependencies.fetchImpl = async (...args) => {
    const result = await transport(...args)
    time = start + 1200001
    return result
  }
  await assert.rejects(collect(r), /deadline|stopped|resume/)
  assert.equal(r.effects.length, 1)
})

for (const [name, mutate] of [
  [
    "candidate",
    (v) => {
      v.candidate.candidateSha = "d".repeat(40)
    },
  ],
  [
    "executor",
    (v) => {
      v.executor.jobId = "999"
    },
  ],
  [
    "policy",
    (v) => {
      v.policySha256 = "d".repeat(64)
    },
  ],
  [
    "checkpoint",
    (v) => {
      v.check = "typescript-tooling"
    },
  ],
  [
    "lane",
    (v) => {
      v.lane = "storage"
      v.check = "exact-install"
    },
  ],
  [
    "subject classification",
    (v) => {
      v.resolutions[0].name = "foreign-package"
      v.resolutions[0].installPath = "node_modules/foreign-package"
    },
  ],
])
  test(`digest-matching installation with wrong ${name} cannot enter escrow`, async () => {
    const r = await evidenceRemote()
    const files = r.archives.get("201").files.map((f) => ({ ...f }))
    const lane = structuredClone(r.lanes["published-harness"])
    const descriptor = lane.installations[0]
    const oldName = descriptor.assetName
    const value = JSON.parse(files.find((f) => f.name === oldName).bytes)
    mutate(value)
    const bytes = canonical(value)
    descriptor.sha256 = digest(bytes)
    descriptor.size = bytes.length
    descriptor.assetName = `recovery-v2-installation-${lane.lane}-${descriptor.check}-${descriptor.sha256}.json`
    files[0].bytes = canonical(lane)
    const sidecar = files.find((f) => f.name === oldName)
    sidecar.name = descriptor.assetName
    sidecar.bytes = bytes
    r.replaceFiles("published-harness", files)
    await assert.rejects(collect(r), /installation|executor|candidate/)
    assert.equal(r.effects.length, 0)
  })

for (const field of ["size", "count"])
  test(`installation ${field} mismatch cannot enter escrow`, async () => {
    const r = await evidenceRemote()
    const files = r.archives.get("201").files.map((f) => ({ ...f }))
    const lane = structuredClone(r.lanes["published-harness"])
    lane.installations[0][field]++
    files[0].bytes = canonical(lane)
    r.replaceFiles("published-harness", files)
    await assert.rejects(collect(r), /installation/)
    assert.equal(r.effects.length, 0)
  })

test("expiry with raw bytes but no accepted provenance blocks missing proof", async () => {
  const r = await evidenceRemote()
  r.interruptAfter(1)
  await assert.rejects(collect(r), /uncertain|resume|write failed/)
  r.artifacts[0].expired = true
  await assert.rejects(collect(r), /expired/)
  assert.equal(r.effects.length, 1)
})

test("complete descriptors survive response loss and expiry before selection upload", async () => {
  const r = await evidenceRemote()
  r.interruptAfter(17)
  await assert.rejects(collect(r), /uncertain|resume|write failed/)
  r.artifacts.forEach((a) => {
    a.expired = true
  })
  r.args.github.downloadActionsArtifact = async () => {
    throw new Error("expired")
  }
  const result = await collect(r)
  assert.equal(result.phase, "VERIFICATION_COMPLETE")
  assert.equal(r.effects.length, 19)
})

test("artifact and lane times outside the reported job interval are rejected", async () => {
  const r = await evidenceRemote()
  r.jobs[0].completedAt = "2026-09-04T10:01:58Z"
  await assert.rejects(collect(r), /timing/)
  assert.equal(r.effects.length, 0)
})
