import { assessValidatedHistoricalFacts } from "./historical-audit.mjs"
import { planRelease as defaultPlanRelease } from "./planner.mjs"
import { isExactSemver, parseSemver } from "./semver.mjs"

export { renderReportJson, renderReportMarkdown } from "./report-render.mjs"

const FIXTURE_FIELDS = Object.freeze({
  "managed-observation": [
    "schemaVersion",
    "kind",
    "incidentId",
    "candidate",
    "observation",
    "run",
    "source",
    "expected",
  ],
  "historical-facts": [
    "schemaVersion",
    "kind",
    "incidentId",
    "candidate",
    "run",
    "source",
    "facts",
    "expected",
  ],
})
const CANDIDATE_FIELDS = Object.freeze([
  "ciCheck",
  "ciWorkflow",
  "publisherWorkflow",
  "version",
  "commitSha",
])
const RUN_FIELDS = Object.freeze(["workflow", "workflowRunId", "runAttempt"])
const SOURCE_FIELDS = Object.freeze([
  "repository",
  "requestedRef",
  "selectedRef",
  "resolvedCommitSha",
  "observedAt",
  "evidence",
])
const FACT_FIELDS = Object.freeze(["packageNames", "npmPackages", "controllerEvidence"])
const CONTROLLER_EVIDENCE_FIELDS = Object.freeze([
  "artifactAttestations",
  "escrow",
  "manifest",
  "releaseRecord",
])
const NPM_FACT_FIELDS = Object.freeze([
  "name",
  "status",
  "code",
  "version",
  "shasum",
  "integrity",
  "latest",
  "signatureCount",
  "provenanceStatus",
  "provenanceWorkflow",
  "provenanceCommitSha",
])
const HISTORICAL_ASSESSMENT_FIELDS = Object.freeze([
  "analysisKind",
  "disposition",
  "lastProvenTransition",
  "nextSafeTransition",
  "reasons",
  "conflicts",
  "manualRecoveryInputs",
  "proposedMutations",
])
const MANAGED_EXPECTED_FIELDS = Object.freeze([
  "plan",
  "lastProvenTransition",
  "nextSafeTransition",
  "manualRecoveryInputs",
])
const MANUAL_INPUT_FIELDS = Object.freeze([
  "version",
  "commitSha",
  "tag",
  "workflowRunId",
  "runAttempt",
])
const SHA_PATTERN = /^[0-9a-f]{40}$/u
const SHA1_PATTERN = /^[0-9a-f]{40}$/u
const INTEGRITY_PATTERN = /^sha512-[A-Za-z0-9+/]+={0,2}$/u
const PACKAGE_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u
const REPOSITORY_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u
const SECRET_KEY_PATTERN =
  /(?:authorization|cookie|password|secret|token|private.?key|^gh[pousr]_|^github_pat_|^npm_)/iu
const MAX_FIXTURE_BYTES = 4 * 1024 * 1024
const MAX_TEXT_BYTES = 4_096

export function parseReconciliationFixture(source, context = "fixture") {
  if (typeof source !== "string" || Buffer.byteLength(source, "utf8") > MAX_FIXTURE_BYTES) {
    throw new TypeError(`${context}: fixture must be bounded UTF-8 JSON text`)
  }
  let value
  try {
    value = JSON.parse(source)
  } catch {
    throw new TypeError(`${context}: fixture is not valid JSON`)
  }
  assertSafeJson(value, context, new Set())
  assertNoSecretKeys(value, context)
  if (!isRecord(value)) throw new TypeError(`${context}: fixture must be an object`)
  if (value.schemaVersion !== 1) throw new TypeError(`${context}: unsupported schemaVersion`)
  if (!Object.hasOwn(FIXTURE_FIELDS, value.kind)) {
    throw new TypeError(`${context}: unknown fixture kind`)
  }
  assertExactFields(value, FIXTURE_FIELDS[value.kind], `${context} fixture`)
  assertBoundedText(value.incidentId, `${context}.incidentId`)
  assertRun(value.run, `${context}.run`, value.kind === "managed-observation")
  assertSource(value.source, `${context}.source`)
  if (value.kind === "managed-observation") {
    assertCandidate(value.candidate, `${context}.candidate`, true)
    if (!isRecord(value.observation))
      throw new TypeError(`${context}: observation must be an object`)
    assertExactFields(value.expected, MANAGED_EXPECTED_FIELDS, `${context}.expected`)
    assertPlan(value.expected.plan, `${context}.expected.plan`)
  } else {
    value.facts.packageNames.sort(compareText)
    value.facts.npmPackages.sort((left, right) => compareText(left.name, right.name))
    assertCandidate(value.candidate, `${context}.candidate`, false)
    assertHistoricalFacts(value, context)
    assertHistoricalAssessment(value.expected, `${context}.expected`)
  }
  return deepFreeze(structuredClone(value))
}

