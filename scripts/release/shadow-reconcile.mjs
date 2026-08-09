#!/usr/bin/env node

import path from "node:path"
import { pathToFileURL } from "node:url"
import { normalizeAdapterEnvelope } from "./adapter-normalize.mjs"
import { createGitReader as defaultCreateGitReader } from "./adapters/git.mjs"
import { createGitHubReader as defaultCreateGitHubReader } from "./adapters/github.mjs"
import { createNpmReader as defaultCreateNpmReader } from "./adapters/npm.mjs"
import { CliInputError, parseShadowArguments } from "./cli-args.mjs"
import { readBoundedFixture as defaultReadBoundedFixture } from "./fixture-io.mjs"
import {
  assertValidReleaseInventory as defaultAssertValidReleaseInventory,
  readReleaseInventory as defaultReadReleaseInventory,
  validateReleaseInventory as defaultValidateReleaseInventory,
} from "./inventory.mjs"
import { discoverShadowCandidate } from "./observe.mjs"
import { planRelease as defaultPlanRelease } from "./planner.mjs"
import {
  assessHistoricalFacts,
  createReconciliationReport,
  parseReconciliationFixture,
  reconcileFixture,
  renderReportJson,
  renderReportMarkdown,
} from "./report.mjs"
import { redactCredentialText } from "./report-render.mjs"

const SHA_PATTERN = /^[0-9a-f]{40}$/u
const FROZEN_INCIDENT_RUNS = new Map([
  [
    "5bb97cf3434e7c4afa95646982d510d79387ba5b",
    { id: 31290525598, runAttempt: 1, createdAt: "2026-08-09T02:31:46Z" },
  ],
  [
    "341678ea7932832ec860bdd915371669440bef7c",
    { id: 31292769511, runAttempt: 1, createdAt: "2026-08-09T03:36:20Z" },
  ],
])

export async function runShadowReconcile({
  argv = process.argv.slice(2),
  env = process.env,
  stdout = process.stdout,
  stderr = process.stderr,
  cwd = process.cwd(),
  dependencies = {},
} = {}) {
  try {
    const options = parseShadowArguments(argv, cwd)
    if (options.observation !== undefined) {
      const readFixture = dependencies.readBoundedFixture ?? defaultReadBoundedFixture
      const source = await readFixture(options.observation, { root: cwd })
      const fixture = parseReconciliationFixture(source, "fixture")
      const report = reconcileFixture(fixture, {
        planRelease: dependencies.planRelease ?? defaultPlanRelease,
      })
      stdout.write(render(report, options.format))
      return 0
    }

    const [owner, repo] = options.repository.split("/")
    const createGitReader = dependencies.createGitReader ?? defaultCreateGitReader
    const createNpmReader = dependencies.createNpmReader ?? defaultCreateNpmReader
    const createGitHubReader = dependencies.createGitHubReader ?? defaultCreateGitHubReader
    const readReleaseInventory = dependencies.readReleaseInventory ?? defaultReadReleaseInventory
    const assertValidReleaseInventory =
      dependencies.assertValidReleaseInventory ?? defaultAssertValidReleaseInventory
    const validateReleaseInventory =
      dependencies.validateReleaseInventory ?? defaultValidateReleaseInventory
    const git = createGitReader({ root: cwd })
    const npm = createNpmReader()
    const token = env.GITHUB_TOKEN
    const github = createGitHubReader({
      owner,
      repo,
      ...(token === undefined || token === "" ? {} : { token }),
    })
    const inventoryReader = {
      async read({ ref }) {
        const raw = await readReleaseInventory({ root: cwd, ref, git })
        const validated = assertValidReleaseInventory(raw)
        return {
          status: "valid",
          packages: validated.packages.map((name) => ({ name, version: validated.version })),
        }
      },
    }
    const historicalInventoryReader = {
      async read({ ref, version }) {
        const raw = await readReleaseInventory({ root: cwd, ref, git })
        const validated = validateReleaseInventory(raw)
        if (
          validated.structuralErrors.length > 0 ||
          validated.workspaceDuplicates.length > 0 ||
          validated.versionMismatches.length > 0 ||
          validated.version !== version
        ) {
          throw new Error("Historical public package inventory is invalid")
        }
        // Pre-controller audits inventory every public package manifest. Fixed-group membership
        // defects remain historical conflicts and must not erase independently public npm facts.
        return {
          packages: validated.packages.map((name) => ({ name, version: validated.version })),
        }
      },
    }

    let candidate
    let sourceIdentity
    if (options.version !== undefined) {
      candidate = candidateIdentity(options.version, options.commitSha)
      sourceIdentity = {
        requestedRef: options.commitSha,
        selectedRef: options.commitSha,
        resolvedCommitSha: options.commitSha,
      }
    } else {
      const discovery = await discoverFromExplicitMainRefs({
        git,
        inventory: inventoryReader,
        discover: dependencies.discoverShadowCandidate ?? discoverShadowCandidate,
      })
      candidate = discovery.candidate
      sourceIdentity = discovery.sourceIdentity
    }

    if (candidate === null) {
      const planRelease = dependencies.planRelease ?? defaultPlanRelease
      const plan = planRelease({ candidate: null, observation: {}, mode: "shadow" })
      const report = createReconciliationReport({
        candidate: null,
        observation: {},
        plan,
        run: { workflow: null, workflowRunId: null, runAttempt: null },
        source: {
          repository: options.repository,
          ...sourceIdentity,
          observedAt: new Date().toISOString(),
          evidence: [
            "Git first-parent identity",
            "fixed-group manifests at commit and first parent",
          ],
        },
      })
      stdout.write(render(report, options.format))
      return 0
    }

    // Until a managed manifest exists, a live exact-version query is deliberately historical.
    // It records npm/run facts without coercing them into the managed planner's evidence model.
    const facts = await observeHistoricalLive({
      candidate,
      repository: options.repository,
      inventory: await historicalInventoryReader.read({
        ref: candidate.commitSha,
        version: candidate.version,
      }),
      npm,
      github,
      sourceIdentity,
    })
    const assessment = assessHistoricalFacts(facts)
    facts.expected = assessment
    const report = createReconciliationReport({
      historicalFacts: facts,
      historicalAssessment: assessment,
      run: facts.run,
      source: facts.source,
    })
    stdout.write(render(report, options.format))
    return 0
  } catch (error) {
    const input = error instanceof CliInputError || error instanceof TypeError
    stderr.write(
      `${safeMessage(error, input ? "Invalid shadow reconciliation input" : "Shadow reconciliation failed")}\n`,
    )
    return input ? 2 : 1
  }
}

