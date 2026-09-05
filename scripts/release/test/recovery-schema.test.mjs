import assert from "node:assert/strict"
import test from "node:test"
import {
  candidate,
  canonical,
  executor,
  markerAt,
  PHASES,
  wireFixtures,
} from "./support/recovery-fixture.mjs"

const schema = await import("../recovery/schema.mjs").catch(() => ({}))
const parse = (...args) => {
  assert.equal(typeof schema.parseRecovery, "function", "strict recovery parser exists")
  return schema.parseRecovery(...args)
}
const fixtures = () => {
  const f = wireFixtures()
  return [
    f.intent,
    f.marker,
    f.adoption,
    f.lanes.storage,
    f.set,
    f.auditIntent,
    f.dispatch,
    f.audit,
    f.finalization,
    f.runResult,
  ]
}
for (const value of fixtures()) {
  test(`${value.kind}: canonical wire round trip and exact root fields`, () => {
    assert.deepEqual(parse(canonical(value)), value)
    assert.deepEqual(schema.canonicalRecoveryBytes(value), canonical(value))
    assert.throws(() => parse({ ...value, surprise: true }))
    for (const field of Object.keys(value)) {
      const copy = structuredClone(value)
      delete copy[field]
      assert.throws(() => parse(copy), `${field} required`)
    }
  })
  test(`${value.kind}: schema and candidate identities fail closed`, () => {
    assert.throws(() => parse({ ...value, schemaVersion: 1 }))
    assert.throws(() => parse({ ...value, schemaVersion: 3 }))
    assert.throws(() => parse(value, { candidate: { ...candidate(), releaseId: "999" } }))
    assert.throws(() => parse(value, { kind: "unrecognized-kind" }))
  })
}
for (const phase of PHASES.filter((phase) => phase !== "COMPLETE")) {
  test(`marker phase ${phase} requires its durable prerequisite references`, () => {
    const value = markerAt(phase)
    assert.equal(parse(value).phase, phase)
    for (const field of ["adoption", "verificationSet", "audit", "finalization"]) {
      if (value[field] !== null) assert.throws(() => parse({ ...value, [field]: null }), field)
      else
        assert.throws(
          () => parse({ ...value, [field]: wireFixtures().adoptionRef }),
          `premature ${field}`,
        )
    }
  })
}
test("candidate and executor are separate exact identities", () => {
  const value = wireFixtures().lanes.storage
  assert.notEqual(value.candidate.candidateSha, value.executor.controllerSha)
  assert.deepEqual(parse(value, { executor: executor({ jobId: "104" }) }), value)
  assert.throws(() => parse(value, { executor: executor({ controllerSha: "a".repeat(40) }) }))
  for (const [field, invalid] of [
    ["repository", "Cacheplane/Dawnai"],
    ["repositoryId", "0901"],
    ["releaseId", 902],
    ["candidateSha", "A".repeat(40)],
    ["tagObjectSha", "x".repeat(40)],
    ["manifestSha256", "A".repeat(64)],
    ["version", "01.8.24"],
    ["tag", "v0.8.25"],
  ]) {
    assert.throws(
      () => parse({ ...value, candidate: { ...value.candidate, [field]: invalid } }),
      field,
    )
  }
  for (const field of Object.keys(value.executor))
    assert.throws(() => parse({ ...value, executor: { ...value.executor, [field]: "" } }), field)
})
test("nested fields, asset inventories, and lane derivations are strict", () => {
  const f = wireFixtures()
  for (const mutate of [
    (v) => {
      v.environment.unknown = 1
    },
    (v) => {
      v.checks[0].unknown = 1
    },
    (v) => {
      v.resolutions[0].unknown = 1
    },
    (v) => {
      v.checks = []
    },
    (v) => {
      v.checks[0].conclusion = "failure"
    },
    (v) => {
      v.checks.reverse()
    },
    (v) => {
      v.checks.push(v.checks[0])
    },
    (v) => {
      v.finishedAt = "2026-09-03T10:00:00.000Z"
    },
    (v) => {
      v.resolutions[0].source = "workspace"
    },
    (v) => {
      v.resolutions[0].requested = "latest"
    },
  ]) {
    const v = structuredClone(f.lanes.storage)
    mutate(v)
    assert.throws(() => parse(v))
  }
  for (const mutate of [
    (v) => {
      v.lanes.pop()
    },
    (v) => {
      v.lanes[4] = v.lanes[0]
    },
    (v) => {
      v.lanes[0].executor.runId = "999"
    },
    (v) => {
      v.provenance[0].executor.controllerSha = "e".repeat(40)
    },
    (v) => {
      v.provenance[0].receiptSha256 = "e".repeat(64)
    },
    (v) => {
      v.provenance.pop()
    },
    (v) => {
      v.lanes[0].conclusion = "failure"
    },
  ]) {
    const v = structuredClone(f.set)
    mutate(v)
    assert.throws(() => parse(v))
  }
  for (const mutate of [
    (v) => {
      v.assets.push(v.assets[0])
    },
    (v) => {
      v.assets[1].id = v.assets[0].id
    },
    (v) => {
      v.assets.reverse()
    },
    (v) => {
      v.assets[0].size = -1
    },
    (v) => {
      v.assets[0].size = Infinity
    },
    (v) => {
      v.assets[0].unknown = true
    },
    (v) => {
      v.assets = v.assets.filter((a) => a.id !== v.audit.id)
    },
    (v) => {
      v.assets.push(f.finalRef)
      v.assets.sort((a, b) => a.assetName.localeCompare(b.assetName))
    },
  ]) {
    const v = structuredClone(f.finalization)
    mutate(v)
    assert.throws(() => parse(v))
  }
})
test("canonical raw UTF8 bytes reject duplicate keys and alternate encodings", () => {
  const good = canonical(wireFixtures().marker)
  for (const bad of [
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), good]),
    Buffer.concat([Buffer.from([0xff]), good]),
    good.toString().trim(),
    ` ${good}`,
    good.toString().replace('"revision":1', '"revision":1,"revision":1'),
    good.toString().replace('"revision":1', '"revision":1.0'),
    good.toString().replace('"revision":1', '"revision":1e0'),
    good.toString().replace('"schemaVersion":2', '"schemaVersion":2.0'),
    good.toString().replace("cacheplane", "\\u0063acheplane"),
  ])
    assert.throws(() => parse(bad))
})
test("snapshot is descriptor safe, bounded, isolated and deeply frozen", () => {
  const value = wireFixtures().marker
  const parsed = parse(value)
  value.candidate.releaseId = "999"
  assert.equal(parsed.candidate.releaseId, "902")
  assert.ok(Object.isFrozen(parsed.candidate))
  let reads = 0
  const getter = wireFixtures().marker
  Object.defineProperty(getter.candidate, "releaseId", {
    enumerable: true,
    get() {
      reads++
      throw new Error("must not run")
    },
  })
  assert.throws(() => parse(getter))
  assert.equal(reads, 0)
  const cycle = wireFixtures().marker
  cycle.candidate = cycle
  assert.throws(() => parse(cycle))
  for (const bad of [
    Object.assign(wireFixtures().marker, { [Symbol("x")]: 1 }),
    { ...wireFixtures().marker, revision: -0 },
    { ...wireFixtures().marker, candidate: new Date() },
    { ...wireFixtures().marker, revision: NaN },
    { ...wireFixtures().marker, phase: "\ud800" },
  ])
    assert.throws(() => parse(bad))
  let deep = {}
  for (let i = 0; i < 100; i++) deep = { nested: deep }
  assert.throws(() => parse(deep), /limit|depth/i)
  assert.throws(() => parse(Buffer.alloc(1024 * 1024 + 1, 32)), /limit|large/i)
})
test("receipt, resolution and retained inventory caps are separate", () => {
  assert.ok(schema.RECOVERY_LIMITS, "recovery limits exist")
  assert.equal(schema.RECOVERY_LIMITS.receiptBytes, 256 * 1024)
  assert.equal(schema.RECOVERY_LIMITS.selectionBytes, 1024 * 1024)
  const f = wireFixtures()
  const lane = structuredClone(f.lanes.storage)
  lane.resolutions[0].integrity = "x".repeat(256 * 1024)
  assert.throws(() => parse(lane))
  const tooMany = Array.from({ length: 2049 }, (_, i) => ({
    assetName: `recovery-v2-retained-${String(i).padStart(4, "0")}.json`,
    id: String(1000 + i),
    sha256: "a".repeat(64),
    size: 1,
  }))
  assert.throws(() => parse({ ...f.set, retainedReceipts: tooMany }))
  const allowed = tooMany.slice(0, 2048)
  assert.equal(parse({ ...f.set, retainedReceipts: allowed }).retainedReceipts.length, 2048)
  const bytes = structuredClone(allowed.slice(0, 1024))
  for (const ref of bytes) ref.size = 65536
  assert.equal(parse({ ...f.set, retainedReceipts: bytes }).retainedReceipts.length, 1024)
  bytes[0].size++
  assert.throws(() => parse({ ...f.set, retainedReceipts: bytes }))
})