// Historical facts intentionally never enter planRelease. They describe only evidence that
// existed before the managed manifest/escrow topology and therefore can authorize no effects.
export function assessHistoricalFacts(input) {
  const fixture = snapshotHistoricalFixture(input)
  return assessValidatedHistoricalFacts(fixture)
}

export function reconcileFixture(fixtureInput, { planRelease = defaultPlanRelease } = {}) {
  let fixture
  if (typeof fixtureInput === "string") {
    fixture = parseReconciliationFixture(fixtureInput)
  } else {
    assertSafeJson(fixtureInput, "fixture", new Set())
    assertNoSecretKeys(fixtureInput, "fixture")
    fixture = parseReconciliationFixture(JSON.stringify(fixtureInput))
  }
  if (fixture.kind === "historical-facts") {
    const historicalAssessment = assessHistoricalFacts(fixture)
    return createReconciliationReport({
      historicalFacts: fixture,
      historicalAssessment,
      run: fixture.run,
      source: fixture.source,
    })
  }
  if (typeof planRelease !== "function") throw new TypeError("planRelease must be a function")
  const plan = planRelease({
    candidate: fixture.candidate,
    observation: fixture.observation,
    mode: "shadow",
  })
  return createReconciliationReport({
    candidate: fixture.candidate,
    observation: fixture.observation,
    plan,
    run: fixture.run,
    source: fixture.source,
  })
}

export function createReconciliationReport({
  candidate,
  observation,
  plan,
  run,
  source = null,
  historicalFacts,
  historicalAssessment: assessmentInput,
}) {
  if (historicalFacts !== undefined) {
    const facts = snapshotHistoricalFixture(historicalFacts)
    const assessment = assessHistoricalFacts(facts)
    if (!sameJson(facts.expected, assessment)) {
      throw new TypeError("Historical assessment does not correlate with validated facts")
    }
    if (
      assessmentInput !== undefined &&
      !sameJson(snapshotHistoricalAssessment(assessmentInput), assessment)
    ) {
      throw new TypeError("Historical assessment does not correlate with validated facts")
    }
    if (candidate !== undefined && !sameJson(candidate, facts.candidate)) {
      throw new TypeError("Historical candidate does not correlate with validated facts")
    }
    if (run !== undefined && !sameJson(run, facts.run)) {
      throw new TypeError("Historical run does not correlate with validated facts")
    }
    if (source !== null && source !== undefined && !sameJson(source, facts.source)) {
      throw new TypeError("Historical source does not correlate with validated facts")
    }
    return deepFreeze({
      schemaVersion: 1,
      reportKind: "historical-audit",
      candidate: structuredClone(facts.candidate),
      run: structuredClone(facts.run),
      source: structuredClone(facts.source),
      historicalFacts: structuredClone(facts.facts),
      lastProvenTransition: assessment.lastProvenTransition,
      nextSafeTransition: assessment.nextSafeTransition,
      conflicts: structuredClone(assessment.conflicts),
      reasons: structuredClone(assessment.reasons),
      manualRecoveryInputs: structuredClone(assessment.manualRecoveryInputs),
      historicalAssessment: assessment,
    })
  }

  assertCandidate(candidate, "report.candidate", true)
  if (!isRecord(observation)) throw new TypeError("report.observation must be an object")
  assertPlan(plan, "report.plan")
  assertRun(run, "report.run", true)
  if (source !== null) assertSource(source, "report.source")
  const recovery =
    candidate !== null && plan.disposition === "blocked" && run.workflow !== null
      ? manualInputs(candidate, run)
      : null
  return deepFreeze({
    schemaVersion: 1,
    reportKind: "managed-plan",
    candidate: structuredClone(candidate),
    run: structuredClone(run),
    source: source === null ? null : structuredClone(source),
    lastProvenTransition: plan.state,
    nextSafeTransition: plan.nextTransition,
    conflicts: [...plan.conflicts].sort(compareText),
    reasons: [...plan.reasons],
    manualRecoveryInputs: recovery,
    observation: structuredClone(observation),
    plan: structuredClone(plan),
  })
}

