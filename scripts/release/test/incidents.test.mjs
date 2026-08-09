import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import {
  assessHistoricalFacts,
  createReconciliationReport,
  parseReconciliationFixture,
  reconcileFixture,
  renderReportJson,
  renderReportMarkdown,
} from "../report.mjs"

const FIXTURE_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/incidents")
const INCIDENTS = ["0.8.20-skipped", "0.8.21-publish-metadata-failure", "main-2026-08-09"]

test("historical incident fixtures are versioned, exact, immutable JSON", async () => {
  for (const name of INCIDENTS) {
    const source = await readFile(path.join(FIXTURE_ROOT, `${name}.json`), "utf8")
    const fixture = parseReconciliationFixture(source, name)
    const before = JSON.stringify(fixture)

    assert.equal(fixture.schemaVersion, 1)
    assert.equal(fixture.incidentId, name)
    assert.deepEqual(JSON.parse(JSON.stringify(fixture)), fixture)
    assertRecursivelyFrozen(fixture)
    assert.equal(JSON.stringify(fixture), before)
    assert.doesNotMatch(source, /authorization|bearer|github_token|npm_token|password|secret/iu)
  }
})

test("0.8.20 is retained as uncorrelated skipped history without mutations", async () => {
  const fixture = await load("0.8.20-skipped")
  assert.equal(fixture.kind, "historical-facts")
  assert.equal(fixture.candidate.version, "0.8.20")
  assert.equal(fixture.candidate.commitSha, "5bb97cf3434e7c4afa95646982d510d79387ba5b")

  const result = reconcileFixture(fixture, {
    planRelease() {
      assert.fail("historical facts must never enter the managed planner")
    },
  })

  assert.equal(result.reportKind, "historical-audit")
  assert.deepEqual(result.historicalAssessment, fixture.expected)
  assert.equal(result.historicalAssessment.disposition, "audit-only")
  assert.equal(
    result.historicalAssessment.lastProvenTransition,
    "LEGACY_CANDIDATE_SUPERSEDED_UNCORRELATED",
  )
  assert.deepEqual(result.historicalAssessment.proposedMutations, [])
  assert.equal(Object.hasOwn(result, "plan"), false)
})

test("0.8.21 proves only uncorrelated public npm completion", async () => {
  const fixture = await load("0.8.21-publish-metadata-failure")
  let plannerCalls = 0
  const report = reconcileFixture(fixture, {
    planRelease() {
      plannerCalls += 1
      assert.fail("0.8.21 pre-controller facts cannot be a managed observation")
    },
  })

  assert.equal(plannerCalls, 0)
  assert.equal(fixture.candidate.version, "0.8.21")
  assert.equal(fixture.candidate.commitSha, "341678ea7932832ec860bdd915371669440bef7c")
  assert.equal(fixture.run.workflowRunId, 31292769511)
  assert.equal(fixture.run.runAttempt, 1)
  assert.equal(fixture.facts.npmPackages.length, 21)
  assert.ok(fixture.facts.npmPackages.every((pkg) => pkg.status === "PRESENT"))
  assert.equal(report.reportKind, "historical-audit")
  assert.equal(report.historicalFacts.npmPackages.length, 21)
  assert.equal(
    report.historicalAssessment.lastProvenTransition,
    "LEGACY_NPM_REGISTRY_COMPLETE_UNCORRELATED",
  )
  assert.deepEqual(report.historicalAssessment, fixture.expected)
  assert.deepEqual(report.historicalAssessment.proposedMutations, [])
  assert.equal(Object.hasOwn(report, "plan"), false)
})

test("historical completion fails closed on missing or ambiguous npm facts", async () => {
  const fixture = structuredClone(await load("0.8.21-publish-metadata-failure"))
  fixture.facts.npmPackages[0].status = "AMBIGUOUS"
  fixture.facts.npmPackages[0].code = "RATE_LIMITED"
  fixture.facts.npmPackages[0].version = null
  fixture.facts.npmPackages[0].shasum = null
  fixture.facts.npmPackages[0].integrity = null
  fixture.facts.npmPackages[0].signatureCount = null
  fixture.facts.npmPackages[0].provenanceStatus = null
  fixture.facts.npmPackages[0].provenanceWorkflow = null
  fixture.facts.npmPackages[0].provenanceCommitSha = null

  const assessment = assessHistoricalFacts(fixture)

  assert.equal(assessment.lastProvenTransition, "LEGACY_NPM_REGISTRY_INCOMPLETE")
  assert.equal(assessment.disposition, "audit-only")
  assert.ok(assessment.conflicts.includes("historical-npm-package-ambiguous"))
  assert.deepEqual(assessment.proposedMutations, [])
})

