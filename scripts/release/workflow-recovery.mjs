#!/usr/bin/env node

import * as defaultFileSystem from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"

import { snapshotJson } from "./adapter-normalize.mjs"
import { canonicalManifestBytes, manifestSha256, parseSealedReleaseManifest } from "./manifest.mjs"
import { canonicalNpmEvidenceBytes, parseNpmEvidence } from "./npm-evidence.mjs"
import {
  canonicalReleaseRecordBytes,
  parseReleaseRecord,
  releaseRecordSha256,
} from "./release-record.mjs"
import { canonicalAuditResultBytes, parseAuditResult } from "./terminal-records.mjs"

const MAX_REPORT_BYTES = 1024 * 1024
const SHA_PATTERN = /^[0-9a-f]{40}$/u
const REPORT_FIELDS = Object.freeze([
  "schemaVersion",
  "candidate",
  "before",
  "transition",
  "after",
  "recovery",
  "diagnostics",
])
const RECOVERY_FIELDS = Object.freeze([
  "schemaVersion",
  "candidate",
  "manifest",
  "releaseRecord",
  "npmEvidence",
  "auditDispatch",
  "auditResult",
])
const CANDIDATE_FIELDS = Object.freeze([
  "version",
  "commitSha",
  "ciWorkflow",
  "ciCheck",
  "publisherWorkflow",
])
const PLAN_FIELDS = Object.freeze([
  "state",
  "disposition",
  "nextTransition",
  "reasons",
  "conflicts",
  "proposedMutations",
])
const TRANSITION_FIELDS = Object.freeze(["name", "status", "result", "error"])
const DISPATCH_FIELDS = Object.freeze(["workflow", "workflowRunId", "runUrl", "htmlUrl"])
const STATE_TRANSITIONS = Object.freeze({
  ARTIFACTS_PREPARED: Object.freeze(["attest-artifacts"]),
  ARTIFACTS_ATTESTED: Object.freeze(["escrow-candidate"]),
  CANDIDATE_ESCROWED: Object.freeze(["publish-npm-packages"]),
  NPM_PARTIAL: Object.freeze(["resume-npm-publish"]),
  NPM_COMPLETE: Object.freeze(["reconcile-npm-evidence"]),
  RELEASE_DRAFT_COMPLETE: Object.freeze(["run-release-smokes", "reconcile-smoke-evidence"]),
  SMOKES_COMPLETE: Object.freeze(["dispatch-release-audit"]),
  AUDIT_DISPATCHED: Object.freeze(["complete-release-audit"]),
  AUDIT_RETRYABLE: Object.freeze(["dispatch-release-audit"]),
  AUDIT_VERIFIED: Object.freeze(["publish-github-release"]),
})
const NPM_EVIDENCE_STATES = new Set([
  "NPM_COMPLETE",
  "RELEASE_DRAFT_COMPLETE",
  "SMOKES_COMPLETE",
  "AUDIT_DISPATCHED",
  "AUDIT_RETRYABLE",
  "AUDIT_VERIFIED",
])

