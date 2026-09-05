import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"
import { collectRecoveryEvidence } from "../recovery/evidence.mjs"
import { evidenceRemote } from "./support/recovery-evidence-fixture.mjs"

const module = await import("../recovery/payload-reuse.mjs").catch(() => ({}))
const hash = (bytes, algorithm = "sha256") => createHash(algorithm).update(bytes).digest("hex")
const bytes = Buffer.from("verified immutable bytes")
const binding = { assetId: "123", maximumBytes: bytes.length, sha256: hash(bytes) }
const encoded = bytes.toString("base64")
function fixture() {
  let calls = 0,
    time = 1000
  const dependencies = {
    fetchImpl: async () => {
      throw new Error("write transport must not be wrapped")
    },
    authority: { now: () => time },
    observation: {
      github: {
        async downloadReleaseAsset() {
          calls++
          return { status: "PRESENT", contentBase64: encoded }
        },
        async downloadActionsArtifact() {
          calls++
          return { status: "PRESENT", contentBase64: encoded }
        },
      },
      npm: {
        async downloadRegistryTarball(args) {
          calls++
          return {
            status: "PRESENT",
            tarball: {
              url: args.tarballUrl,
              size: bytes.length,
              contentBase64: encoded,
              sha1: hash(bytes, "sha1"),
              sha256: hash(bytes),
              sha512: hash(bytes, "sha512"),
            },
          }
        },
      },
    },
  }
  return {
    dependencies,
    calls: () => calls,
    setTime: (value) => {
      time = value
    },
  }
}
const run = (f, operation) => {
  assert.equal(typeof module.withRecoveryPayloadReuse, "function")
  return module.withRecoveryPayloadReuse(f.dependencies, operation)
}
test("one invocation reuses exact verified bytes and retains original writer identity", async () => {
  const f = fixture()
  let retained
  await run(f, async (d) => {
    assert.equal(d.fetchImpl, f.dependencies.fetchImpl)
    retained = d.observation.github
    const first = await retained.downloadReleaseAsset(binding)
    first.contentBase64 = "corrupted caller result"
    assert.equal((await retained.downloadReleaseAsset(binding)).contentBase64, encoded)
    assert.equal(f.calls(), 1)
  })
  await assert.rejects(retained.downloadReleaseAsset(binding), /closed/)
  await run(f, (d) => d.observation.github.downloadReleaseAsset(binding))
  assert.equal(f.calls(), 2)
})
test("fresh identity, digest and exact size are required on every lookup", async () => {
  const f = fixture()
  await run(f, async (d) => {
    const get = d.observation.github.downloadReleaseAsset
    await get(binding)
    await get({ ...binding, assetId: "124" })
    await get({ ...binding, sha256: "0".repeat(64) })
    await get({ ...binding, maximumBytes: bytes.length + 1 })
    await get({ assetId: binding.assetId, maximumBytes: bytes.length })
    assert.equal(f.calls(), 5)
  })
})
test("corrupt and unsuccessful payload responses never populate reuse", async () => {
  const f = fixture()
  let calls = 0
  f.dependencies.observation.github.downloadReleaseAsset = async () => {
    calls++
    return calls === 1 ? { status: "ERROR" } : { status: "PRESENT", contentBase64: "YQ==" }
  }
  await run(f, async (d) => {
    for (let i = 0; i < 3; i++) await d.observation.github.downloadReleaseAsset(binding)
    assert.equal(calls, 3)
  })
})
test("Actions archive reuse binds fresh expiry and rejects elapsed expiry", async () => {
  const f = fixture()
  const args = {
    artifactId: "456",
    maximumBytes: bytes.length,
    sha256: hash(bytes),
    expired: false,
    expiresAt: "1970-01-01T00:00:05.000Z",
  }
  await run(f, async (d) => {
    const get = d.observation.github.downloadActionsArtifact
    await get(args)
    await get(args)
    assert.equal(f.calls(), 1)
    await get({ ...args, expiresAt: "1970-01-01T00:00:06.000Z" })
    assert.equal(f.calls(), 2)
    await assert.rejects(get({ ...args, expired: true }), /expired/)
    f.setTime(5000)
    await assert.rejects(get(args), /expired/)
  })
})
test("npm reuse binds each fresh registry digest and reconstructs payload fields", async () => {
  const f = fixture()
  const args = {
    tarballUrl: "https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz",
    maximumBytes: bytes.length,
    sha256: hash(bytes),
    sha512: hash(bytes, "sha512"),
    shasum: hash(bytes, "sha1"),
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
  }
  await run(f, async (d) => {
    const get = d.observation.npm.downloadRegistryTarball
    assert.deepEqual(await get(args), await get(args))
    assert.equal(f.calls(), 1)
    await get({ ...args, shasum: "0".repeat(40) })
    assert.equal(f.calls(), 2)
  })
})
test("entry limit evicts old payloads", async () => {
  const f = fixture()
  await run(f, async (d) => {
    const get = d.observation.github.downloadReleaseAsset
    for (let i = 1; i <= 129; i++) await get({ ...binding, assetId: String(i) })
    await get({ ...binding, assetId: "1" })
    assert.equal(f.calls(), 130)
  })
})
test("deadline and closure reject late payload settlement and retained readers", async () => {
  const f = fixture()
  let settle, retained, pending
  f.dependencies.observation.github.downloadReleaseAsset = () =>
    new Promise((r) => {
      settle = r
    })
  await run(f, async (d) => {
    retained = d.observation.github
    pending = retained.downloadReleaseAsset(binding)
  })
  settle({ status: "PRESENT", contentBase64: encoded })
  await assert.rejects(pending, /closed/)
  await assert.rejects(retained.downloadReleaseAsset(binding), /closed/)
  await assert.rejects(
    run(f, async (d) => {
      f.setTime(1201000)
      await d.observation.github.downloadReleaseAsset(binding)
    }),
    /deadline/,
  )
})
test("complete 19-write evidence collection reuses payloads while refreshing inventory and batch audits", async () => {
  const r = await evidenceRemote()
  const counts = { release: 0, npm: 0, metadata: 0, actions: 0, factories: 0, audits: 0 }
  for (const [adapter, method, key] of [
    [r.args.github, "downloadReleaseAsset", "release"],
    [r.args.github, "downloadActionsArtifact", "actions"],
    [r.args.npm, "downloadRegistryTarball", "npm"],
    [r.args.npm, "observePackageVersion", "metadata"],
  ]) {
    const original = adapter[method]
    adapter[method] = async (...args) => {
      counts[key]++
      return original(...args)
    }
  }
  const create = r.args.npmAuditFactory.create
  r.args.npmAuditFactory.create = async () => {
    counts.factories++
    const actual = await create()
    return {
      ...actual,
      async verifyPackages(args) {
        counts.audits++
        return actual.verifyPackages(args)
      },
    }
  }
  const result = await collectRecoveryEvidence(r.request, r.config, r.dependencies)
  assert.equal(result.phase, "VERIFICATION_COMPLETE")
  assert.equal(r.effects.length, 19)
  assert.equal(counts.factories, 41)
  assert.equal(counts.audits, 41)
  assert.equal(counts.metadata, 861)
  assert.ok(counts.release < 150, JSON.stringify(counts))
  assert.equal(counts.npm, 21)
  assert.equal(counts.actions, 5)
  const releaseReads = counts.release
  const resumed = await collectRecoveryEvidence(r.request, r.config, r.dependencies)
  assert.equal(resumed.phase, "VERIFICATION_COMPLETE")
  assert.equal(r.effects.length, 19)
  assert.equal(counts.factories, 42)
  assert.equal(counts.audits, 42)
  assert.equal(counts.metadata, 882)
  assert.equal(counts.npm, 42)
  assert.ok(counts.release > releaseReads)
})
test("retained byte budget evicts payloads before the entry limit", async () => {
  const f = fixture()
  const large = Buffer.alloc(10 * 1024 * 1024, 7)
  const args = { ...binding, maximumBytes: large.length, sha256: hash(large) }
  let calls = 0
  f.dependencies.observation.github.downloadReleaseAsset = async () => {
    calls++
    return { status: "PRESENT", contentBase64: large.toString("base64") }
  }
  await run(f, async (d) => {
    for (const assetId of ["1", "2", "3", "1"])
      await d.observation.github.downloadReleaseAsset({ ...args, assetId })
    assert.equal(calls, 4)
  })
})
test("payload expiry that elapses during download rejects the late bytes", async () => {
  const f = fixture()
  f.dependencies.observation.github.downloadActionsArtifact = async () => {
    f.setTime(5000)
    return { status: "PRESENT", contentBase64: encoded }
  }
  await assert.rejects(
    run(f, (d) =>
      d.observation.github.downloadActionsArtifact({
        artifactId: "456",
        maximumBytes: bytes.length,
        sha256: hash(bytes),
        expired: false,
        expiresAt: "1970-01-01T00:00:05.000Z",
      }),
    ),
    /expired/,
  )
})
test("reuse checks the original deadline again after validating cached bytes", async () => {
  const f = fixture()
  let calls = 0,
    advance = false
  f.dependencies.authority.now = () => (advance && ++calls > 1 ? 1201000 : 1000)
  await run(f, async (d) => {
    await d.observation.github.downloadReleaseAsset(binding)
    advance = true
    await assert.rejects(d.observation.github.downloadReleaseAsset(binding), /deadline/)
  })
})
test("invalid initial clock cannot establish a reuse generation", async () => {
  const f = fixture()
  let first = true
  f.dependencies.authority.now = () => {
    if (first) {
      first = false
      return Number.NaN
    }
    return 1000
  }
  await assert.rejects(
    run(f, (d) => d.observation.github.downloadReleaseAsset(binding)),
    /clock/,
  )
})