async function discoverFromExplicitMainRefs({ git, inventory, discover }) {
  for (const ref of ["origin/main", "main"]) {
    let resolvedCommitSha
    try {
      const history = await git.listFirstParentHistory({ ref, maxCount: 1 })
      if (!Array.isArray(history) || history.length !== 1 || !SHA_PATTERN.test(history[0])) {
        throw new Error("Explicit main ref did not resolve to one exact commit")
      }
      resolvedCommitSha = history[0]
    } catch (error) {
      if (ref === "origin/main" && error?.code === "REF_NOT_FOUND") continue
      throw error
    }
    const candidate = await discover({ ref: resolvedCommitSha, git, inventory })
    return {
      candidate,
      sourceIdentity: {
        requestedRef: "origin/main",
        selectedRef: ref,
        resolvedCommitSha,
      },
    }
  }
  throw new Error("No explicit main ref could be read")
}

async function observeHistoricalLive({
  candidate,
  repository,
  inventory,
  npm,
  github,
  sourceIdentity,
}) {
  if (!Array.isArray(inventory.packages) || inventory.packages.length === 0) {
    throw new Error("Historical inventory contains no public packages")
  }
  const npmPackages = []
  for (const { name } of inventory.packages) {
    const versionResult = normalizeAdapterEnvelope(
      await npm.observePackageVersion({ name, version: candidate.version }),
      { source: "npm", operation: "package-version", payloadKey: "package" },
    )
    const metadataResult = normalizeAdapterEnvelope(await npm.observePackageMetadata({ name }), {
      source: "npm",
      operation: "package-metadata",
      payloadKey: "metadata",
    })
    npmPackages.push(historicalNpmFact(name, candidate.version, versionResult, metadataResult))
  }
  const runs = normalizeAdapterEnvelope(
    await github.listWorkflowRuns({
      workflow: "release.yml",
      commitSha: candidate.commitSha,
    }),
    { source: "github", operation: "workflow-runs", payloadKey: "value" },
  )
  if (runs.status !== "PRESENT" || !Array.isArray(runs.value) || runs.value.length === 0) {
    throw new Error(`Release workflow run evidence is ${String(runs.code ?? runs.status)}`)
  }
  const frozenRun = FROZEN_INCIDENT_RUNS.get(candidate.commitSha)
  const correlated = runs.value.filter(
    (run) =>
      run?.head_sha === candidate.commitSha &&
      Number.isSafeInteger(run.id) &&
      run.id > 0 &&
      Number.isSafeInteger(run.run_attempt) &&
      run.run_attempt > 0 &&
      run.path === candidate.publisherWorkflow,
  )
  const pinned =
    frozenRun === undefined
      ? []
      : runs.value.filter(
          (run) => run?.id === frozenRun.id && run.run_attempt === frozenRun.runAttempt,
        )
  const matching =
    frozenRun === undefined ? (correlated.length === 1 ? correlated[0] : null) : pinned[0]
  if (matching === null || matching === undefined) {
    throw new Error(
      frozenRun === undefined
        ? "Release workflow run evidence is ambiguous"
        : "Frozen incident workflow run is missing or mismatched",
    )
  }
  if (
    frozenRun !== undefined &&
    (pinned.length !== 1 ||
      matching.head_sha !== candidate.commitSha ||
      matching.path !== candidate.publisherWorkflow)
  ) {
    throw new Error("Frozen incident workflow run is missing or mismatched")
  }
  const runIdentity = {
    id: matching.id,
    runAttempt: matching.run_attempt,
    createdAt: frozenRun?.createdAt ?? matching.created_at,
  }
  return {
    schemaVersion: 1,
    kind: "historical-facts",
    incidentId: `live-${candidate.version}-${candidate.commitSha.slice(0, 12)}`,
    candidate,
    run: {
      workflow: ".github/workflows/release.yml",
      workflowRunId: runIdentity.id,
      runAttempt: runIdentity.runAttempt,
    },
    source: {
      repository,
      ...sourceIdentity,
      observedAt:
        typeof runIdentity.createdAt === "string" &&
        !Number.isNaN(Date.parse(runIdentity.createdAt))
          ? runIdentity.createdAt
          : new Date().toISOString(),
      evidence: [
        "public npm exact-version metadata",
        "npm signatures and provenance statements",
        "GitHub Actions release run history",
      ],
    },
    facts: {
      packageNames: inventory.packages.map((pkg) => pkg.name),
      npmPackages,
      controllerEvidence: {
        artifactAttestations: "unavailable",
        escrow: "unavailable",
        manifest: "unavailable",
        releaseRecord: "unavailable",
      },
    },
    expected: historicalExpectedPlaceholder(candidate, {
      id: runIdentity.id,
      run_attempt: runIdentity.runAttempt,
    }),
  }
}