export function parseWorkflowRecovery(input) {
  const report = snapshotJson(input)
  assertRecord(report, "Production observation report")
  assertExactFields(report, REPORT_FIELDS, "Production observation report")
  if (report.schemaVersion !== 1 || report.after !== null) {
    throw new TypeError("Production observation report is not a supported dry observation")
  }
  if (!Array.isArray(report.diagnostics) || report.diagnostics.length !== 0) {
    throw new Error("Production recovery requires an observation with zero diagnostics")
  }
  assertRecord(report.before, "Production observation before snapshot")
  assertExactFields(
    report.before,
    ["observation", "plan"],
    "Production observation before snapshot",
  )
  assertRecord(report.before.observation, "Production observation")
  assertRecord(report.before.plan, "Production release plan")
  assertExactFields(report.before.plan, PLAN_FIELDS, "Production release plan")
  assertRecord(report.transition, "Production observation transition")
  assertExactFields(report.transition, TRANSITION_FIELDS, "Production observation transition")

  const plan = report.before.plan
  const allowed = STATE_TRANSITIONS[plan.state]
  if (
    plan.disposition !== "would-transition" ||
    !Array.isArray(allowed) ||
    !allowed.includes(plan.nextTransition) ||
    report.transition.name !== plan.nextTransition ||
    report.transition.status !== "dry-run" ||
    report.transition.result !== null ||
    report.transition.error !== null ||
    !Array.isArray(plan.reasons) ||
    !Array.isArray(plan.conflicts) ||
    plan.conflicts.length !== 0 ||
    !Array.isArray(plan.proposedMutations) ||
    plan.proposedMutations.length !== 1 ||
    plan.proposedMutations[0]?.type !== plan.nextTransition
  ) {
    throw new Error("Production recovery report state and transition do not agree")
  }

  const candidate = parseCandidate(report.candidate)
  const recovery = report.recovery
  assertRecord(recovery, "Production recovery evidence")
  assertExactFields(recovery, RECOVERY_FIELDS, "Production recovery evidence")
  if (recovery.schemaVersion !== 1 || !jsonEqual(parseCandidate(recovery.candidate), candidate)) {
    throw new Error("Production recovery candidate does not match the report")
  }
  const mutation = plan.proposedMutations[0]
  if (mutation.version !== candidate.version || mutation.commitSha !== candidate.commitSha) {
    throw new Error("Production recovery mutation does not match the candidate")
  }

  const manifest = parseSealedReleaseManifest(canonicalManifestBytes(recovery.manifest), {
    candidate,
  })
  const manifestDigest = manifestSha256(manifest)
  const releaseRecord = parseReleaseRecord(recovery.releaseRecord)
  if (
    releaseRecord.version !== candidate.version ||
    releaseRecord.commitSha !== candidate.commitSha ||
    releaseRecord.manifestSha256 !== manifestDigest ||
    report.before.observation.artifacts?.manifestSha256 !== manifestDigest ||
    report.before.observation.artifacts?.releaseRecordAsset?.sha256 !==
      releaseRecordSha256(releaseRecord)
  ) {
    throw new Error("Production recovery artifact identity does not match the observation")
  }

  const npmEvidence =
    recovery.npmEvidence === null
      ? null
      : parseNpmEvidence(recovery.npmEvidence, {
          candidate,
          manifest,
          manifestSha256: manifestDigest,
        })
  if (NPM_EVIDENCE_STATES.has(plan.state) && npmEvidence === null) {
    throw new Error("Production recovery requires exact npm evidence for this state")
  }

  const auditDispatch =
    recovery.auditDispatch === null ? null : parseAuditDispatch(recovery.auditDispatch)
  const auditResult = recovery.auditResult === null ? null : parseAuditResult(recovery.auditResult)
  if (["AUDIT_DISPATCHED", "AUDIT_VERIFIED"].includes(plan.state) && auditDispatch === null) {
    throw new Error("Production recovery requires the recorded independent-audit dispatch")
  }
  if (plan.state === "AUDIT_VERIFIED") {
    if (
      auditResult === null ||
      auditResult.conclusion !== "success" ||
      auditResult.version !== candidate.version ||
      auditResult.commitSha !== candidate.commitSha ||
      auditResult.manifestSha256 !== manifestDigest ||
      auditResult.workflowRunId !== auditDispatch.workflowRunId
    ) {
      throw new Error("Production recovery requires the exact successful independent audit")
    }
  } else if (auditResult !== null) {
    if (
      auditDispatch === null ||
      auditResult.version !== candidate.version ||
      auditResult.commitSha !== candidate.commitSha ||
      auditResult.manifestSha256 !== manifestDigest ||
      auditResult.workflowRunId !== auditDispatch.workflowRunId
    ) {
      throw new Error("Production recovery audit evidence is inconsistent")
    }
  }

  return deepFreeze({
    candidate,
    nextTransition: plan.nextTransition,
    manifest,
    releaseRecord,
    npmEvidence,
    auditDispatch,
    auditResult,
  })
}

export async function writeWorkflowRecovery({ report, outputDir }, runtime = {}) {
  const fileSystem = runtime.fileSystem ?? defaultFileSystem
  const recovered = parseWorkflowRecovery(report)
  if (typeof outputDir !== "string" || outputDir.length === 0 || outputDir.includes("\0")) {
    throw new TypeError("Production recovery output directory is invalid")
  }
  const resolved = path.resolve(runtime.cwd ?? process.cwd(), outputDir)
  await fileSystem.mkdir(resolved, { mode: 0o700 })
  try {
    const files = [
      ["candidate.json", canonicalJsonBytes(recovered.candidate)],
      ["manifest.json", canonicalManifestBytes(recovered.manifest)],
      ["release-record.json", canonicalReleaseRecordBytes(recovered.releaseRecord)],
      ...(recovered.npmEvidence === null
        ? []
        : [
            [
              "npm-evidence.json",
              canonicalNpmEvidenceBytes(recovered.npmEvidence, {
                candidate: recovered.candidate,
                manifest: recovered.manifest,
                manifestSha256: recovered.releaseRecord.manifestSha256,
              }),
            ],
          ]),
      ...(recovered.auditDispatch === null
        ? []
        : [["audit-dispatch.json", canonicalJsonBytes(recovered.auditDispatch)]]),
      ...(recovered.auditResult === null
        ? []
        : [["audit-result.json", canonicalAuditResultBytes(recovered.auditResult)]]),
    ]
    for (const [name, bytes] of files) {
      await fileSystem.writeFile(path.join(resolved, name), bytes, {
        flag: "wx",
        mode: 0o600,
      })
    }
    return recovered
  } catch (error) {
    await fileSystem.rm(resolved, { recursive: true, force: true })
    throw error
  }
}