function snapshotHistoricalFixture(value) {
  assertSafeJson(value, "historical facts", new Set())
  assertNoSecretKeys(value, "historical facts")
  return parseReconciliationFixture(JSON.stringify(value), "historical facts")
}

function snapshotHistoricalAssessment(value) {
  assertHistoricalAssessment(value, "historicalAssessment")
  return deepFreeze(structuredClone(value))
}

function manualInputs(candidate, run) {
  return {
    version: candidate.version,
    commitSha: candidate.commitSha,
    tag: `v${candidate.version}`,
    workflowRunId: run.workflowRunId,
    runAttempt: run.runAttempt,
  }
}

function assertHistoricalFacts(value, context) {
  assertExactFields(value.facts, FACT_FIELDS, `${context}.facts`)
  assertExactFields(
    value.facts.controllerEvidence,
    CONTROLLER_EVIDENCE_FIELDS,
    `${context}.facts.controllerEvidence`,
  )
  for (const [key, status] of Object.entries(value.facts.controllerEvidence)) {
    if (status !== "unavailable") {
      throw new TypeError(`${context}: controller evidence ${key} must be unavailable`)
    }
  }
  if (!Array.isArray(value.facts.npmPackages) || value.facts.npmPackages.length === 0) {
    throw new TypeError(`${context}: historical npm packages must be non-empty`)
  }
  if (
    !Array.isArray(value.facts.packageNames) ||
    value.facts.packageNames.length === 0 ||
    !value.facts.packageNames.every(isPackageName) ||
    !isSortedUnique(value.facts.packageNames)
  ) {
    throw new TypeError(`${context}: historical package inventory is invalid`)
  }
  const names = new Set()
  for (const pkg of value.facts.npmPackages) {
    assertExactFields(pkg, NPM_FACT_FIELDS, `${context} npm package`)
    if (!isPackageName(pkg.name) || names.has(pkg.name)) {
      throw new TypeError(`${context}: invalid or duplicate npm package`)
    }
    names.add(pkg.name)
    if (!["PRESENT", "ABSENT", "AMBIGUOUS", "ERROR"].includes(pkg.status)) {
      throw new TypeError(`${context}: invalid npm package status`)
    }
    if (pkg.status === "PRESENT") {
      if (
        pkg.code !== null ||
        !isReleaseVersion(pkg.version) ||
        typeof pkg.shasum !== "string" ||
        !SHA1_PATTERN.test(pkg.shasum) ||
        typeof pkg.integrity !== "string" ||
        !INTEGRITY_PATTERN.test(pkg.integrity) ||
        (pkg.latest !== null && !isReleaseVersion(pkg.latest)) ||
        (pkg.signatureCount !== null &&
          (!Number.isSafeInteger(pkg.signatureCount) || pkg.signatureCount < 0)) ||
        !["PRESENT", "ABSENT", "AMBIGUOUS", "ERROR"].includes(pkg.provenanceStatus) ||
        (pkg.provenanceStatus === "PRESENT"
          ? typeof pkg.provenanceWorkflow !== "string" || !SHA_PATTERN.test(pkg.provenanceCommitSha)
          : pkg.provenanceWorkflow !== null || pkg.provenanceCommitSha !== null)
      ) {
        throw new TypeError(`${context}: malformed PRESENT npm package`)
      }
    } else if (
      typeof pkg.code !== "string" ||
      pkg.version !== null ||
      pkg.shasum !== null ||
      pkg.integrity !== null ||
      (pkg.latest !== null && !isReleaseVersion(pkg.latest)) ||
      pkg.signatureCount !== null ||
      pkg.provenanceStatus !== null ||
      pkg.provenanceWorkflow !== null ||
      pkg.provenanceCommitSha !== null
    ) {
      throw new TypeError(`${context}: malformed non-present npm package`)
    }
  }
}

