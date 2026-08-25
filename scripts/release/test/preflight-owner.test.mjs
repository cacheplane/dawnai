import assert from "node:assert/strict"
import test from "node:test"

import { CANONICAL_RELEASE_PACKAGE_ORDER } from "../manifest.mjs"
import {
  canonicalOwnerEvidenceBytes,
  captureOwnerEvidence,
  OWNER_PREFLIGHT_FILES,
  parseOwnerEvidence,
  verifyOwnerEvidence,
} from "../preflight-owner.mjs"

const REPOSITORY = "cacheplane/dawnai"
const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567"
const NOW = Date.parse("2026-08-25T12:00:00Z")
const WORKFLOW = "release.yml"

test("capture uses only the named owner adapters and binds all local inputs", async () => {
  const fixture = captureFixture({ phase: "pre-enable" })
  const evidence = await captureOwnerEvidence(fixture.input)

  assert.deepEqual(
    fixture.calls.filter(([kind]) => kind === "npm"),
    CANONICAL_RELEASE_PACKAGE_ORDER.flatMap((name) => [["npm", "trust-list", name]]),
  )
  assert.deepEqual(
    fixture.calls.filter(([kind]) => kind === "github").map((call) => call.slice(1)),
    [
      ["repository", REPOSITORY],
      ...OWNER_PREFLIGHT_FILES.filter((path) => path.endsWith(".yml")).map((path) => [
        "workflow",
        path,
      ]),
      ["environment", "release-abandonment"],
      ["immutable-releases", REPOSITORY],
    ],
  )
  assert.deepEqual(
    evidence.files.map(({ path }) => path),
    OWNER_PREFLIGHT_FILES,
  )
  assert.equal(evidence.packages.length, 21)
  assert.equal(evidence.headSha, HEAD_SHA)
  assert.equal(evidence.expiresAt, "2026-08-25T12:15:00.000Z")
  assert.equal(JSON.stringify(evidence).includes("secret"), false)
  assertFrozen(evidence)
  assert.deepEqual(parseOwnerEvidence(canonicalOwnerEvidenceBytes(evidence)), evidence)
})

test("pre-enable accepts disabled legacy mutators without requiring immutable Releases yet", async () => {
  const fixture = captureFixture({ phase: "pre-enable", immutableEnabled: false })
  const evidence = await captureOwnerEvidence(fixture.input)
  const report = verifyOwnerEvidence({
    evidence,
    currentHeadSha: HEAD_SHA,
    currentFiles: fixture.files,
    now: () => NOW + 60_000,
  })

  assert.equal(report.status, "PASS")
  assert.equal(check(report, "workflow-states").status, "PASS")
  assert.equal(check(report, "immutable-releases").status, "PASS")
  assert.equal(check(report, "npm-trusted-publishers").status, "PASS")
})

test("post-enable requires every workflow active and immutable Releases enabled", async () => {
  const fixture = captureFixture({ phase: "post-enable", immutableEnabled: true })
  const evidence = await captureOwnerEvidence(fixture.input)
  const report = verifyOwnerEvidence({
    evidence,
    currentHeadSha: HEAD_SHA,
    currentFiles: fixture.files,
    now: () => NOW + 60_000,
  })

  assert.equal(report.status, "PASS")

  for (const mutate of [
    (value) =>
      (value.github.immutableReleases = {
        operation: `GET /repos/${REPOSITORY}/immutable-releases`,
        status: "absent",
        httpStatus: 404,
        enabled: false,
        enforcedByOwner: null,
      }),
    (value) => (value.github.workflows[0].state = "disabled_manually"),
  ]) {
    const changed = structuredClone(evidence)
    mutate(changed)
    assert.equal(
      verifyOwnerEvidence({
        evidence: changed,
        currentHeadSha: HEAD_SHA,
        currentFiles: fixture.files,
        now: () => NOW + 60_000,
      }).status,
      "FAIL",
    )
  }
})