function historicalNpmFact(name, candidateVersion, versionResult, metadataResult) {
  const latest =
    metadataResult.status === "PRESENT" && metadataResult.metadata?.name === name
      ? metadataResult.metadata.latest
      : null
  if (versionResult.status === "PRESENT") {
    const pkg = versionResult.package
    if (pkg?.name !== name || pkg.version !== candidateVersion) {
      return unavailableHistoricalNpmFact(name, "ERROR", "PACKAGE_IDENTITY_MISMATCH", null)
    }
    return {
      name,
      status: "PRESENT",
      code: null,
      version: pkg.version,
      shasum: pkg.shasum,
      integrity: pkg.integrity,
      latest,
      signatureCount: Array.isArray(pkg.signatures) ? pkg.signatures.length : null,
      provenanceStatus: pkg.provenance?.status ?? "ERROR",
      provenanceWorkflow: pkg.provenance?.status === "PRESENT" ? pkg.provenance.workflow : null,
      provenanceCommitSha: pkg.provenance?.status === "PRESENT" ? pkg.provenance.commitSha : null,
    }
  }
  return unavailableHistoricalNpmFact(
    name,
    ["ABSENT", "AMBIGUOUS", "ERROR"].includes(versionResult.status)
      ? versionResult.status
      : "ERROR",
    safeCode(versionResult.code),
    latest,
  )
}

function unavailableHistoricalNpmFact(name, status, code, latest) {
  return {
    name,
    status,
    code,
    version: null,
    shasum: null,
    integrity: null,
    latest,
    signatureCount: null,
    provenanceStatus: null,
    provenanceWorkflow: null,
    provenanceCommitSha: null,
  }
}

function historicalExpectedPlaceholder(candidate, run) {
  return {
    analysisKind: "historical-audit",
    disposition: "audit-only",
    lastProvenTransition: "LEGACY_NPM_REGISTRY_INCOMPLETE",
    nextSafeTransition: `Collect and independently audit exact npm evidence for v${candidate.version}; do not invoke managed publication.`,
    reasons: ["Live historical facts require pure assessment before reporting."],
    conflicts: ["managed-controller-evidence-unavailable"],
    manualRecoveryInputs: {
      version: candidate.version,
      commitSha: candidate.commitSha,
      tag: `v${candidate.version}`,
      workflowRunId: run.id,
      runAttempt: run.run_attempt,
    },
    proposedMutations: [],
  }
}

function candidateIdentity(version, commitSha) {
  return {
    version,
    commitSha,
    ciWorkflow: "CI",
    ciCheck: "validate",
    publisherWorkflow: ".github/workflows/release.yml",
  }
}

function render(report, format) {
  return format === "json" ? renderReportJson(report) : renderReportMarkdown(report)
}

function safeCode(value) {
  return typeof value === "string" && /^[A-Z][A-Z0-9_-]{0,63}$/u.test(value)
    ? value
    : "REMOTE_FAILURE"
}

function safeMessage(error, fallback) {
  const message = error instanceof Error ? error.message : fallback
  return redactCredentialText(message)
    .replace(/[\r\n\u2028\u2029]+/gu, " ")
    .slice(0, 1_024)
}

const executedPath =
  process.argv[1] === undefined ? null : pathToFileURL(path.resolve(process.argv[1])).href
if (executedPath === import.meta.url) {
  process.exitCode = await runShadowReconcile()
}