function assertHistoricalAssessment(value, context) {
  assertExactFields(value, HISTORICAL_ASSESSMENT_FIELDS, context)
  if (
    value.analysisKind !== "historical-audit" ||
    value.disposition !== "audit-only" ||
    typeof value.lastProvenTransition !== "string" ||
    typeof value.nextSafeTransition !== "string" ||
    !stringArray(value.reasons) ||
    !sortedUniqueStringArray(value.conflicts) ||
    !Array.isArray(value.proposedMutations) ||
    value.proposedMutations.length !== 0
  ) {
    throw new TypeError(`${context}: malformed historical assessment`)
  }
  assertManualInputs(value.manualRecoveryInputs, `${context}.manualRecoveryInputs`)
}

function assertPlan(value, context) {
  assertExactFields(
    value,
    ["state", "disposition", "nextTransition", "reasons", "conflicts", "proposedMutations"],
    context,
  )
  if (
    typeof value.state !== "string" ||
    typeof value.disposition !== "string" ||
    (value.nextTransition !== null && typeof value.nextTransition !== "string") ||
    !stringArray(value.reasons) ||
    !stringArray(value.conflicts) ||
    !Array.isArray(value.proposedMutations)
  ) {
    throw new TypeError(`${context}: malformed plan`)
  }
}

function assertCandidate(value, context, nullable) {
  if (value === null && nullable) return
  assertExactFields(value, CANDIDATE_FIELDS, context)
  if (
    !isReleaseVersion(value.version) ||
    typeof value.commitSha !== "string" ||
    !SHA_PATTERN.test(value.commitSha) ||
    ![value.ciCheck, value.ciWorkflow, value.publisherWorkflow].every(isBoundedText)
  ) {
    throw new TypeError(`${context}: malformed candidate`)
  }
}

function assertRun(value, context, nullable) {
  assertExactFields(value, RUN_FIELDS, context)
  if (
    nullable &&
    value.workflow === null &&
    value.workflowRunId === null &&
    value.runAttempt === null
  ) {
    return
  }
  if (
    !isBoundedText(value.workflow) ||
    !isPositiveInteger(value.workflowRunId) ||
    !isPositiveInteger(value.runAttempt)
  ) {
    throw new TypeError(`${context}: malformed run identity`)
  }
}

function assertSource(value, context) {
  assertExactFields(value, SOURCE_FIELDS, context)
  if (
    typeof value.repository !== "string" ||
    !REPOSITORY_PATTERN.test(value.repository) ||
    !isBoundedText(value.requestedRef) ||
    !isBoundedText(value.selectedRef) ||
    typeof value.resolvedCommitSha !== "string" ||
    !SHA_PATTERN.test(value.resolvedCommitSha) ||
    Number.isNaN(Date.parse(value.observedAt)) ||
    !stringArray(value.evidence)
  ) {
    throw new TypeError(`${context}: malformed source metadata`)
  }
}

