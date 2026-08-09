#!/usr/bin/env node

import { readFile as defaultReadFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"

import { createGitReader as defaultCreateGitReader } from "./adapters/git.mjs"
import { createGitHubReader as defaultCreateGitHubReader } from "./adapters/github.mjs"
import { createNpmReader as defaultCreateNpmReader } from "./adapters/npm.mjs"
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
import { isExactSemver, parseSemver } from "./semver.mjs"

const DEFAULT_REPOSITORY = "cacheplane/dawnai"
const SHA_PATTERN = /^[0-9a-f]{40}$/u
const REPOSITORY_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u
const ARGUMENTS = new Set(["observation", "format", "version", "commit-sha", "repository"])
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
    const options = parseArguments(argv, cwd)
    if (options.observation !== undefined) {
      const readFile = dependencies.readFile ?? defaultReadFile
      const source = await readFile(options.observation, "utf8")
      const fixture = parseReconciliationFixture(source, options.observation)
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
    const result = await npm.observePackageVersion({ name, version: candidate.version })
    npmPackages.push(historicalNpmFact(name, result))
  }
  const runs = await github.listWorkflowRuns({
    workflow: "release.yml",
    commitSha: candidate.commitSha,
  })
  if (runs.status !== "PRESENT" || !Array.isArray(runs.value) || runs.value.length === 0) {
    throw new Error(`Release workflow run evidence is ${String(runs.code ?? runs.status)}`)
  }
  const matching = runs.value
    .filter((run) => run?.head_sha === candidate.commitSha)
    .sort((left, right) => Number(left.id) - Number(right.id))[0]
  if (
    matching === undefined ||
    !Number.isSafeInteger(matching.id) ||
    !Number.isSafeInteger(matching.run_attempt) ||
    matching.run_attempt <= 0
  ) {
    throw new Error("Release workflow run identity is malformed")
  }
  const frozenRun = FROZEN_INCIDENT_RUNS.get(candidate.commitSha)
  if (frozenRun !== undefined && matching.id !== frozenRun.id) {
    throw new Error("Frozen incident workflow run is missing from public history")
  }
  const runIdentity =
    frozenRun === undefined
      ? {
          id: matching.id,
          runAttempt: matching.run_attempt,
          createdAt: matching.created_at,
        }
      : frozenRun
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

function historicalNpmFact(name, result) {
  if (result?.status === "PRESENT") {
    const pkg = result.package
    return {
      name,
      status: "PRESENT",
      code: null,
      version: pkg.version,
      shasum: pkg.shasum,
      integrity: pkg.integrity,
      latest: pkg.latest,
      signatureCount: pkg.signatures.length,
      provenanceStatus: pkg.provenance.status,
      provenanceWorkflow: pkg.provenance.workflow,
      provenanceCommitSha: pkg.provenance.commitSha,
    }
  }
  return {
    name,
    status: ["ABSENT", "AMBIGUOUS", "ERROR"].includes(result?.status) ? result.status : "ERROR",
    code: safeCode(result?.code),
    version: null,
    shasum: null,
    integrity: null,
    latest: null,
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

function parseArguments(argv, cwd) {
  if (!Array.isArray(argv)) throw new CliInputError("Arguments must be an array")
  const values = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (typeof flag !== "string" || !flag.startsWith("--") || value === undefined) {
      throw new CliInputError("Every option requires one value")
    }
    const name = flag.slice(2)
    if (!ARGUMENTS.has(name)) throw new CliInputError(`Unknown option --${name}`)
    if (values.has(name)) throw new CliInputError(`Duplicate option --${name}`)
    values.set(name, value)
  }
  const format = values.get("format")
  if (!["json", "markdown"].includes(format))
    throw new CliInputError("Format must be json or markdown")
  const observation = values.get("observation")
  const version = values.get("version")
  const commitSha = values.get("commit-sha")
  const repository = values.get("repository") ?? DEFAULT_REPOSITORY
  if (!REPOSITORY_PATTERN.test(repository)) throw new CliInputError("Invalid repository")
  if ((version === undefined) !== (commitSha === undefined)) {
    throw new CliInputError("--version and --commit-sha must be supplied together")
  }
  if (observation !== undefined && (version !== undefined || values.has("repository"))) {
    throw new CliInputError("--observation cannot be combined with live options")
  }
  if (version !== undefined && (!isExactSemver(version) || parseSemver(version).build.length > 0)) {
    throw new CliInputError("Version must be an exact SemVer without build metadata")
  }
  if (commitSha !== undefined && !SHA_PATTERN.test(commitSha)) {
    throw new CliInputError("Commit SHA must be 40 lowercase hexadecimal characters")
  }
  return {
    format,
    repository,
    ...(observation === undefined ? {} : { observation: safeFixturePath(observation, cwd) }),
    ...(version === undefined ? {} : { version, commitSha }),
  }
}

function safeFixturePath(value, cwd) {
  if (typeof value !== "string" || value.length === 0 || /[\0\r\n]/u.test(value)) {
    throw new CliInputError("Invalid observation path")
  }
  const resolved = path.resolve(cwd, value)
  const relative = path.relative(cwd, resolved)
  if (
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    path.extname(resolved) !== ".json"
  ) {
    throw new CliInputError("Observation path must be a JSON file inside the repository")
  }
  return resolved
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
  return String(message)
    .replace(/[\r\n]+/gu, " ")
    .replace(/(?:Bearer|token|secret|password)\s*[:=]?\s*\S+/giu, "[REDACTED]")
    .slice(0, 1_024)
}

class CliInputError extends Error {}

const executedPath =
  process.argv[1] === undefined ? null : pathToFileURL(path.resolve(process.argv[1])).href
if (executedPath === import.meta.url) {
  process.exitCode = await runShadowReconcile()
}