export async function runWorkflowRecoveryCli(argv, runtime = {}) {
  const options = parseArguments(argv)
  const fileSystem = runtime.fileSystem ?? defaultFileSystem
  const cwd = runtime.cwd ?? process.cwd()
  const reportPath = path.resolve(cwd, options.report)
  const metadata = await fileSystem.lstat(reportPath)
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size < 1 ||
    metadata.size > MAX_REPORT_BYTES
  ) {
    throw new TypeError("Production recovery report must be one bounded regular file")
  }
  const bytes = await fileSystem.readFile(reportPath)
  if (bytes.length !== metadata.size)
    throw new Error("Production recovery report changed while read")
  let report
  try {
    report = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
  } catch (error) {
    throw new TypeError("Production recovery report JSON is invalid", {
      cause: error,
    })
  }
  if (!bytes.equals(canonicalJsonBytes(report))) {
    throw new Error("Production recovery report bytes must be canonical")
  }
  return writeWorkflowRecovery(
    { report, outputDir: path.resolve(cwd, options.outputDir) },
    { fileSystem, cwd },
  )
}

function parseArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== 4) throw usageError()
  const values = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (!new Set(["--report", "--output-dir"]).has(flag) || values.has(flag)) throw usageError()
    if (typeof value !== "string" || value.length === 0 || value.includes("\0")) throw usageError()
    values.set(flag, value)
  }
  if (values.size !== 2) throw usageError()
  return {
    report: values.get("--report"),
    outputDir: values.get("--output-dir"),
  }
}

function parseCandidate(value) {
  const candidate = snapshotJson(value)
  assertRecord(candidate, "Release candidate")
  assertExactFields(candidate, CANDIDATE_FIELDS, "Release candidate")
  if (
    typeof candidate.version !== "string" ||
    !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(
      candidate.version,
    ) ||
    !SHA_PATTERN.test(candidate.commitSha) ||
    candidate.ciWorkflow !== "CI" ||
    candidate.ciCheck !== "validate" ||
    candidate.publisherWorkflow !== ".github/workflows/release.yml"
  ) {
    throw new TypeError("Release candidate identity is invalid")
  }
  return candidate
}

function parseAuditDispatch(value) {
  const dispatch = snapshotJson(value)
  assertRecord(dispatch, "Independent-audit dispatch")
  assertExactFields(dispatch, DISPATCH_FIELDS, "Independent-audit dispatch")
  const id = dispatch.workflowRunId
  if (
    dispatch.workflow !== ".github/workflows/published-artifact-verify.yml" ||
    !Number.isSafeInteger(id) ||
    id < 1 ||
    dispatch.runUrl !== `https://api.github.com/repos/cacheplane/dawnai/actions/runs/${id}` ||
    dispatch.htmlUrl !== `https://github.com/cacheplane/dawnai/actions/runs/${id}`
  ) {
    throw new TypeError("Independent-audit dispatch identity is invalid")
  }
  return dispatch
}

function assertRecord(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
}

function assertExactFields(value, fields, label) {
  const actual = Object.keys(value).sort()
  const expected = [...fields].sort()
  if (!jsonEqual(actual, expected)) throw new TypeError(`${label} fields are invalid`)
}

function canonicalJsonBytes(value) {
  return Buffer.from(`${JSON.stringify(canonicalize(snapshotJson(value)), null, 2)}\n`, "utf8")
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    )
  }
  return value
}

function jsonEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

function usageError() {
  return new TypeError(
    "Usage: node scripts/release/workflow-recovery.mjs --report <production-observation.json> --output-dir <new-directory>",
  )
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runWorkflowRecoveryCli(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
