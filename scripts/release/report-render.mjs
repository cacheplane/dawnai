import { snapshotJson } from "./adapter-normalize.mjs"

const SECRET_KEY_PATTERN =
  /(?:authorization|cookie|password|secret|token|private.?key|^gh[pousr]_|^github_pat_|^npm_)/iu

export function renderReportJson(input) {
  const report = safeReport(input)
  return `${JSON.stringify(canonicalize(report), null, 2)}\n`
}

export function renderReportMarkdown(input) {
  const report = safeReport(input)
  const historical = report.reportKind === "historical-audit"
  const candidate = report.candidate
  return [
    "# Release Reconciliation Report",
    "",
    "## Analysis boundary",
    "",
    `- Report kind: ${inlineCode(report.reportKind)}`,
    `- Managed controller state: ${historical ? "Not evaluated — historical facts are audit-only" : inlineCode(report.plan.state)}`,
    historical
      ? "- Historical evidence is not a managed observation and cannot authorize controller mutations."
      : "- Managed observation was evaluated in read-only shadow mode.",
    "",
    "## Candidate",
    "",
    `- Version: ${candidate === null ? "None" : inlineCode(candidate.version)}`,
    `- Commit SHA: ${candidate === null ? "None" : inlineCode(candidate.commitSha)}`,
    `- Repository: ${report.source === null ? "Unknown" : escapeMarkdown(report.source.repository)}`,
    `- Requested ref: ${report.source === null ? "Unknown" : inlineCode(report.source.requestedRef)}`,
    `- Selected ref: ${report.source === null ? "Unknown" : inlineCode(report.source.selectedRef)}`,
    `- Resolved commit SHA: ${report.source === null ? "Unknown" : inlineCode(report.source.resolvedCommitSha)}`,
    `- Source run: ${formatRun(report.run)}`,
    "",
    "## Evidence assessment",
    "",
    `- Disposition: ${inlineCode(historical ? report.historicalAssessment.disposition : report.plan.disposition)}`,
    `- Last proven transition: ${inlineCode(report.lastProvenTransition)}`,
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
  ].join("\n")
}

export function redactCredentialText(value) {
  return String(value)
    .replace(/\b(?:Bearer|Basic)\s+[^\s,;]+/giu, "[REDACTED]")
    .replace(
      /\b(?:gh[pousr]_[A-Za-z0-9_-]+|github_pat_[A-Za-z0-9_-]+|npm_[A-Za-z0-9_-]+)/giu,
      "[REDACTED]",
    )
    .replace(/\bAuthorization\s*[:=]\s*[^\s,;]+/giu, "[REDACTED]")
    .replace(/\b(?:token|password|secret|api[_-]?key)\s*[:=]\s*[^\s,;&]+/giu, "[REDACTED]")
    .replace(/(https?:\/\/)[^/@\s]+@/giu, "$1[REDACTED]@")
    .replace(
      /([?&](?:access_token|auth|authorization|password|secret|token)=)[^&#\s]*/giu,
      "$1[REDACTED]",
    )
}

function safeReport(input) {
  let report
  try {
    report = snapshotJson(input)
  } catch {
    throw new TypeError("Invalid report")
  }
  assertNoSecrets(report)
  for (const identity of [
    report.reportKind,
    report.lastProvenTransition,
    report.candidate?.version,
    report.candidate?.commitSha,
    report.run?.workflow,
    report.source?.repository,
    report.source?.requestedRef,
    report.source?.selectedRef,
    report.source?.resolvedCommitSha,
  ]) {
    if (identity !== null && identity !== undefined && !isSafeIdentity(identity)) {
      throw new TypeError("Invalid report identity")
    }
  }
  return report
}

function isSafeIdentity(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= 4_096 &&
    ![...value].some((character) => isUnsafeCodePoint(character.codePointAt(0)))
  )
}

function assertNoSecrets(value) {
  if (value === null || typeof value !== "object") return
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY_PATTERN.test(key)) throw new TypeError("Report contains a forbidden field")
    assertNoSecrets(child)
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (typeof value === "string") return redactCredentialText(value)
  if (value === null || typeof value !== "object") return value
  return Object.fromEntries(
    Object.keys(value)
      .sort(compareText)
      .map((key) => [key, canonicalize(value[key])]),
  )
}

function manualRecoveryMarkdown(value) {
  if (value === null) return ["None."]
  return [
    `- Version: ${inlineCode(value.version)}`,
    `- Commit SHA: ${inlineCode(value.commitSha)}`,
    `- Tag: ${inlineCode(value.tag)}`,
    `- Workflow run: ${value.workflowRunId}`,
    `- Run attempt: ${value.runAttempt}`,
  ]
}

function npmFactsMarkdown(report) {
  if (report.reportKind === "historical-audit") {
    return report.historicalFacts.npmPackages.map(
      (pkg) =>
        `- ${inlineCode(pkg.name)}: status ${inlineCode(pkg.status)}; code ${nullable(pkg.code)}; version ${nullable(pkg.version)}; latest ${nullable(pkg.latest)}; shasum ${nullable(pkg.shasum)}; integrity ${nullable(pkg.integrity)}; signatures ${nullable(pkg.signatureCount)}; provenance ${inlineCode(pkg.provenanceStatus)} / ${nullable(pkg.provenanceWorkflow)} / ${nullable(pkg.provenanceCommitSha)}`,
    )
  }
  const packages = report.observation.registry?.packages
  if (!Array.isArray(packages) || packages.length === 0) return ["None."]
  return packages.map((pkg) => {
    const provenance =
      pkg.provenance === null
        ? "None"
        : `${inlineCode(pkg.provenance.workflow)} / ${inlineCode(pkg.provenance.commitSha)}`
    return `- ${inlineCode(pkg.name)}: status ${inlineCode(pkg.status)}; version ${nullable(pkg.version)}; latest ${inlineCode(pkg.latest.status)} / ${nullable(pkg.latest.version)}; signature ${inlineCode(pkg.signature.status)}; provenance ${provenance}`
  })
}

function nullable(value) {
  return value === null ? "None" : inlineCode(value)
}
function markdownList(values) {
  return values.length === 0 ? ["None."] : values.map((value) => `- ${escapeMarkdown(value)}`)
}
function inlineCode(value) {
  const text = sanitizeLineText(redactCredentialText(value))
  const longest = Math.max(0, ...[...text.matchAll(/`+/gu)].map((match) => match[0].length))
  const delimiter = "`".repeat(longest + 1)
  const padded = /^[ `]|[ `]$/u.test(text) ? ` ${text} ` : text
  return `${delimiter}${padded}${delimiter}`
}
function formatRun(run) {
  return run.workflow === null
    ? "None"
    : `${inlineCode(run.workflow)} / ${run.workflowRunId} / attempt ${run.runAttempt}`
}
function escapeMarkdown(value) {
  return sanitizeLineText(redactCredentialText(value))
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/([\\`*_[\]{}()#+.!|-])/gu, "\\$1")
}
function sanitizeLineText(value) {
  return [...value]
    .map((character) => (isUnsafeCodePoint(character.codePointAt(0)) ? " " : character))
    .join("")
}
function isUnsafeCodePoint(codePoint) {
  return codePoint <= 0x1f || codePoint === 0x7f || codePoint === 0x2028 || codePoint === 0x2029
}
function compareText(left, right) {
  return left === right ? 0 : left < right ? -1 : 1
}