function assertManualInputs(value, context) {
  assertExactFields(value, MANUAL_INPUT_FIELDS, context)
  if (
    !isReleaseVersion(value.version) ||
    typeof value.commitSha !== "string" ||
    !SHA_PATTERN.test(value.commitSha) ||
    value.tag !== `v${value.version}` ||
    !isPositiveInteger(value.workflowRunId) ||
    !isPositiveInteger(value.runAttempt)
  ) {
    throw new TypeError(`${context}: malformed manual recovery inputs`)
  }
}

function assertExactFields(value, expected, context) {
  if (!isRecord(value)) throw new TypeError(`${context} must be an object`)
  const missing = expected.find((key) => !Object.hasOwn(value, key))
  if (missing !== undefined) throw new TypeError(`${context} missing required field`)
  const unknown = Object.keys(value)
    .filter((key) => !expected.includes(key))
    .sort(compareText)[0]
  if (unknown !== undefined) throw new TypeError(`${context} contains unknown field`)
}

function assertNoSecretKeys(value, context, path = []) {
  if (value === null || typeof value !== "object") return
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      throw new TypeError(`${context}: secret-like key is forbidden`)
    }
    assertNoSecretKeys(child, context, [...path, key])
  }
}

function assertSafeJson(value, context, ancestors) {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    if (typeof value === "string" && Buffer.byteLength(value, "utf8") > MAX_TEXT_BYTES) {
      throw new TypeError(`${context}: text exceeds byte limit`)
    }
    return
  }
  if (typeof value !== "object" || ancestors.has(value)) {
    throw new TypeError(`${context}: value must be acyclic JSON`)
  }
  ancestors.add(value)
  if (Array.isArray(value)) {
    if (
      Object.getPrototypeOf(value) !== Array.prototype ||
      Reflect.ownKeys(value).length !== value.length + 1
    ) {
      throw new TypeError(`${context}: arrays must be dense JSON arrays`)
    }
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (
        descriptor === undefined ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        !descriptor.enumerable
      ) {
        throw new TypeError(`${context}: array entries must be enumerable data properties`)
      }
      assertSafeJson(descriptor.value, context, ancestors)
    }
  } else {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${context}: objects must be plain JSON objects`)
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") throw new TypeError(`${context}: keys must be strings`)
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor.get !== undefined || descriptor.set !== undefined || !descriptor.enumerable) {
        throw new TypeError(`${context}: fields must be enumerable data properties`)
      }
      assertSafeJson(descriptor.value, context, ancestors)
    }
  }
  ancestors.delete(value)
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

function isReleaseVersion(value) {
  return isExactSemver(value) && parseSemver(value).build.length === 0
}

function isPackageName(value) {
  return typeof value === "string" && PACKAGE_PATTERN.test(value)
}

function isBoundedText(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value) <= MAX_TEXT_BYTES &&
    ![...value].some((character) => isUnsafeCodePoint(character.codePointAt(0)))
  )
}

function isUnsafeCodePoint(codePoint) {
  return codePoint <= 0x1f || codePoint === 0x7f || codePoint === 0x2028 || codePoint === 0x2029
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function assertBoundedText(value, context) {
  if (!isBoundedText(value)) throw new TypeError(`${context} must be bounded non-empty text`)
}

function stringArray(value) {
  return Array.isArray(value) && value.every(isBoundedText)
}

function sortedUniqueStringArray(value) {
  return (
    stringArray(value) &&
    new Set(value).size === value.length &&
    value.every((item, index) => index === 0 || compareText(value[index - 1], item) <= 0)
  )
}

function isSortedUnique(value) {
  return (
    new Set(value).size === value.length &&
    value.every((item, index) => index === 0 || compareText(value[index - 1], item) < 0)
  )
}

function isPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0
}

function isRecord(value) {
  return value !== null && !Array.isArray(value) && typeof value === "object"
}

function compareText(left, right) {
  return left === right ? 0 : left < right ? -1 : 1
}