test("verification rejects stale, future, changed-head, and changed-file evidence", async () => {
  const fixture = captureFixture({ phase: "pre-enable" })
  const evidence = await captureOwnerEvidence(fixture.input)
  const cases = [
    {
      name: "expired",
      now: NOW + 15 * 60_000 + 1,
      head: HEAD_SHA,
      files: fixture.files,
      status: "UNPROVABLE",
    },
    {
      name: "future",
      now: NOW - 1,
      head: HEAD_SHA,
      files: fixture.files,
      status: "FAIL",
    },
    {
      name: "head",
      now: NOW + 1,
      head: "f".repeat(40),
      files: fixture.files,
      status: "FAIL",
    },
    {
      name: "file",
      now: NOW + 1,
      head: HEAD_SHA,
      files: new Map(fixture.files).set(OWNER_PREFLIGHT_FILES[0], Buffer.from("changed")),
      status: "FAIL",
    },
  ]
  for (const item of cases) {
    const report = verifyOwnerEvidence({
      evidence,
      currentHeadSha: item.head,
      currentFiles: item.files,
      now: () => item.now,
    })
    assert.equal(report.status, item.status, item.name)
  }
})

test("missing, duplicate, extra, and descriptor-unsafe evidence is rejected", async () => {
  const fixture = captureFixture({ phase: "pre-enable" })
  const evidence = await captureOwnerEvidence(fixture.input)
  for (const mutate of [
    (value) => value.packages.pop(),
    (value) => value.packages.push(structuredClone(value.packages[0])),
    (value) => (value.extra = true),
  ]) {
    const changed = structuredClone(evidence)
    mutate(changed)
    assert.throws(
      () => parseOwnerEvidence(Buffer.from(`${JSON.stringify(changed)}\n`)),
      /evidence/u,
    )
  }
  const accessor = structuredClone(evidence)
  Object.defineProperty(accessor, "repository", {
    enumerable: true,
    get() {
      assert.fail("owner evidence accessors must not execute")
    },
  })
  assert.throws(
    () =>
      verifyOwnerEvidence({
        evidence: accessor,
        currentHeadSha: HEAD_SHA,
        currentFiles: fixture.files,
      }),
    /evidence/u,
  )
})

test("mixed publisher tuples fail and unavailable owner reads remain unprovable", async () => {
  const fixture = captureFixture({ phase: "pre-enable" })
  const evidence = await captureOwnerEvidence(fixture.input)
  const mixed = structuredClone(evidence)
  mixed.packages[5].publisher.environment = "production"
  assert.equal(
    verifyOwnerEvidence({
      evidence: mixed,
      currentHeadSha: HEAD_SHA,
      currentFiles: fixture.files,
      now: () => NOW + 1,
    }).status,
    "FAIL",
  )

  const unavailable = structuredClone(evidence)
  unavailable.packages[5] = {
    name: unavailable.packages[5].name,
    operation: `npm trust list ${unavailable.packages[5].name} --json`,
    status: "unavailable",
    code: "E401",
    publisher: null,
  }
  assert.equal(
    verifyOwnerEvidence({
      evidence: unavailable,
      currentHeadSha: HEAD_SHA,
      currentFiles: fixture.files,
      now: () => NOW + 1,
    }).status,
    "UNPROVABLE",
  )

  const githubUnavailable = structuredClone(evidence)
  githubUnavailable.github.workflows[0] = {
    operation: `GET /repos/{owner}/{repo}/actions/workflows/${OWNER_PREFLIGHT_FILES[0]}`,
    status: "unavailable",
    httpStatus: null,
    path: OWNER_PREFLIGHT_FILES[0],
    id: null,
    state: "unavailable",
  }
  githubUnavailable.github.immutableReleases = {
    operation: `GET /repos/${REPOSITORY}/immutable-releases`,
    status: "unavailable",
    httpStatus: null,
    enabled: null,
    enforcedByOwner: null,
  }
  assert.equal(
    verifyOwnerEvidence({
      evidence: githubUnavailable,
      currentHeadSha: HEAD_SHA,
      currentFiles: fixture.files,
      now: () => NOW + 1,
    }).status,
    "UNPROVABLE",
  )
})