test("COMPLETE is derived and never serialized as a marker", () => {
  assert.throws(() => parse({ ...markerAt("PUBLICATION_READY"), phase: "COMPLETE" }))
})
test("resolution identity allows installed duplicate versions and honest transitive selectors", () => {
  const lane = wireFixtures().lanes.storage
  lane.resolutions.push({
    ...lane.resolutions[0],
    installPath: "node_modules/consumer/node_modules/@dawn-ai/sdk",
    subject: false,
    requested: "^0.8.0",
    resolved: "0.8.23",
  })
  assert.equal(parse(lane).resolutions.length, 2)
  lane.resolutions[1].installPath = lane.resolutions[0].installPath
  assert.throws(() => parse(lane))
})
test("environment binds observed container images", () => {
  const lane = wireFixtures().lanes.storage
  lane.environment.dockerImages[0].digest = "postgres:16"
  assert.throws(() => parse(lane))
})

test("caller options and raw byte descriptors never execute accessors", () => {
  let reads = 0
  const options = {
    get kind() {
      reads++
      return "recovery-marker"
    },
  }
  assert.throws(() => parse(wireFixtures().marker, options))
  assert.equal(reads, 0)
  const bytes = canonical(wireFixtures().marker)
  Object.defineProperty(bytes, "length", {
    get() {
      reads++
      return 1
    },
  })
  assert.throws(() => parse(bytes))
  assert.equal(reads, 0)
  class ExoticBytes extends Uint8Array {}
  assert.throws(() => parse(new ExoticBytes(canonical(wireFixtures().marker))))
  assert.throws(() =>
    parse(
      canonical(wireFixtures().finalization)
        .toString()
        .replace("Release notes preserved from the candidate.", "\ud800"),
    ),
  )
})
test("run results cannot invent terminal completion or regress observed phases", () => {
  const f = wireFixtures()
  for (const value of [
    { ...f.runResult, outcome: "complete", effects: [] },
    { ...f.runResult, before: "PUBLICATION_READY", after: "NPM_COMPLETE" },
    { ...f.runResult, effects: [{ operation: "write-marker", target: "COMPLETE" }] },
    {
      ...f.runResult,
      outcome: "complete",
      before: "PUBLICATION_READY",
      after: "COMPLETE",
      effects: [{ operation: "publish", target: "902" }],
    },
  ])
    assert.throws(() => parse(value))
  assert.equal(
    parse({
      ...f.runResult,
      before: "PUBLICATION_READY",
      after: "COMPLETE",
      outcome: "complete",
      effects: [],
      evidence: [f.finalRef],
    }).after,
    "COMPLETE",
  )
})
test("original canonical asset names and payload group budgets are preserved", () => {
  const f = wireFixtures()
  assert.ok(parse(f.adoption).baseAssets.some((asset) => asset.assetName === "manifest.json"))
  const extra = (name, size, id) => ({
    assetName: name,
    id: String(id),
    sha256: "a".repeat(64),
    size,
  })
  const adoption = structuredClone(f.adoption)
  adoption.baseAssets.push(extra("dawn-sdk-0.8.24.tgz", 32 * 1024 * 1024, 1000))
  adoption.baseAssets.sort((a, b) => (a.assetName < b.assetName ? -1 : 1))
  assert.throws(() => parse(adoption), /limit/)
  const bundle = structuredClone(f.adoption)
  bundle.baseAssets.push(extra("other.tgz.intoto.jsonl", 2 * 1024 * 1024, 1000))
  bundle.baseAssets.sort((a, b) => (a.assetName < b.assetName ? -1 : 1))
  assert.ok(parse(bundle))
  bundle.baseAssets.find((a) => a.id === "1000").size++
  assert.throws(() => parse(bundle), /limit/)
  for (const name of ["unexpected.json", "manifest.json.sigstore.json", "release-manifest.json"]) {
    const v = structuredClone(f.adoption)
    v.baseAssets.push(extra(name, 1, 1000))
    v.baseAssets.sort((a, b) => (a.assetName < b.assetName ? -1 : 1))
    assert.throws(() => parse(v))
  }
})

