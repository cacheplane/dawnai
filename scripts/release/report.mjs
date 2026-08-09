import { planRelease as defaultPlanRelease } from "./planner.mjs"
import { compareSemver, isExactSemver, parseSemver } from "./semver.mjs"

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
const SECRET_KEY_PATTERN = /(?:authorization|cookie|password|secret|token|private.?key)/iu
const SECRET_VALUE_PATTERN =
  /(?:\bBearer\s+\S+|\b(?:gh[pousr]|github_pat|npm)_[A-Za-z0-9_-]{8,}|\b(?:token|password|secret)\s*[:=]\s*\S+)/giu
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
  const { candidate, facts, run } = fixture
  const controllerConflicts = controllerEvidenceConflicts(facts.controllerEvidence)
  const ambiguous = facts.npmPackages.some((pkg) => ["AMBIGUOUS", "ERROR"].includes(pkg.status))
  const packageSetComplete = arraysEqual(
    facts.npmPackages.map((pkg) => pkg.name),
    facts.packageNames,
  )
  const complete =
    packageSetComplete &&
    facts.npmPackages.length > 0 &&
    facts.npmPackages.every((pkg) => historicalPackageComplete(pkg, candidate))
  const superseded =
    !complete &&
    facts.npmPackages.length > 0 &&
    facts.npmPackages.every(
      (pkg) => isReleaseVersion(pkg.latest) && compareSemver(pkg.latest, candidate.version) > 0,
    )

  if (complete) {
    return historicalAssessment({
      lastProvenTransition: "LEGACY_NPM_REGISTRY_COMPLETE_UNCORRELATED",
      nextSafeTransition: `Perform a manual audit for v${candidate.version} at release run ${run.workflowRunId} attempt ${run.runAttempt}; preserve public npm evidence and do not resume managed publication.`,
      reasons: [
        `All exact ${candidate.version} npm packages have public integrity, signatures, latest tags, and publisher provenance, but no managed tarball SHA-256 correlation exists.`,
        "This pre-controller release has no managed manifest, release record, artifact attestations, or escrow evidence.",
      ],
      conflicts: controllerConflicts,
      manualRecoveryInputs: manualInputs(candidate, run),
    })
  }

  if (superseded) {
    return historicalAssessment({
      lastProvenTransition: "LEGACY_CANDIDATE_SUPERSEDED_UNCORRELATED",
      nextSafeTransition: `Retain ${candidate.version} as skipped history and audit the failed release run ${run.workflowRunId} attempt ${run.runAttempt}; do not publish or repair it.`,
      reasons: [
        `Every observed package latest tag is newer than ${candidate.version}, while exact-version 404 responses do not prove registry absence.`,
        "The failed pre-controller release has no managed manifest, release record, artifact attestations, or escrow evidence.",
      ],
      conflicts: ["exact-version-registry-absence-unproven", ...controllerConflicts],
      manualRecoveryInputs: manualInputs(candidate, run),
    })
  }

  return historicalAssessment({
    lastProvenTransition: "LEGACY_NPM_REGISTRY_INCOMPLETE",
    nextSafeTransition: `Collect and independently audit exact npm evidence for v${candidate.version}; do not invoke managed publication.`,
    reasons: [
      "Public npm facts are missing, ambiguous, or do not exactly correlate to the historical candidate.",
      "Pre-controller facts cannot establish managed release completion.",
    ],
    conflicts: [
      ...(!packageSetComplete ? ["historical-npm-package-set-mismatch"] : []),
      ...(ambiguous ? ["historical-npm-package-ambiguous"] : ["historical-npm-package-incomplete"]),
      ...historicalNestedFactConflicts(facts.npmPackages, candidate),
      ...controllerConflicts,
    ],
    manualRecoveryInputs: manualInputs(candidate, run),
  })
}

