import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"

import {
  canonicalManifestBytes,
  manifestSha256,
  parseReleaseManifest,
  RELEASE_MANIFEST_SCHEMA_VERSION,
  validateReleaseManifest,
} from "../manifest.mjs"

const VERSION = "1.2.3"
const COMMIT_SHA = "0123456789abcdef0123456789abcdef01234567"
const releasePackages = [
  { name: "base" },
  { name: "middle", dependencies: { base: "workspace:*" } },
  { name: "create-dawn-ai-app", dependencies: { middle: "workspace:*" } },
]
const context = { packages: releasePackages }

test("parseReleaseManifest accepts and freezes a complete valid manifest", () => {
  const expected = validManifest()

  const manifest = parseReleaseManifest(JSON.stringify(expected), context)

  assert.deepEqual(manifest, expected)
  assert.equal(RELEASE_MANIFEST_SCHEMA_VERSION, 1)
  assertRecursivelyFrozen(manifest)
  assert.notEqual(manifest, expected)
})

test("parseReleaseManifest rejects malformed JSON and non-object roots", () => {
  assert.throws(() => parseReleaseManifest("{", context), /Invalid release manifest JSON/u)
  assert.throws(() => parseReleaseManifest("[]", context), /manifest must be an object/u)
})

const invalidManifestCases = [
  {
    invariant: "schema version",
    mutate(manifest) {
      manifest.schemaVersion = 2
    },
    error: /schemaVersion must be 1/u,
  },
  {
    invariant: "40-character commit SHA",
    mutate(manifest) {
      manifest.commitSha = "not-a-commit"
    },
    error: /commitSha must be a 40-character lowercase hexadecimal SHA/u,
  },
  {
    invariant: "exact version",
    mutate(manifest) {
      manifest.version = "^1.2.3"
    },
    error: /version must be an exact SemVer/u,
  },
  {
    invariant: "matching package version",
    mutate(manifest) {
      manifest.packages[0].version = "1.2.4"
    },
    error: /base version must match manifest version/u,
  },
  {
    invariant: "exact package set",
    mutate(manifest) {
      manifest.packages.pop()
    },
    error: /packages must exactly match the canonical release inventory/u,
  },
  {
    invariant: "duplicate packages",
    mutate(manifest) {
      manifest.packages[2] = structuredClone(manifest.packages[0])
    },
    error: /packages contains duplicate package base/u,
  },
  {
    invariant: "path traversal",
    mutate(manifest) {
      manifest.packages[0].filename = "../base-1.2.3.tgz"
    },
    error: /base filename must be a basename/u,
  },
  {
    invariant: "canonical basename",
    mutate(manifest) {
      manifest.packages[0].filename = "other-1.2.3.tgz"
    },
    error: /base filename must be base-1.2.3\.tgz/u,
  },
  {
    invariant: "public access",
    mutate(manifest) {
      manifest.packages[0].access = "restricted"
    },
    error: /base access must be public/u,
  },
  {
    invariant: "positive size",
    mutate(manifest) {
      manifest.packages[0].size = 0
    },
    error: /base size must be a positive integer/u,
  },
  {
    invariant: "lowercase SHA-256",
    mutate(manifest) {
      manifest.packages[0].sha256 = manifest.packages[0].sha256.toUpperCase()
    },
    error: /base sha256 must be a lowercase SHA-256 digest/u,
  },
  {
    invariant: "lowercase SHA-512",
    mutate(manifest) {
      manifest.packages[0].sha512 = manifest.packages[0].sha512.toUpperCase()
    },
    error: /base sha512 must be a lowercase SHA-512 digest/u,
  },
  {
    invariant: "matching npm integrity",
    mutate(manifest) {
      manifest.packages[0].npmIntegrity = "sha512-invalid"
    },
    error: /base npmIntegrity must match sha512/u,
  },
  {
    invariant: "dependency order",
    mutate(manifest) {
      ;[manifest.packageOrder[0], manifest.packageOrder[1]] = [
        manifest.packageOrder[1],
        manifest.packageOrder[0],
      ]
      ;[manifest.packages[0], manifest.packages[1]] = [manifest.packages[1], manifest.packages[0]]
    },
    error: /packageOrder must be the canonical dependency order/u,
  },
]

for (const { invariant, mutate, error } of invalidManifestCases) {
  test(`validateReleaseManifest rejects an invalid ${invariant}`, () => {
    const manifest = validManifest()
    mutate(manifest)

    assert.throws(() => validateReleaseManifest(manifest, context), error)
  })
}

test("validateReleaseManifest rejects package arrays that differ from packageOrder", () => {
  const manifest = validManifest()
  ;[manifest.packages[0], manifest.packages[1]] = [manifest.packages[1], manifest.packages[0]]

  assert.throws(
    () => validateReleaseManifest(manifest, context),
    /packages must follow packageOrder/u,
  )
})

test("validateReleaseManifest rejects unknown fields", () => {
  const manifest = validManifest()
  manifest.unexpected = true

  assert.throws(() => validateReleaseManifest(manifest, context), /unknown field unexpected/u)
})

test("canonicalManifestBytes recursively sorts keys, preserves arrays, and ends in one newline", () => {
  const bytes = canonicalManifestBytes({
    z: { second: 2, first: 1 },
    packages: [
      { z: 3, a: 1 },
      { b: 2, a: 1 },
    ],
    a: true,
  })

  assert.ok(Buffer.isBuffer(bytes))
  assert.equal(
    bytes.toString("utf8"),
    `${JSON.stringify(
      {
        a: true,
        packages: [
          { a: 1, z: 3 },
          { a: 1, b: 2 },
        ],
        z: { first: 1, second: 2 },
      },
      null,
      2,
    )}\n`,
  )
})

test("manifestSha256 hashes the canonical manifest bytes", () => {
  const manifest = validManifest()
  const expected = createHash("sha256").update(canonicalManifestBytes(manifest)).digest("hex")

  assert.equal(manifestSha256(manifest), expected)
  assert.match(manifestSha256(manifest), /^[0-9a-f]{64}$/u)
})

function validManifest() {
  return {
    schemaVersion: RELEASE_MANIFEST_SCHEMA_VERSION,
    version: VERSION,
    commitSha: COMMIT_SHA,
    ci: {
      workflow: "CI",
      runId: 123456789,
      runAttempt: 1,
    },
    artifact: {
      name: `release-v${VERSION}-${COMMIT_SHA.slice(0, 12)}`,
      prepareRunId: 123456790,
      prepareRunAttempt: 1,
    },
    packageOrder: ["base", "middle", "create-dawn-ai-app"],
    packages: [
      packageEntry("base", "ab"),
      packageEntry("middle", "cd"),
      packageEntry("create-dawn-ai-app", "ef"),
    ],
  }
}

function packageEntry(name, byte) {
  const sha512 = byte.repeat(64)
  return {
    name,
    version: VERSION,
    filename: `${name}-${VERSION}.tgz`,
    size: 100,
    sha256: byte.repeat(32),
    sha512,
    npmIntegrity: `sha512-${Buffer.from(sha512, "hex").toString("base64")}`,
    access: "public",
  }
}

function assertRecursivelyFrozen(value) {
  if (value === null || typeof value !== "object") {
    return
  }
  assert.equal(Object.isFrozen(value), true)
  for (const child of Object.values(value)) {
    assertRecursivelyFrozen(child)
  }
}
