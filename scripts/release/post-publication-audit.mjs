#!/usr/bin/env node

import path from "node:path"
import { pathToFileURL } from "node:url"

import { snapshotJson } from "./adapter-normalize.mjs"
import {
  createIndependentAuditRuntime,
  parseIndependentAuditArgs,
  parseIndependentAuditEnvironment,
  writeCanonicalAuditResult,
} from "./independent-audit.mjs"
import { REQUIRED_RELEASE_SMOKE_LANES } from "./smoke-result.mjs"
import { parseAuditResult } from "./terminal-records.mjs"

export async function runPostPublicationAudit(argv, overrides = {}) {
  const options = parseIndependentAuditArgs(argv)
  const environment = overrides.environment ?? process.env
  const invocation = parseIndependentAuditEnvironment(environment, options)
  const dependencies = normalizeDependencies(overrides)
  const candidate = Object.freeze({
    version: options.version,
    commitSha: options.commitSha,
    ciWorkflow: "CI",
    ciCheck: "validate",
    publisherWorkflow: ".github/workflows/release.yml",
  })
  const checks = []
  const startedAt = timestamp(dependencies.now)
  let executionError = null
  try {
    const runtime = normalizeRuntime(
      await dependencies.createRuntime({
        root: dependencies.cwd,
        environment,
        candidate,
        invocation,
      }),
    )
    const observed = await auditCheck(checks, "production-observation", async () => {
      const result = snapshotJson(
        await runtime.observeProductionCandidate({
          candidate,
          inventory: await runtime.inventory.read({ ref: candidate.commitSha }),
          marker: runtime.controllerMarker,
          git: runtime.git,
          github: runtime.github,
          npm: runtime.npm,
          npmAuditFactory: runtime.npmAuditFactory,
          attestations: runtime.attestations,
        }),
      )
      if (
        result === null ||
        Array.isArray(result) ||
        typeof result !== "object" ||
        !Array.isArray(result.diagnostics) ||
        result.diagnostics.length !== 0
      ) {
        throw new Error("Production observation contains diagnostics")
      }
      assertPublishedObservation(result.observation, candidate, options.manifestSha256)
      return result.observation
    })
    await auditCheck(checks, "production-plan", async () => {
      const plan = snapshotJson(
        await runtime.planRelease({ candidate, observation: observed, mode: "controller" }),
      )
      if (
        plan?.state !== "AUDIT_COMPLETE" ||
        plan.disposition !== "noop" ||
        plan.nextTransition !== null ||
        !Array.isArray(plan.conflicts) ||
        plan.conflicts.length !== 0 ||
        !Array.isArray(plan.proposedMutations) ||
        plan.proposedMutations.length !== 0
      ) {
        throw new Error("Published Release is not a mutation-free AUDIT_COMPLETE no-op")
      }
    })
  } catch (error) {
    executionError = error
    if (!checks.some((check) => check.conclusion === "failure")) {
      checks.push(failedCheck("post-publication-audit"))
    }
  }
  const result = parseAuditResult({
    schemaVersion: 1,
    version: candidate.version,
    commitSha: candidate.commitSha,
    manifestSha256: options.manifestSha256,
    workflowRunId: invocation.workflowRunId,
    runAttempt: invocation.runAttempt,
    startedAt,
    finishedAt: timestamp(dependencies.now),
    checks,
    conclusion: executionError === null ? "success" : "failure",
  })
  await dependencies.writeResult(path.resolve(dependencies.cwd, options.result), result)
  if (executionError !== null)
    throw new Error("Post-publication audit failed", { cause: executionError })
  return result
}

function assertPublishedObservation(value, candidate, manifestSha256) {
  const observation = snapshotJson(value)
  const release = observation?.release
  const marker = release?.marker
  const audit = observation?.audit
  if (
    observation?.tag?.status !== "present" ||
    observation.tag.commitSha !== candidate.commitSha ||
    release?.status !== "published" ||
    release.tag !== `v${candidate.version}` ||
    release.commitSha !== candidate.commitSha ||
    release.immutable !== true ||
    marker?.phase !== "AUDIT_VERIFIED" ||
    marker.version !== candidate.version ||
    marker.commitSha !== candidate.commitSha ||
    marker.tag !== `v${candidate.version}` ||
    marker.manifestSha256 !== manifestSha256 ||
    audit?.status !== "success" ||
    audit.version !== candidate.version ||
    audit.commitSha !== candidate.commitSha ||
    audit.manifestSha256 !== manifestSha256 ||
    audit.conclusion !== "success" ||
    !Array.isArray(observation.requiredSmokeLanes) ||
    observation.requiredSmokeLanes.join("\0") !== REQUIRED_RELEASE_SMOKE_LANES.join("\0") ||
    !Array.isArray(observation.smokes) ||
    observation.smokes.length !== REQUIRED_RELEASE_SMOKE_LANES.length ||
    observation.smokes.some(
      (smoke, index) =>
        smoke?.name !== REQUIRED_RELEASE_SMOKE_LANES[index] ||
        smoke.status !== "passed" ||
        smoke.version !== candidate.version ||
        smoke.commitSha !== candidate.commitSha ||
        smoke.manifestSha256 !== manifestSha256,
    )
  ) {
    throw new Error("Published immutable Release observation is not exact")
  }
}

async function auditCheck(checks, name, operation) {
  try {
    const result = await operation()
    checks.push({
      name,
      conclusion: "success",
      detail: "The published immutable Release remains exact and mutation-free.",
    })
    return result
  } catch (error) {
    checks.push(failedCheck(name))
    throw error
  }
}

function failedCheck(name) {
  return {
    name,
    conclusion: "failure",
    detail: "Post-publication audit check failed (POST_PUBLICATION_AUDIT_FAILED).",
  }
}

function normalizeDependencies(overrides) {
  if (overrides === null || Array.isArray(overrides) || typeof overrides !== "object") {
    throw new TypeError("Post-publication audit dependencies are invalid")
  }
  const dependencies = {
    cwd: overrides.cwd ?? process.cwd(),
    createRuntime: overrides.createRuntime ?? createIndependentAuditRuntime,
    now: overrides.now ?? (() => new Date()),
    writeResult: overrides.writeResult ?? writeCanonicalAuditResult,
  }
  if (
    typeof dependencies.cwd !== "string" ||
    !path.isAbsolute(dependencies.cwd) ||
    dependencies.cwd.includes("\0") ||
    typeof dependencies.createRuntime !== "function" ||
    typeof dependencies.now !== "function" ||
    typeof dependencies.writeResult !== "function"
  ) {
    throw new TypeError("Post-publication audit dependency is invalid")
  }
  return Object.freeze(dependencies)
}

function normalizeRuntime(value) {
  if (
    value === null ||
    Array.isArray(value) ||
    typeof value !== "object" ||
    typeof value.inventory?.read !== "function" ||
    typeof value.observeProductionCandidate !== "function" ||
    typeof value.planRelease !== "function"
  ) {
    throw new TypeError("Post-publication audit runtime is invalid")
  }
  return value
}

function timestamp(now) {
  const value = now()
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime()))
    throw new TypeError("Post-publication audit clock is invalid")
  return date.toISOString()
}

async function main() {
  try {
    await runPostPublicationAudit(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main()
}