test("repository administration and protected abandonment approval are strict gates", async () => {
  const fixture = captureFixture({ phase: "post-enable", immutableEnabled: true })
  const evidence = await captureOwnerEvidence(fixture.input)
  for (const mutate of [
    (value) => (value.github.repository.administration = false),
    (value) => (value.github.abandonmentEnvironment.protectionRules = []),
    (value) => (value.github.abandonmentEnvironment.protectionRules[0].preventSelfReview = false),
  ]) {
    const changed = structuredClone(evidence)
    mutate(changed)
    assert.equal(
      verifyOwnerEvidence({
        evidence: changed,
        currentHeadSha: HEAD_SHA,
        currentFiles: fixture.files,
        now: () => NOW + 1,
      }).status,
      "FAIL",
    )
  }
})

function captureFixture({ phase, immutableEnabled = phase === "post-enable" }) {
  const calls = []
  const files = new Map(
    OWNER_PREFLIGHT_FILES.map((path, index) => [path, Buffer.from(`fixture-${index}\n`)]),
  )
  files.set(
    "scripts/release/controller-schema.json",
    Buffer.from(
      `${JSON.stringify({
        schemaVersion: 1,
        publishingOwner: "release-controller",
        epoch: "fixed-group-v1",
        npmTrustedPublisherEnvironment: null,
        abandonmentEnvironment: "release-abandonment",
      })}\n`,
    ),
  )
  const input = {
    phase,
    repository: REPOSITORY,
    packageNames: CANONICAL_RELEASE_PACKAGE_ORDER,
    files: {
      async read(path) {
        calls.push(["file", "read", path])
        return files.get(path)
      },
    },
    git: {
      async headSha() {
        calls.push(["git", "head"])
        return HEAD_SHA
      },
    },
    npm: {
      async version() {
        calls.push(["npm-version"])
        return "11.17.0"
      },
      async trustList(name) {
        calls.push(["npm", "trust-list", name])
        return {
          status: "present",
          value: {
            id: `trust-${name}`,
            type: "github",
            file: WORKFLOW,
            repository: REPOSITORY,
            permissions: ["createPackage"],
          },
        }
      },
    },
    github: {
      async version() {
        calls.push(["gh-version"])
        return "2.95.0"
      },
      async getRepository(repository) {
        calls.push(["github", "repository", repository])
        return {
          status: "present",
          httpStatus: 200,
          value: {
            id: 123,
            full_name: REPOSITORY,
            default_branch: "main",
            permissions: { admin: true },
          },
        }
      },
      async getWorkflow(path) {
        calls.push(["github", "workflow", path])
        const legacyDisabled = [
          ".github/workflows/release.yml",
          ".github/workflows/publish-chart.yml",
        ].includes(path)
        return {
          status: "present",
          httpStatus: 200,
          value: {
            id: 500 + calls.length,
            path,
            state: phase === "pre-enable" && legacyDisabled ? "disabled_manually" : "active",
          },
        }
      },
      async getEnvironment(name) {
        calls.push(["github", "environment", name])
        return {
          status: "present",
          httpStatus: 200,
          value: {
            name,
            protection_rules: [
              {
                type: "required_reviewers",
                prevent_self_review: true,
                reviewers: [{ type: "Team", reviewer: { slug: "release-owners" } }],
              },
            ],
          },
        }
      },
      async getImmutableReleases(repository) {
        calls.push(["github", "immutable-releases", repository])
        return {
          status: "present",
          httpStatus: 200,
          value: { enabled: immutableEnabled, enforced_by_owner: false },
        }
      },
    },
    now: () => NOW,
  }
  return { calls, files, input }
}

function check(report, id) {
  return report.checks.find((item) => item.id === id)
}

function assertFrozen(value) {
  if (value !== null && typeof value === "object") {
    assert.equal(Object.isFrozen(value), true)
    for (const child of Object.values(value)) assertFrozen(child)
  }
}