function historicalNestedFactConflicts(packages, candidate) {
  const conflicts = new Set()
  for (const pkg of packages) {
    if (pkg.status !== "PRESENT") continue
    if (pkg.latest !== candidate.version) conflicts.add("historical-npm-latest-incomplete")
    if (!Number.isSafeInteger(pkg.signatureCount) || pkg.signatureCount <= 0) {
      conflicts.add("historical-npm-signature-unverified")
    }
    if (pkg.provenanceStatus !== "PRESENT") {
      conflicts.add("historical-npm-provenance-incomplete")
    } else if (
      pkg.provenanceWorkflow !== candidate.publisherWorkflow ||
      pkg.provenanceCommitSha !== candidate.commitSha
    ) {
      conflicts.add("historical-npm-provenance-mismatch")
    }
  }
  return [...conflicts].sort(compareText)
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
    const assessment = snapshotHistoricalAssessment(assessmentInput)
    return deepFreeze({
      schemaVersion: 1,
      reportKind: "historical-audit",
      candidate: structuredClone(facts.candidate),
      run: structuredClone(run ?? facts.run),
      source: structuredClone(source ?? facts.source),
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

export function renderReportJson(report) {
  assertSafeJson(report, "report", new Set())
  assertNoSecretKeys(report, "report")
  return `${JSON.stringify(canonicalize(report), null, 2)}\n`
}

export function renderReportMarkdown(report) {
  assertSafeJson(report, "report", new Set())
  assertNoSecretKeys(report, "report")
  const historical = report.reportKind === "historical-audit"
  const candidate = report.candidate
  const lines = [
    "# Release Reconciliation Report",
    "",
    "## Analysis boundary",
    "",
    `- Report kind: ${markdownValue(report.reportKind)}`,
    `- Managed controller state: ${historical ? "Not evaluated — historical facts are audit-only" : markdownValue(report.plan.state)}`,
    historical
      ? "- Historical evidence is not a managed observation and cannot authorize controller mutations."
      : "- Managed observation was evaluated in read-only shadow mode.",
    "",
    "## Candidate",
    "",
    `- Version: ${candidate === null ? "None" : markdownValue(candidate.version)}`,
    `- Commit SHA: ${candidate === null ? "None" : markdownValue(candidate.commitSha)}`,
    `- Repository: ${report.source === null ? "Unknown" : escapeMarkdown(report.source.repository)}`,
    `- Requested ref: ${report.source === null ? "Unknown" : markdownValue(report.source.requestedRef)}`,
    `- Selected ref: ${report.source === null ? "Unknown" : markdownValue(report.source.selectedRef)}`,
    `- Resolved commit SHA: ${report.source === null ? "Unknown" : markdownValue(report.source.resolvedCommitSha)}`,
    `- Source run: ${formatRun(report.run)}`,
    "",
    "## Evidence assessment",
    "",
    `- Disposition: ${markdownValue(historical ? report.historicalAssessment.disposition : report.plan.disposition)}`,
    `- Last proven transition: ${markdownValue(report.lastProvenTransition)}`,
    `- Next safe transition: ${report.nextSafeTransition === null ? "None" : escapeMarkdown(report.nextSafeTransition)}`,
    "",
    "### Reasons",
    "",
    ...markdownList(report.reasons),
    "",
    "### Conflicts",
    "",
    ...markdownList(report.conflicts),
    "",
    "## Public npm facts",
    "",
    ...npmFactsMarkdown(report),
    "",
    "## Manual recovery",
    "",
    ...manualRecoveryMarkdown(report.manualRecoveryInputs),
    "",
    "## Proposed mutations",
    "",
    ...(historical
      ? ["None. Historical audit reports can never propose mutations."]
      : markdownList(report.plan.proposedMutations.map((mutation) => JSON.stringify(mutation)))),
    "",
  ]
  return lines.join("\n")
}

function snapshotHistoricalFixture(value) {
  assertSafeJson(value, "historical facts", new Set())
  assertNoSecretKeys(value, "historical facts")
  return parseReconciliationFixture(JSON.stringify(value), value?.incidentId ?? "historical facts")
}

function snapshotHistoricalAssessment(value) {
  assertHistoricalAssessment(value, "historicalAssessment")
  return deepFreeze(structuredClone(value))
}

function historicalAssessment({
  lastProvenTransition,
  nextSafeTransition,
  reasons,
  conflicts,
  manualRecoveryInputs,
}) {
  return deepFreeze({
    analysisKind: "historical-audit",
    disposition: "audit-only",
    lastProvenTransition,
    nextSafeTransition,
    reasons,
    conflicts: [...new Set(conflicts)].sort(compareText),
    manualRecoveryInputs,
    proposedMutations: [],
  })
}

function historicalPackageComplete(pkg, candidate) {
  return (
    pkg.status === "PRESENT" &&
    pkg.code === null &&
    pkg.version === candidate.version &&
    typeof pkg.shasum === "string" &&
    SHA1_PATTERN.test(pkg.shasum) &&
    typeof pkg.integrity === "string" &&
    INTEGRITY_PATTERN.test(pkg.integrity) &&
    pkg.latest === candidate.version &&
    Number.isSafeInteger(pkg.signatureCount) &&
    pkg.signatureCount > 0 &&
    pkg.provenanceStatus === "PRESENT" &&
    pkg.provenanceWorkflow === candidate.publisherWorkflow &&
    pkg.provenanceCommitSha === candidate.commitSha
  )
}

function controllerEvidenceConflicts(value) {
  const names = {
    artifactAttestations: "managed-artifact-attestations-unavailable",
    escrow: "managed-escrow-unavailable",
    manifest: "managed-manifest-unavailable",
    releaseRecord: "managed-release-record-unavailable",
  }
  return Object.keys(names)
    .filter((key) => value[key] === "unavailable")
    .map((key) => names[key])
    .sort(compareText)
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
  if (missing !== undefined) throw new TypeError(`${context} missing field ${missing}`)
  const unknown = Object.keys(value)
    .filter((key) => !expected.includes(key))
    .sort(compareText)[0]
  if (unknown !== undefined) throw new TypeError(`${context} contains unknown field ${unknown}`)
}

function assertNoSecretKeys(value, context, path = []) {
  if (value === null || typeof value !== "object") return
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      throw new TypeError(`${context}: secret-like key ${[...path, key].join(".")}`)
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

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (typeof value === "string") return redactText(value)
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.keys(value)
      .sort(compareText)
      .map((key) => [key, canonicalize(value[key])]),
  )
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

function manualRecoveryMarkdown(value) {
  if (value === null) return ["None."]
  return [
    `- Version: ${markdownValue(value.version)}`,
    `- Commit SHA: ${markdownValue(value.commitSha)}`,
    `- Tag: ${markdownValue(value.tag)}`,
    `- Workflow run: ${value.workflowRunId}`,
    `- Run attempt: ${value.runAttempt}`,
  ]
}

function npmFactsMarkdown(report) {
  if (report.reportKind === "historical-audit") {
    const packages = report.historicalFacts.npmPackages
    return packages.length === 0
      ? ["None."]
      : packages.map(
          (pkg) =>
            `- ${markdownValue(pkg.name)}: status ${markdownValue(pkg.status)}; code ${markdownNullable(pkg.code)}; version ${markdownNullable(pkg.version)}; latest ${markdownNullable(pkg.latest)}; shasum ${markdownNullable(pkg.shasum)}; integrity ${markdownNullable(pkg.integrity)}; signatures ${markdownNullable(pkg.signatureCount)}; provenance ${markdownValue(pkg.provenanceStatus)} / ${markdownNullable(pkg.provenanceWorkflow)} / ${markdownNullable(pkg.provenanceCommitSha)}`,
        )
  }

  const packages = report.observation.registry?.packages
  if (!Array.isArray(packages) || packages.length === 0) return ["None."]
  return packages.map((pkg) => {
    const provenance =
      pkg.provenance === null
        ? "None"
        : `${markdownValue(pkg.provenance.workflow)} / ${markdownValue(pkg.provenance.commitSha)}`
    return `- ${markdownValue(pkg.name)}: status ${markdownValue(pkg.status)}; version ${markdownNullable(pkg.version)}; latest ${markdownValue(pkg.latest.status)} / ${markdownNullable(pkg.latest.version)}; signature ${markdownValue(pkg.signature.status)}; provenance ${provenance}`
  })
}

function markdownNullable(value) {
  return value === null ? "None" : markdownValue(value)
}

function markdownList(values) {
  return values.length === 0 ? ["None."] : values.map((value) => `- ${escapeMarkdown(value)}`)
}

function markdownValue(value) {
  return `\`${redactText(String(value)).replaceAll("`", "\\`")}\``
}

function formatRun(run) {
  return run.workflow === null
    ? "None"
    : `${markdownValue(run.workflow)} / ${run.workflowRunId} / attempt ${run.runAttempt}`
}

function escapeMarkdown(value) {
  return redactText(String(value))
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/([\\`*_[\]{}()#+.!|-])/gu, "\\$1")
}

function redactText(value) {
  return value.replace(SECRET_VALUE_PATTERN, "[REDACTED]")
}

function isReleaseVersion(value) {
  return isExactSemver(value) && parseSemver(value).build.length === 0
}

function isPackageName(value) {
  return typeof value === "string" && PACKAGE_PATTERN.test(value)
}

function isBoundedText(value) {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= MAX_TEXT_BYTES
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

function arraysEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index])
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