test("historical completion fails closed when one expected package fact is missing", async () => {
  const fixture = structuredClone(await load("0.8.21-publish-metadata-failure"))
  fixture.facts.npmPackages.shift()

  const assessment = assessHistoricalFacts(fixture)

  assert.equal(assessment.lastProvenTransition, "LEGACY_NPM_REGISTRY_INCOMPLETE")
  assert.ok(assessment.conflicts.includes("historical-npm-package-set-mismatch"))
  assert.deepEqual(assessment.proposedMutations, [])
})

test("exact historical package presence survives incomplete nested public facts", async () => {
  const cases = [
    {
      name: "latest missing",
      mutate(pkg) {
        pkg.latest = null
      },
      conflict: "historical-npm-latest-incomplete",
    },
    {
      name: "latest mismatch",
      mutate(pkg) {
        pkg.latest = "0.8.20"
      },
      conflict: "historical-npm-latest-incomplete",
    },
    {
      name: "signature unavailable",
      mutate(pkg) {
        pkg.signatureCount = null
      },
      conflict: "historical-npm-signature-unverified",
    },
    ...["ABSENT", "AMBIGUOUS", "ERROR"].map((status) => ({
      name: `provenance ${status.toLowerCase()}`,
      mutate(pkg) {
        pkg.provenanceStatus = status
        pkg.provenanceWorkflow = null
        pkg.provenanceCommitSha = null
      },
      conflict: "historical-npm-provenance-incomplete",
    })),
  ]

  for (const item of cases) {
    const fixture = structuredClone(await load("0.8.21-publish-metadata-failure"))
    item.mutate(fixture.facts.npmPackages[0])
    const assessment = assessHistoricalFacts(fixture)

    assert.equal(assessment.lastProvenTransition, "LEGACY_NPM_REGISTRY_INCOMPLETE", item.name)
    assert.ok(assessment.conflicts.includes(item.conflict), item.name)
    assert.deepEqual(assessment.proposedMutations, [], item.name)
  }
})

test("post-incident main uses the managed no-candidate planner path", async () => {
  const fixture = await load("main-2026-08-09")
  let plannerInput
  const report = reconcileFixture(fixture, {
    planRelease(input) {
      plannerInput = input
      return structuredClone(fixture.expected.plan)
    },
  })

  assert.deepEqual(plannerInput, { candidate: null, observation: {}, mode: "shadow" })
  assert.equal(fixture.source.selectedRef, "main")
  assert.equal(fixture.source.resolvedCommitSha, "d159eb6d49fc8accd9f53139634b10930a4fd093")
  assert.equal(report.reportKind, "managed-plan")
  assert.deepEqual(report.plan, fixture.expected.plan)
  assert.equal(report.lastProvenTransition, "NO_CANDIDATE")
  assert.equal(report.nextSafeTransition, null)
  assert.deepEqual(report.plan.proposedMutations, [])
  assert.equal(Object.hasOwn(report, "historicalAssessment"), false)
})