test("five lane jobs must be independent identities within their selected run", () => {
  const value = wireFixtures().set
  for (const lane of value.lanes) lane.executor.jobId = "100"
  for (const provenance of value.provenance) provenance.executor.jobId = "100"
  assert.throws(() => parse(value), /job|identity/)
})
test("run results report UNKNOWN observations and proven readiness repair without inventing success", () => {
  const f = wireFixtures()
  const unknown = {
    ...f.runResult,
    before: "UNKNOWN",
    after: "UNKNOWN",
    outcome: "blocked",
    effects: [],
    evidence: [],
    errors: ["unsupported marker"],
  }
  assert.equal(parse(unknown).before, "UNKNOWN")
  const complete = {
    ...f.runResult,
    before: "UNKNOWN",
    after: "COMPLETE",
    outcome: "complete",
    effects: [],
    evidence: [f.finalRef],
  }
  assert.equal(parse(complete).after, "COMPLETE")
  const repaired = {
    ...f.runResult,
    before: "RECOVERY_ADOPTED",
    after: "PUBLICATION_READY",
    outcome: "advanced",
    effects: [{ operation: "write-marker", target: "PUBLICATION_READY" }],
    evidence: [f.finalRef],
  }
  assert.equal(parse(repaired).after, "PUBLICATION_READY")
  for (const bad of [
    { ...f.runResult, effects: [], evidence: [], errors: ["failed"] },
    { ...complete, evidence: [], errors: ["invalid finalization"] },
    { ...f.runResult, outcome: "planned", effects: [], evidence: [] },
    { ...repaired, evidence: [f.adoptionRef] },
  ])
    assert.throws(() => parse(bad))
})

