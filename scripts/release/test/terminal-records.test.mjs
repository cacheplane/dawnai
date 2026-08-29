import assert from "node:assert/strict"
import test from "node:test"

import { parseAbandonmentRecord } from "../terminal-records.mjs"

const VERSION = "0.8.21"
const SHA = "3".repeat(40)
const PACKAGE_NAMES = Array.from({ length: 21 }, (_, index) =>
  index === 20 ? "create-dawn-ai-app" : `@dawn-ai/package-${String(index).padStart(2, "0")}`,
)
const OPTIONS = Object.freeze({
  candidate: Object.freeze({ version: VERSION, commitSha: SHA }),
  environment: "release-abandonment",
  packageNames: PACKAGE_NAMES,
})

test("parseAbandonmentRecord accepts and freezes complete canonical evidence", () => {
  const result = parseAbandonmentRecord(abandonmentRecord(), OPTIONS)

  assert.equal(result.tag, `v${VERSION}`)
  assert.equal(result.observations.length, 2)
  assert.ok(Object.isFrozen(result))
  assert.ok(Object.isFrozen(result.observations[0].packages))
})

test("parseAbandonmentRecord rejects incomplete or noncanonical protected evidence", () => {
  const cases = [
    (value) => (value.extra = true),
    (value) => (value.approval.environment = "other"),
    (value) => (value.approval.state = "rejected"),
    (value) => (value.approval.reviewer = value.actor),
    (value) => (value.approval.reviewerId = value.actorId),
    (value) => (value.actionsHistory.registryMutationStarted = true),
    (value) => value.observations.pop(),
    (value) => (value.observations[1].workflowRunId += 1),
    (value) => (value.actionsHistory.workflowRunId += 1),
    (value) => (value.approval.workflowRunId += 1),
    (value) => (value.observations[1].runAttempt = 0),
    (value) => (value.observations[1].observedAt = value.observations[0].observedAt),
    (value) => (value.observations[1].observedAt = "2026-08-24T12:01:01Z"),
    (value) => {
      value.observations[0].observedAt = "2026-08-24T12:00:01Z"
      value.observations[1].observedAt = "2026-08-24T12:01:01Z"
    },
    (value) => (value.approval.approvedAt = "2026-08-24T11:53:00Z"),
    (value) => value.observations[1].packages.pop(),
    (value) => (value.observations[1].packages[0].name = value.observations[1].packages[1].name),
    (value) => (value.observations[1].packages[0].status = "PRESENT"),
    (value) => (value.observations[1].packages[0].code = "HTTP_404"),
  ]

  for (const mutate of cases) {
    const value = abandonmentRecord()
    mutate(value)
    assert.throws(() => parseAbandonmentRecord(value, OPTIONS), /abandonment/u)
  }
})

test("parseAbandonmentRecord snapshots without invoking accessors", () => {
  const value = abandonmentRecord()
  let reads = 0
  Object.defineProperty(value.approval, "reviewer", {
    enumerable: true,
    get() {
      reads += 1
      return "release-reviewer"
    },
  })

  assert.throws(() => parseAbandonmentRecord(value, OPTIONS), /abandonment/u)
  assert.equal(reads, 0)
})

function abandonmentRecord() {
  const observation = (workflowRunId, observedAt) => ({
    workflowRunId,
    runAttempt: 1,
    observedAt,
    packages: PACKAGE_NAMES.map((name) => ({
      name,
      version: VERSION,
      status: "ABSENT",
      httpStatus: 404,
      code: "E404",
    })),
  })
  return {
    schemaVersion: 1,
    version: VERSION,
    commitSha: SHA,
    tag: `v${VERSION}`,
    predecessor: {
      state: "CANDIDATE_TAGGED",
      releaseStatus: "absent",
      releaseId: null,
      bodySha256: null,
      marker: null,
      artifact: {
        manifestSha256: null,
        releaseRecordSha256: null,
        baseAssetSetSha256: null,
        attestationSet: null,
      },
    },
    reason: "Candidate preparation is deterministically defective",
    actor: "release-operator",
    actorId: 200,
    recordedAt: "2026-08-24T12:04:00Z",
    approval: {
      environment: "release-abandonment",
      environmentId: 200,
      reviewerId: 201,
      reviewer: "release-reviewer",
      state: "approved",
      observedAt: "2026-08-24T11:59:00Z",
      workflowRunId: 300,
      runAttempt: 1,
    },
    actionsHistory: {
      workflowRunId: 300,
      runAttempt: 1,
      observedAt: "2026-08-24T12:03:30Z",
      publishJobStarted: false,
      registryMutationStarted: false,
    },
    observations: [
      observation(300, "2026-08-24T12:01:00Z"),
      observation(300, "2026-08-24T12:03:00Z"),
    ],
  }
}