test("reports render byte-stable canonical JSON and prominent deterministic Markdown", async () => {
  for (const name of INCIDENTS) {
    const fixture = await load(name)
    const report = reconcileFixture(fixture)
    const before = JSON.stringify(fixture)
    const firstJson = renderReportJson(report)
    const secondJson = renderReportJson(report)
    const firstMarkdown = renderReportMarkdown(report)
    const secondMarkdown = renderReportMarkdown(report)

    assert.equal(firstJson, secondJson)
    assert.equal(firstMarkdown, secondMarkdown)
    assert.ok(firstJson.endsWith("\n"))
    assert.match(firstMarkdown, /^# Release Reconciliation Report\n/u)
    assert.match(firstMarkdown, /## Analysis boundary\n/u)
    assert.match(firstMarkdown, /## Candidate\n/u)
    assert.match(firstMarkdown, /- Requested ref:/u)
    assert.match(firstMarkdown, /- Selected ref:/u)
    assert.match(firstMarkdown, /- Resolved commit SHA:/u)
    assert.match(firstMarkdown, /## Evidence assessment\n/u)
    assert.match(firstMarkdown, /## Public npm facts\n/u)
    assert.match(firstMarkdown, /## Manual recovery\n/u)
    assert.doesNotMatch(
      `${firstJson}\n${firstMarkdown}`,
      /authorization|bearer|token|password|secret/iu,
    )
    assert.equal(JSON.stringify(fixture), before)
  }
})

test("historical facts reject array accessors without invoking them", async () => {
  const fixture = structuredClone(await load("0.8.21-publish-metadata-failure"))
  const firstPackage = fixture.facts.npmPackages[0]
  let reads = 0
  Object.defineProperty(fixture.facts.npmPackages, 0, {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1
      return firstPackage
    },
  })

  assert.throws(() => assessHistoricalFacts(fixture), /data properties/u)
  assert.equal(reads, 0)
})

test("fixture reconciliation snapshots own data before any field reads", async () => {
  const fixture = structuredClone(await load("main-2026-08-09"))
  const observation = fixture.observation
  let reads = 0
  Object.defineProperty(fixture, "observation", {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1
      return observation
    },
  })

  assert.throws(() => reconcileFixture(fixture, { planRelease: assert.fail }), /data properties/u)
  assert.equal(reads, 0)
})

test("Markdown escapes untrusted reason text", async () => {
  const fixture = structuredClone(await load("0.8.20-skipped"))
  fixture.expected.reasons = ["unsafe [label](javascript:alert(1)) <tag>"]
  const report = createReconciliationReport({
    historicalFacts: fixture,
    historicalAssessment: fixture.expected,
    run: fixture.run,
  })

  const markdown = renderReportMarkdown(report)

  assert.doesNotMatch(markdown, /<tag>|\]\(javascript:/u)
  assert.match(markdown, /&lt;tag&gt;/u)
  assert.match(markdown, /\\\[label\\\]/u)
})

test("renderers redact secret-like values even when report callers bypass fixtures", async () => {
  const fixture = structuredClone(await load("0.8.20-skipped"))
  fixture.expected.reasons = ["remote diagnostic Bearer ghp_123456789abcdef"]
  const report = createReconciliationReport({
    historicalFacts: fixture,
    historicalAssessment: fixture.expected,
    run: fixture.run,
  })

  for (const rendered of [renderReportJson(report), renderReportMarkdown(report)]) {
    assert.doesNotMatch(rendered, /ghp_123456789abcdef|Bearer/iu)
    assert.match(rendered, /\\?\[REDACTED\\?\]/u)
  }
})

test("fixture parsing rejects unknown fields, secret-like keys, and malformed history", async () => {
  const fixture = structuredClone(await load("0.8.21-publish-metadata-failure"))
  fixture.unexpected = true
  assert.throws(() => parseReconciliationFixture(JSON.stringify(fixture), "bad"), /unknown field/u)

  delete fixture.unexpected
  fixture.source.Authorization = "Bearer do-not-print"
  assert.throws(
    () => parseReconciliationFixture(JSON.stringify(fixture), "secret"),
    /secret-like key/u,
  )

  delete fixture.source.Authorization
  fixture.facts.npmPackages[0].status = "PRESENT"
  fixture.facts.npmPackages[0].integrity = null
  assert.throws(
    () => parseReconciliationFixture(JSON.stringify(fixture), "bad package"),
    /npm package/u,
  )
})

async function load(name) {
  return parseReconciliationFixture(
    await readFile(path.join(FIXTURE_ROOT, `${name}.json`), "utf8"),
    name,
  )
}

function assertRecursivelyFrozen(value) {
  if (value === null || typeof value !== "object") return
  assert.equal(Object.isFrozen(value), true)
  for (const child of Object.values(value)) assertRecursivelyFrozen(child)
}