test("terminal COMPLETE run results cannot plan or report readiness reopening", () => {
  const f = wireFixtures()
  for (const outcome of ["advanced", "planned"]) {
    assert.throws(() =>
      parse({
        ...f.runResult,
        before: "COMPLETE",
        after: "PUBLICATION_READY",
        outcome,
        effects: [{ operation: "write-marker", target: "PUBLICATION_READY" }],
        evidence: [f.finalRef],
      }),
    )
  }
})

test("root, nested, options and raw-byte proxies are rejected without executing traps", () => {
  let calls = 0
  const wrap = (value) =>
    new Proxy(value, {
      get() {
        calls++
        throw new Error("proxy get executed")
      },
      getPrototypeOf() {
        calls++
        throw new Error("proxy prototype executed")
      },
      ownKeys() {
        calls++
        throw new Error("proxy keys executed")
      },
      getOwnPropertyDescriptor() {
        calls++
        throw new Error("proxy descriptor executed")
      },
    })
  assert.throws(() => parse(wrap(wireFixtures().marker)))
  const nested = wireFixtures().marker
  nested.candidate = wrap(nested.candidate)
  assert.throws(() => parse(nested))
  assert.throws(() => parse(wireFixtures().marker, wrap({})))
  assert.throws(() => parse(wrap(canonical(wireFixtures().marker))))
  assert.equal(calls, 0)
})

test("every reported or planned marker mutation targets the reported ending phase", () => {
  const f = wireFixtures()
  assert.throws(() =>
    parse({
      ...f.runResult,
      before: "AUDIT_VERIFIED",
      after: "AUDIT_VERIFIED",
      outcome: "planned",
      effects: [{ operation: "write-marker", target: "RECOVERY_ADOPTED" }],
    }),
  )
  assert.throws(() =>
    parse({
      ...f.runResult,
      effects: [...f.runResult.effects, { operation: "write-marker", target: "PUBLICATION_READY" }],
    }),
  )
})
