#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto"
import { constants as fsConstants } from "node:fs"
import * as defaultFileSystem from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"

import { parseSmokeResult, REQUIRED_RELEASE_SMOKE_LANES } from "./smoke-result.mjs"

const COMMANDS = Object.freeze({
  abandon: Object.freeze(["version", "commit-sha", "reason", "artifact-context"]),
  "abandonment-context": Object.freeze(["version", "commit-sha", "output"]),
  observe: Object.freeze(["event", "report", "github-output"]),
  tag: Object.freeze(["candidate"]),
  prepare: Object.freeze(["handoff", "root", "output-dir", "candidate-output"]),
  "record-artifact": Object.freeze(["candidate", "manifest", "artifact-upload-result", "output"]),
  "attestation-input": Object.freeze(["record", "artifact-dir", "output"]),
  "attestation-output": Object.freeze([
    "record",
    "artifact-dir",
    "bundle",
    "attestation-set",
    "attestation-bundles-dir",
  ]),
  escrow: Object.freeze([
    "candidate",
    "record",
    "artifact-dir",
    "attestation-set",
    "attestation-bundles-dir",
  ]),
  "reconcile-npm": Object.freeze(["candidate", "record", "manifest", "npm-evidence"]),
  "reconcile-smokes": Object.freeze([
    "candidate",
    "record",
    "manifest",
    "npm-evidence",
    "smoke-results",
  ]),
  "dispatch-audit": Object.freeze(["version", "commit-sha", "manifest-sha256", "output"]),
  "record-audit-dispatch": Object.freeze(["candidate", "dispatch-result"]),
  "wait-audit": Object.freeze(["candidate", "dispatch-result", "output"]),
  "correlate-audit": Object.freeze(["candidate", "dispatch-result", "audit-result"]),
  "publish-release": Object.freeze(["candidate", "record", "audit-result"]),
})
const MAX_JSON_BYTES = 1024 * 1024
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024
const MAX_PATH_BYTES = 4_096
const DECIMAL_ID_PATTERN = /^[1-9][0-9]*$/u
const SHA256_PATTERN = /^[0-9a-f]{64}$/u
const SEMVER_PATTERN =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u

export async function runReleaseCli(argv, dependencies = {}) {
  const parsed = parseArguments(argv)
  const runtime = normalizeDependencies(dependencies)
  if (parsed.command === "abandon") {
    return runAbandon(parsed.options, runtime)
  }
  if (parsed.command === "abandonment-context") {
    return runAbandonmentContext(parsed.options, runtime)
  }
  if (parsed.command === "observe") {
    return runObserve(parsed.options, runtime)
  }
  if (parsed.command === "tag") {
    return runTag(parsed.options, runtime)
  }
  if (parsed.command === "prepare") {
    return runPrepare(parsed.options, runtime)
  }
  if (parsed.command === "record-artifact") {
    return runRecordArtifact(parsed.options, runtime)
  }
  if (parsed.command === "attestation-input") {
    return runAttestationInput(parsed.options, runtime)
  }
  if (parsed.command === "attestation-output") {
    return runAttestationOutput(parsed.options, runtime)
  }
  if (parsed.command === "escrow") {
    return runEscrow(parsed.options, runtime)
  }
  if (parsed.command === "reconcile-npm") {
    return runReconcileNpm(parsed.options, runtime)
  }
  if (parsed.command === "reconcile-smokes") {
    return runReconcileSmokes(parsed.options, runtime)
  }
  if (parsed.command === "dispatch-audit") {
    return runDispatchAudit(parsed.options, runtime)
  }
  if (parsed.command === "record-audit-dispatch") {
    return runRecordAuditDispatch(parsed.options, runtime)
  }
  if (parsed.command === "wait-audit") {
    return runWaitAudit(parsed.options, runtime)
  }
  if (parsed.command === "correlate-audit") {
    return runCorrelateAudit(parsed.options, runtime)
  }
  if (parsed.command === "publish-release") {
    return runPublishRelease(parsed.options, runtime)
  }
  throw new TypeError("Release CLI command is unsupported")
}

async function runAbandonmentContext(options, runtime) {
  const candidate = candidateDocument({
    version: options.version,
    commitSha: options["commit-sha"],
  })
  const outputPath = resolveCliPath(options.output, runtime.cwd)
  const module = await runtime.importModule(
    new URL("./abandonment-handoff.mjs", import.meta.url).href,
  )
  const createContext = moduleFunction(
    module,
    "createAbandonmentArtifactContext",
    "abandonment-context creator",
  )
  const canonicalContextBytes = moduleFunction(
    module,
    "canonicalAbandonmentArtifactContextBytes",
    "abandonment-context encoder",
  )
  const environment = projectEnvironment(runtime.environment, [
    "GITHUB_REPOSITORY",
    "GITHUB_REF",
    "GITHUB_SHA",
    "GITHUB_RUN_ID",
    "GITHUB_RUN_ATTEMPT",
    "GITHUB_WORKFLOW_REF",
  ])
  let context = null
  await writeContainedCanonicalOutput(
    runtime.fileSystem,
    outputPath,
    "abandonment artifact context",
    async () => {
      const [git, github, npm, npmAuditFactory, attestations, marker] = await Promise.all([
        requireProductionGit(runtime),
        requireProductionGitHub(runtime),
        requireNpm(runtime),
        requireNpmAuditFactory(runtime),
        requireAttestations(runtime),
        readControllerMarker(runtime),
      ])
      context = await createContext(
        { candidate, environment },
        {
          root: runtime.cwd,
          git,
          github,
          npm,
          npmAuditFactory,
          attestations,
          marker,
          ...(runtime.inventory === undefined ? {} : { inventory: runtime.inventory }),
        },
      )
      return canonicalContextBytes(context, { candidate })
    },
  )
  if (context === null) {
    throw new Error("Release CLI abandonment artifact context was not created")
  }
  return context
}

async function runAbandon(options, runtime) {
  const candidate = candidateDocument({
    version: options.version,
    commitSha: options["commit-sha"],
  })
  const artifactContext = await readJsonFile(
    runtime.fileSystem,
    resolveCliPath(options["artifact-context"], runtime.cwd),
    MAX_MANIFEST_BYTES,
    "abandonment artifact context",
  )
  const [github, npm, authorityModule, abandonmentModule, manifestModule] = await Promise.all([
    requireGitHub(runtime),
    requireNpm(runtime),
    runtime.importModule(new URL("./abandonment-authority.mjs", import.meta.url).href),
    runtime.importModule(new URL("./abandonment.mjs", import.meta.url).href),
    runtime.importModule(new URL("./manifest.mjs", import.meta.url).href),
  ])
  const capture = moduleFunction(
    authorityModule,
    "captureFreshAbandonmentEvidence",
    "abandonment authority",
  )
  const record = moduleFunction(abandonmentModule, "recordAbandonment", "abandonment recorder")
  const packageOrder = moduleValue(
    manifestModule,
    "CANONICAL_RELEASE_PACKAGE_ORDER",
    "release package inventory",
  )
  if (!Array.isArray(packageOrder)) {
    throw new TypeError("Release CLI abandonment package inventory is invalid")
  }
  const packageNames = Object.freeze([...packageOrder].sort(compareText))
  const authorityEnvironment = projectEnvironment(runtime.environment, [
    "GITHUB_REPOSITORY",
    "GITHUB_REF",
    "GITHUB_SHA",
    "GITHUB_RUN_ID",
    "GITHUB_RUN_ATTEMPT",
    "GITHUB_ACTOR",
    "GITHUB_ACTOR_ID",
  ])
  const authorization = Object.freeze({
    async readFreshAbandonmentEvidence({ candidate: requestedCandidate }) {
      const requested = candidateDocument(requestedCandidate)
      if (requested.version !== candidate.version || requested.commitSha !== candidate.commitSha) {
        throw new Error("Release CLI abandonment authorization candidate changed")
      }
      return capture({
        candidate,
        packageNames,
        environment: authorityEnvironment,
        github: github.reader,
        npm,
        now: runtime.now,
        ...(runtime.wait === undefined ? {} : { wait: runtime.wait }),
      })
    },
  })
  return record({
    candidate,
    reason: options.reason,
    artifactContext,
    authorization,
    github,
  })
}

async function runObserve(options, runtime) {
  const paths = Object.fromEntries(
    Object.entries(options).map(([key, value]) => [key, resolveCliPath(value, runtime.cwd)]),
  )
  await assertObservePathsDistinct(runtime.fileSystem, paths)
  const event = await readJsonFile(
    runtime.fileSystem,
    paths.event,
    MAX_JSON_BYTES,
    "production event",
  )
  const [observeModule, controllerModule, plannerModule] = await Promise.all([
    runtime.importModule(new URL("./observe.mjs", import.meta.url).href),
    runtime.importModule(new URL("./controller.mjs", import.meta.url).href),
    runtime.importModule(new URL("./planner.mjs", import.meta.url).href),
  ])
  const classifyEvent = moduleFunction(
    observeModule,
    "classifyProductionEvent",
    "production event classifier",
  )
  const resolveCandidate = moduleFunction(
    observeModule,
    "resolveProductionCandidate",
    "production candidate resolver",
  )
  const observeCandidate = moduleFunction(
    observeModule,
    "observeProductionCandidate",
    "production observer",
  )
  const createInventoryReader = moduleFunction(
    observeModule,
    "createProductionInventoryReader",
    "production inventory reader factory",
  )
  const runController = moduleFunction(
    controllerModule,
    "runReleaseController",
    "one-transition controller",
  )
  const planRelease = moduleFunction(plannerModule, "planRelease", "release planner")
  classifyEvent(event)

  const [git, github, npm, attestations, marker] = await Promise.all([
    requireProductionGit(runtime),
    requireProductionGitHub(runtime),
    requireNpm(runtime),
    requireAttestations(runtime),
    readControllerMarker(runtime),
  ])
  const inventory = runtime.inventory ?? createInventoryReader({ root: runtime.cwd, git })
  requiredMethod(inventory, "read", "production inventory reader")

  let selection
  let resolutionFailure = null
  let observationDiagnostics = []
  try {
    selection = await resolveCandidate({
      event,
      inventory,
      git,
      github,
      npm,
      attestations,
      marker,
    })
  } catch (error) {
    resolutionFailure = safeObservationFailure(error, "CANDIDATE_DISCOVERY_AMBIGUOUS")
    observationDiagnostics = [
      observationDiagnostic("controller", "candidate-discovery", resolutionFailure.code),
    ]
    selection = {
      candidate: null,
      state: "NO_CANDIDATE",
      disposition: "blocked",
      tag: null,
      conflicts: ["candidate-discovery-ambiguous"],
    }
  }

  let immutableInventory = null
  if (selection.candidate !== null) {
    try {
      immutableInventory = await inventory.read({ ref: selection.candidate.commitSha })
    } catch (error) {
      resolutionFailure = safeObservationFailure(error, "IMMUTABLE_INVENTORY_AMBIGUOUS")
      observationDiagnostics = [
        observationDiagnostic("git", "immutable-inventory", resolutionFailure.code),
      ]
    }
  }
  const npmAuditFactory = await requireNpmAuditFactory(runtime)
  const observer = {
    async observe() {
      if (resolutionFailure !== null || selection.candidate === null) {
        return {
          status: resolutionFailure === null ? "no-candidate" : "ambiguous",
          code: resolutionFailure?.code ?? null,
        }
      }
      try {
        const result = await observeCandidate({
          candidate: selection.candidate,
          inventory: immutableInventory,
          marker,
          git,
          github,
          npm,
          npmAuditFactory,
          attestations,
        })
        observationDiagnostics = normalizeObservationDiagnostics(result.diagnostics)
        return result.observation
      } catch (error) {
        const failure = safeObservationFailure(error, "PRODUCTION_OBSERVATION_AMBIGUOUS")
        observationDiagnostics = [
          observationDiagnostic("controller", "production-observation", failure.code),
        ]
        return { status: "ambiguous", code: failure.code }
      }
    },
  }
  const planner = {
    plan(input) {
      if (
        resolutionFailure !== null ||
        observationDiagnostics.length > 0 ||
        input.observation?.status === "ambiguous"
      ) {
        return blockedObservePlan({
          state: selection.state,
          conflicts: [...selection.conflicts, "production-observation-ambiguous"],
        })
      }
      if (selection.candidate === null) {
        return terminalObservePlan({
          state: "NO_CANDIDATE",
          disposition: "noop",
          reason: "no release candidate was discovered",
        })
      }
      if (selection.disposition === "blocked") {
        return blockedObservePlan({ state: selection.state, conflicts: selection.conflicts })
      }
      if (["audit-only", "noop"].includes(selection.disposition)) {
        return terminalObservePlan({
          state: selection.state,
          disposition: selection.disposition,
          reason: "candidate arbitration does not permit an automatic transition",
        })
      }
      return planRelease(input)
    },
  }
  let emittedReport = null
  const reporter = {
    async write(report) {
      emittedReport = canonicalize(
        snapshotCliData(
          { ...report, diagnostics: observationDiagnostics },
          "production observation report",
        ),
      )
      await assertObservePathsDistinct(runtime.fileSystem, paths)
      await writeCanonicalFile(
        runtime.fileSystem,
        paths.report,
        canonicalJsonBytes(emittedReport),
        "production observation report",
      )
    },
  }
  const controllerReport = await runController({
    candidate: selection.candidate,
    dryRun: true,
    observer,
    planner,
    effects: {},
    reporter,
  })
  if (emittedReport === null) {
    throw new Error("Release CLI production observation report was not emitted")
  }
  await assertObservePathsDistinct(runtime.fileSystem, paths)
  await appendGitHubOutputs(runtime.fileSystem, paths["github-output"], {
    candidate_version: selection.candidate?.version ?? "",
    candidate_sha: selection.candidate?.commitSha ?? "",
    state: controllerReport.before.plan.state,
    disposition: controllerReport.before.plan.disposition,
    next_transition: controllerReport.before.plan.nextTransition ?? "",
  })
  return emittedReport
}

async function assertObservePathsDistinct(fileSystem, paths) {
  if (typeof fileSystem.realpath !== "function" || typeof fileSystem.lstat !== "function") {
    throw new TypeError("Release CLI observe filesystem boundary is invalid")
  }
  const canonicalNames = new Set()
  const inodes = new Set()
  for (const filePath of [paths.event, paths.report, paths["github-output"]]) {
    const parent = await fileSystem.realpath(path.dirname(filePath))
    const canonicalTarget = path.join(parent, path.basename(filePath))
    const canonicalName = canonicalTarget.normalize("NFC").toLowerCase()
    if (canonicalNames.has(canonicalName)) {
      throw new TypeError("Release CLI observe paths must be pairwise distinct")
    }
    canonicalNames.add(canonicalName)
    let metadata = null
    try {
      metadata = await fileSystem.lstat(canonicalTarget)
    } catch (error) {
      if (error?.code !== "ENOENT") throw error
    }
    if (metadata === null) continue
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new TypeError("Release CLI observe paths must be bounded regular-file targets")
    }
    const inode = `${String(metadata.dev)}:${String(metadata.ino)}`
    if (inodes.has(inode)) {
      throw new TypeError("Release CLI observe paths must be pairwise distinct")
    }
    inodes.add(inode)
  }
}

function blockedObservePlan({ state, conflicts }) {
  return {
    state,
    disposition: "blocked",
    nextTransition: null,
    reasons: ["production observation is ambiguous and cannot authorize a transition"],
    conflicts: [...new Set(conflicts)].sort(compareText),
    proposedMutations: [],
  }
}

function terminalObservePlan({ state, disposition, reason }) {
  return {
    state,
    disposition,
    nextTransition: null,
    reasons: [reason],
    conflicts: [],
    proposedMutations: [],
  }
}

async function runEscrow(options, runtime) {
  const [candidate, verified, limitsModule, metadataModule] = await Promise.all([
    readCandidate(runtime, options.candidate),
    readVerifiedArtifact({
      runtime,
      recordPath: options.record,
      artifactDirectory: options["artifact-dir"],
    }),
    runtime.importModule(new URL("./limits.mjs", import.meta.url).href),
    runtime.importModule(new URL("./metadata.mjs", import.meta.url).href),
  ])
  if (
    verified.record.version !== candidate.version ||
    verified.record.commitSha !== candidate.commitSha
  ) {
    throw new Error("Release CLI escrow artifact does not match the candidate")
  }
  const limits = moduleValue(limitsModule, "RELEASE_PAYLOAD_LIMITS", "payload limits")
  if (
    limits === null ||
    typeof limits !== "object" ||
    !Number.isSafeInteger(limits.attestationBundleBytes) ||
    !Number.isSafeInteger(limits.attestationBundlesBytes)
  ) {
    throw new TypeError("Release CLI payload limits module is invalid")
  }
  const maximumBundleBytes = Math.min(
    limits.attestationBundleBytes,
    Math.floor(limits.attestationBundlesBytes / 22),
  )
  const attestationSetBytes = await readRegularFile(
    runtime.fileSystem,
    resolveCliPath(options["attestation-set"], runtime.cwd),
    MAX_JSON_BYTES,
    "attestation set",
  )
  const parseAttestationSet = moduleFunction(
    metadataModule,
    "parseAttestationSet",
    "attestation-set parser",
  )
  const attestationSet = parseAttestationSet(
    parseJsonBytes(attestationSetBytes, "attestation set"),
    {
      candidate,
      manifest: verified.manifest,
      repository: "cacheplane/dawnai",
    },
  )
  if (!Buffer.from(attestationSetBytes).equals(canonicalJsonBytes(attestationSet))) {
    throw new Error("Release CLI attestation set bytes must be canonical")
  }
  const bundleDirectory = resolveCliPath(options["attestation-bundles-dir"], runtime.cwd)
  const pinnedBundles = await openPinnedDirectory(
    runtime.fileSystem,
    bundleDirectory,
    "attestation bundles directory",
  )
  let bundles
  try {
    const expectedNames = attestationSet.subjects.map(({ bundleName }) => bundleName)
    const actualNames = await runtime.fileSystem.readdir(pinnedBundles.readPath)
    if (
      !Array.isArray(actualNames) ||
      actualNames.some((name) => typeof name !== "string") ||
      !arraysEqual(actualNames.slice().sort(compareText), expectedNames.slice().sort(compareText))
    ) {
      throw new Error("Release CLI attestation bundle directory is not the exact 22-file set")
    }
    let totalBytes = 0
    bundles = []
    let anchor = null
    for (const subject of attestationSet.subjects) {
      const bytes = await readRegularFile(
        runtime.fileSystem,
        path.join(pinnedBundles.readPath, subject.bundleName),
        maximumBundleBytes,
        `attestation bundle ${subject.bundleName}`,
      )
      validateAttestationBundleBytes(bytes)
      totalBytes += bytes.byteLength
      if (totalBytes > limits.attestationBundlesBytes) {
        throw new Error("Release CLI attestation bundle set exceeds its shared byte limit")
      }
      if (digest(bytes, "sha256") !== subject.bundleSha256) {
        throw new Error(`Release CLI attestation bundle ${subject.bundleName} digest drifted`)
      }
      if (anchor !== null && !Buffer.from(bytes).equals(anchor)) {
        throw new Error("Release CLI attestation bundle set must replicate one exact bundle")
      }
      anchor ??= Buffer.from(bytes)
      bundles.push({ name: subject.bundleName, bytes: Buffer.from(bytes) })
    }
    await assertPinnedDirectoryUnchanged(
      runtime.fileSystem,
      pinnedBundles,
      "attestation bundles directory",
    )
  } finally {
    await pinnedBundles.handle.close()
  }
  if (!Array.isArray(bundles) || bundles.length !== 22) {
    throw new Error("Release CLI attestation bundle set must contain exactly 22 files")
  }
  const [github, npm, attestations] = await Promise.all([
    requireGitHub(runtime),
    requireNpm(runtime),
    requireAttestations(runtime),
  ])
  const escrow = moduleFunction(metadataModule, "escrowCandidate", "candidate escrow")
  const publicationState = await capturePublicationState({
    candidate,
    manifest: verified.manifest,
    github: github.reader,
    npm,
    now: runtime.now,
    currentRunId: attestationSet.workflowRunId,
    currentRunAttempt: attestationSet.runAttempt,
  })
  return escrow({
    candidate,
    record: verified.record,
    artifact: verified.artifact,
    attestationSet,
    bundles,
    publicationState,
    attestations,
    github,
  })
}

async function runAttestationInput(options, runtime) {
  const verified = await readVerifiedArtifact({
    runtime,
    recordPath: options.record,
    artifactDirectory: options["artifact-dir"],
  })
  const lines = [
    `${verified.record.manifestSha256}  manifest.json`,
    ...verified.manifest.packages.map((pkg) => `${pkg.sha256}  ${pkg.filename}`),
  ]
  if (lines.length !== 22) {
    throw new Error("Release CLI attestation input must contain exactly 22 subjects")
  }
  await writeCanonicalFile(
    runtime.fileSystem,
    resolveCliPath(options.output, runtime.cwd),
    Buffer.from(`${lines.join("\n")}\n`, "utf8"),
    "attestation input",
  )
  return Object.freeze({
    schemaVersion: 1,
    version: verified.record.version,
    commitSha: verified.record.commitSha,
    manifestSha256: verified.record.manifestSha256,
    subjectCount: lines.length,
  })
}

async function runAttestationOutput(options, runtime) {
  const [verified, limitsModule, metadataModule] = await Promise.all([
    readVerifiedArtifact({
      runtime,
      recordPath: options.record,
      artifactDirectory: options["artifact-dir"],
    }),
    runtime.importModule(new URL("./limits.mjs", import.meta.url).href),
    runtime.importModule(new URL("./metadata.mjs", import.meta.url).href),
  ])
  const limits = moduleValue(limitsModule, "RELEASE_PAYLOAD_LIMITS", "payload limits")
  if (
    limits === null ||
    typeof limits !== "object" ||
    !Number.isSafeInteger(limits.attestationBundleBytes) ||
    !Number.isSafeInteger(limits.attestationBundlesBytes)
  ) {
    throw new TypeError("Release CLI payload limits module is invalid")
  }
  const maximumBundleBytes = Math.min(
    limits.attestationBundleBytes,
    Math.floor(limits.attestationBundlesBytes / 22),
  )
  const bundleBytes = await readRegularFile(
    runtime.fileSystem,
    resolveCliPath(options.bundle, runtime.cwd),
    maximumBundleBytes,
    "attestation action bundle",
  )
  validateAttestationBundleBytes(bundleBytes)
  const attestationSetPath = resolveCliPath(options["attestation-set"], runtime.cwd)
  const bundlesDirectory = resolveCliPath(options["attestation-bundles-dir"], runtime.cwd)
  assertAttestationSetOutsideBundleDirectory(attestationSetPath, bundlesDirectory)
  const expectedNames = [
    "manifest.json",
    ...verified.manifest.packages.map(({ filename }) => filename),
  ].map((name) => `${name}.intoto.jsonl`)
  const pinnedBundles = await openPinnedDirectory(
    runtime.fileSystem,
    bundlesDirectory,
    "attestation bundles output directory",
  )
  try {
    await inspectPinnedAttestationOutputDirectory({
      runtime,
      pinned: pinnedBundles,
      expectedNames,
      bundleBytes,
      maximumBundleBytes,
      complete: false,
      unchanged: true,
    })
    const attestations = await requireAttestations(runtime)
    const verifyAnchor = moduleFunction(
      metadataModule,
      "verifyReleaseAttestationAnchor",
      "attestation anchor verifier",
    )
    const verifiedAnchor = await verifyAnchor({
      candidate: verified.candidate,
      record: verified.record,
      artifact: verified.artifact,
      bundleBytes,
      attestations,
    })
    await assertPinnedDirectoryStillCurrent(
      runtime.fileSystem,
      pinnedBundles,
      "attestation bundles output directory",
    )
    if (
      !arraysEqual(
        verifiedAnchor.attestationSet.subjects.map(({ bundleName }) => bundleName),
        expectedNames,
      )
    ) {
      throw new Error("Release CLI verified attestation bundle names are inexact")
    }
    await assertCanonicalOutputReplayable(
      runtime.fileSystem,
      attestationSetPath,
      canonicalJsonBytes(verifiedAnchor.attestationSet),
      MAX_JSON_BYTES,
      "attestation set",
    )
    await materializeAttestationEvidence({
      runtime,
      pinnedBundles,
      attestationSet: verifiedAnchor.attestationSet,
      bundleBytes,
      attestationSetPath,
      bundlesDirectory,
      maximumBundleBytes,
    })
    return verifiedAnchor
  } finally {
    await pinnedBundles.handle.close()
  }
}

async function assertCanonicalOutputReplayable(
  fileSystem,
  filePath,
  expectedBytes,
  maximumBytes,
  label,
) {
  let metadata
  try {
    metadata = await fileSystem.lstat(filePath)
  } catch (error) {
    if (error?.code === "ENOENT") return
    throw error
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
    throw new TypeError(`Release CLI ${label} output must be one regular file`)
  }
  const existing = await readRegularFile(fileSystem, filePath, maximumBytes, label)
  if (!Buffer.from(existing).equals(Buffer.from(expectedBytes))) {
    throw new Error(`Release CLI ${label} output already exists with different bytes`)
  }
}

async function materializeAttestationEvidence({
  runtime,
  pinnedBundles,
  attestationSet,
  bundleBytes,
  attestationSetPath,
  bundlesDirectory,
  maximumBundleBytes,
}) {
  const expectedNames = attestationSet.subjects.map(({ bundleName }) => bundleName)
  for (const bundleName of expectedNames) {
    await assertPinnedDirectoryStillCurrent(
      runtime.fileSystem,
      pinnedBundles,
      "attestation bundles output directory",
    )
    await writeContainedCanonicalOutput(
      runtime.fileSystem,
      path.join(bundlesDirectory, bundleName),
      `attestation bundle ${bundleName}`,
      async () => Buffer.from(bundleBytes),
      maximumBundleBytes,
    )
    await assertPinnedDirectoryStillCurrent(
      runtime.fileSystem,
      pinnedBundles,
      "attestation bundles output directory",
    )
  }
  await inspectPinnedAttestationOutputDirectory({
    runtime,
    pinned: pinnedBundles,
    expectedNames,
    bundleBytes,
    maximumBundleBytes,
    complete: true,
    unchanged: false,
  })
  await writeContainedCanonicalOutput(
    runtime.fileSystem,
    attestationSetPath,
    "attestation set",
    async () => canonicalJsonBytes(attestationSet),
  )
  await assertPinnedDirectoryStillCurrent(
    runtime.fileSystem,
    pinnedBundles,
    "attestation bundles output directory",
  )
}

function assertAttestationSetOutsideBundleDirectory(attestationSetPath, bundlesDirectory) {
  const relativeSetPath = path.relative(bundlesDirectory, attestationSetPath)
  if (
    relativeSetPath === "" ||
    (!relativeSetPath.startsWith(`..${path.sep}`) &&
      relativeSetPath !== ".." &&
      !path.isAbsolute(relativeSetPath))
  ) {
    throw new TypeError("Release CLI attestation set must be outside the bundle directory")
  }
}

async function inspectPinnedAttestationOutputDirectory({
  runtime,
  pinned,
  expectedNames,
  bundleBytes,
  maximumBundleBytes,
  complete,
  unchanged,
}) {
  await assertPinnedDirectoryStillCurrent(
    runtime.fileSystem,
    pinned,
    "attestation bundles output directory",
  )
  const names = await runtime.fileSystem.readdir(pinned.readPath)
  if (
    !Array.isArray(names) ||
    names.some((name) => typeof name !== "string") ||
    names.some((name) => !expectedNames.includes(name)) ||
    (complete &&
      !arraysEqual(names.slice().sort(compareText), expectedNames.slice().sort(compareText)))
  ) {
    throw new Error("Release CLI attestation bundle output directory has an inexact file set")
  }
  for (const name of names) {
    const bytes = await readRegularFile(
      runtime.fileSystem,
      path.join(pinned.readPath, name),
      maximumBundleBytes,
      `existing attestation bundle ${name}`,
    )
    if (!Buffer.from(bytes).equals(Buffer.from(bundleBytes))) {
      throw new Error(`Release CLI existing attestation bundle ${name} conflicts`)
    }
  }
  if (unchanged) {
    await assertPinnedDirectoryUnchanged(
      runtime.fileSystem,
      pinned,
      "attestation bundles output directory",
    )
  } else {
    await assertPinnedDirectoryStillCurrent(
      runtime.fileSystem,
      pinned,
      "attestation bundles output directory",
    )
  }
}

async function readVerifiedArtifact({ runtime, recordPath, artifactDirectory }) {
  const requestedDirectory = resolveCliPath(artifactDirectory, runtime.cwd)
  const pinned = await openPinnedDirectory(
    runtime.fileSystem,
    requestedDirectory,
    "artifact directory",
  )
  const directory = pinned.readPath
  try {
    const [recordBytes, manifestBytes] = await Promise.all([
      readRegularFile(
        runtime.fileSystem,
        resolveCliPath(recordPath, runtime.cwd),
        MAX_JSON_BYTES,
        "release record",
      ),
      readRegularFile(
        runtime.fileSystem,
        path.join(directory, "manifest.json"),
        MAX_MANIFEST_BYTES,
        "manifest",
      ),
    ])
    const recordModule = await runtime.importModule(
      new URL("./release-record.mjs", import.meta.url).href,
    )
    const manifestModule = await runtime.importModule(
      new URL("./manifest.mjs", import.meta.url).href,
    )
    const parseRecord = moduleFunction(recordModule, "parseReleaseRecord", "release-record parser")
    const canonicalRecord = moduleFunction(
      recordModule,
      "canonicalReleaseRecordBytes",
      "release-record encoder",
    )
    const parseManifest = moduleFunction(
      manifestModule,
      "parseSealedReleaseManifest",
      "manifest parser",
    )
    const canonicalManifest = moduleFunction(
      manifestModule,
      "canonicalManifestBytes",
      "manifest encoder",
    )
    const manifestDigest = moduleFunction(manifestModule, "manifestSha256", "manifest digest")
    const record = parseRecord(recordBytes)
    if (!Buffer.from(recordBytes).equals(Buffer.from(canonicalRecord(record)))) {
      throw new Error("Release CLI release record bytes must be canonical")
    }
    const candidate = candidateDocument({ version: record.version, commitSha: record.commitSha })
    const manifest = parseManifest(manifestBytes, { candidate })
    if (
      !Buffer.from(manifestBytes).equals(Buffer.from(canonicalManifest(manifest))) ||
      manifestDigest(manifest) !== record.manifestSha256
    ) {
      throw new Error("Release CLI artifact manifest is noncanonical or conflicts with the record")
    }
    const expectedNames = [
      "manifest.json",
      ...manifest.packages.map(({ filename }) => filename),
    ].sort(compareText)
    const names = await runtime.fileSystem.readdir(directory)
    if (
      !Array.isArray(names) ||
      names.some((name) => typeof name !== "string") ||
      !arraysEqual(names.slice().sort(compareText), expectedNames)
    ) {
      throw new Error("Release CLI artifact directory does not match the sealed manifest")
    }
    const files = [{ name: "manifest.json", bytes: Buffer.from(manifestBytes) }]
    for (const pkg of manifest.packages) {
      const bytes = await readRegularFile(
        runtime.fileSystem,
        path.join(directory, pkg.filename),
        pkg.size,
        `artifact tarball ${pkg.name}`,
      )
      if (
        bytes.byteLength !== pkg.size ||
        digest(bytes, "sha256") !== pkg.sha256 ||
        digest(bytes, "sha512") !== pkg.sha512
      ) {
        throw new Error(`Release CLI artifact tarball ${pkg.name} does not match the manifest`)
      }
      files.push({ name: pkg.filename, bytes })
    }
    await assertPinnedDirectoryUnchanged(runtime.fileSystem, pinned, "artifact directory")
    return Object.freeze({ record, candidate, manifest, artifact: { manifest, files } })
  } finally {
    await pinned.handle.close()
  }
}

function validateAttestationBundleBytes(bytes) {
  let source
  let value
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    if (!source.endsWith("\n") || source.endsWith("\n\n") || source.includes("\r")) {
      throw new TypeError("Attestation bundle must have one LF terminator")
    }
    value = JSON.parse(source)
  } catch (error) {
    throw new TypeError("Release CLI attestation bundle is not one UTF-8 JSON object", {
      cause: error,
    })
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Release CLI attestation bundle is not one JSON object")
  }
}

async function capturePublicationState({
  candidate,
  manifest,
  github,
  npm,
  now,
  currentRunId,
  currentRunAttempt,
}) {
  const listWorkflowRuns = requiredMethod(github, "listWorkflowRuns", "GitHub reader")
  const listActionsRunJobs = requiredMethod(github, "listActionsRunJobs", "GitHub reader")
  const observePackageVersion = requiredMethod(npm, "observePackageVersion", "npm reader")
  const runs = await readPresentValue(
    listWorkflowRuns({ workflow: "release.yml", commitSha: candidate.commitSha }),
    "workflow-runs",
  )
  if (!Array.isArray(runs) || runs.length < 1 || runs.length > 100) {
    throw new Error("Release CLI candidate Actions history is empty or exceeds its bound")
  }
  const normalizedRuns = runs.map((run) => normalizeCandidateRun(run, candidate))
  normalizedRuns.sort((left, right) => left.runId - right.runId)
  if (new Set(normalizedRuns.map(({ runId }) => runId)).size !== normalizedRuns.length) {
    throw new Error("Release CLI candidate Actions history contains duplicate run IDs")
  }
  const withJobs = await Promise.all(
    normalizedRuns.map(async (run) => ({
      ...run,
      jobs: normalizeCandidateJobs(
        await readPresentValue(listActionsRunJobs({ runId: run.runId }), "actions-run-jobs"),
        run.runAttempt,
      ),
    })),
  )
  const candidateRuns = []
  for (const run of withJobs) {
    const publishStarted = run.jobs.some(publisherJobExecuted)
    if (publishStarted) {
      throw new Error("Release CLI publication history shows that publish-npm already started")
    }
    if (run.headBranch !== `v${candidate.version}`) continue
    candidateRuns.push(run)
  }
  if (
    !candidateRuns.some(
      (run) =>
        run.runId === currentRunId &&
        run.runAttempt === currentRunAttempt &&
        run.headBranch === `v${candidate.version}`,
    )
  ) {
    throw new Error("Release CLI publication history does not contain the current tagged run")
  }
  const packages = await Promise.all(
    manifest.packages.map(async (pkg) => {
      const result = snapshotCliData(
        await observePackageVersion({ name: pkg.name, version: candidate.version }),
        "npm package observation",
      )
      if (
        !hasExactDataFields(result, ["status", "operation", "httpStatus", "code"]) ||
        result.status !== "ABSENT" ||
        result.operation !== "package-version" ||
        result.httpStatus !== 404 ||
        result.code !== "E404"
      ) {
        throw new Error(`Release CLI package ${pkg.name} is not proven absent by exact E404`)
      }
      return {
        name: pkg.name,
        version: candidate.version,
        status: "ABSENT",
        httpStatus: 404,
        observedAt: timestamp(now),
      }
    }),
  )
  return Object.freeze({
    schemaVersion: 1,
    version: candidate.version,
    commitSha: candidate.commitSha,
    tag: `v${candidate.version}`,
    observedAt: timestamp(now),
    candidateRuns,
    registryMutationReceipts: [],
    packages,
  })
}

function normalizeCandidateRun(value, candidate) {
  const run = snapshotCliData(value, "candidate Actions run")
  const runId = dataValue(run, "id", "candidate Actions run")
  const runAttempt = dataValue(run, "run_attempt", "candidate Actions run")
  const headSha = dataValue(run, "head_sha", "candidate Actions run")
  const headBranch = dataValue(run, "head_branch", "candidate Actions run")
  const workflowPath = dataValue(run, "path", "candidate Actions run")
  const event = dataValue(run, "event", "candidate Actions run")
  if (
    !Number.isSafeInteger(runId) ||
    runId < 1 ||
    !Number.isSafeInteger(runAttempt) ||
    runAttempt < 1 ||
    headSha !== candidate.commitSha ||
    typeof headBranch !== "string" ||
    headBranch.length === 0 ||
    workflowPath !== ".github/workflows/release.yml" ||
    !["push", "workflow_dispatch", "schedule"].includes(event)
  ) {
    throw new Error("Release CLI candidate Actions run identity is invalid")
  }
  return { runId, runAttempt, headSha, headBranch, workflowPath, event }
}

function normalizeCandidateJobs(value, currentAttempt) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 10_000) {
    throw new Error("Release CLI candidate job history is empty or exceeds its bound")
  }
  const jobs = value.map((entry) => {
    const job = snapshotCliData(entry, "candidate Actions job")
    if (
      !hasExactDataFields(job, [
        "id",
        "runAttempt",
        "name",
        "status",
        "conclusion",
        "startedAt",
        "completedAt",
      ]) ||
      !Number.isSafeInteger(job.id) ||
      job.id < 1 ||
      !Number.isSafeInteger(job.runAttempt) ||
      job.runAttempt < 1 ||
      job.runAttempt > currentAttempt ||
      typeof job.name !== "string" ||
      job.name.length === 0 ||
      typeof job.status !== "string" ||
      job.status.length === 0 ||
      !(job.conclusion === null || typeof job.conclusion === "string") ||
      !isNullableTimestamp(job.startedAt) ||
      !isNullableTimestamp(job.completedAt)
    ) {
      throw new Error("Release CLI candidate job history is malformed")
    }
    const terminal = job.status === "completed"
    if (
      terminal !== (job.conclusion !== null) ||
      terminal !== (job.completedAt !== null) ||
      (job.completedAt !== null && job.startedAt === null)
    ) {
      throw new Error("Release CLI candidate job terminal evidence is incoherent")
    }
    return job
  })
  jobs.sort((left, right) => left.runAttempt - right.runAttempt || left.id - right.id)
  return jobs
}

function publisherJobExecuted(job) {
  if (job.name !== "publish-npm") return false
  if (job.status === "completed" && job.conclusion === "skipped") return false
  return job.startedAt !== null
}

async function runReconcileNpm(options, runtime) {
  const github = await requireGitHub(runtime)
  const { candidate, record, manifest, npmEvidence } = await readReconciliationInputs(
    options,
    runtime,
  )
  const module = await runtime.importModule(new URL("./metadata.mjs", import.meta.url).href)
  return moduleFunction(
    module,
    "reconcileNpmEvidence",
    "npm evidence reconciliation",
  )({
    candidate,
    record,
    manifest,
    npmEvidence,
    github,
  })
}

async function runReconcileSmokes(options, runtime) {
  const github = await requireGitHub(runtime)
  const workflowRunId = environmentPositiveInteger(runtime.environment, "GITHUB_RUN_ID")
  const runAttempt = environmentPositiveInteger(runtime.environment, "GITHUB_RUN_ATTEMPT")
  const [{ candidate, record, manifest, npmEvidence }, smokeResults] = await Promise.all([
    readReconciliationInputs(options, runtime),
    readSmokeResults(runtime, options["smoke-results"]),
  ])
  const module = await runtime.importModule(new URL("./metadata.mjs", import.meta.url).href)
  return moduleFunction(
    module,
    "reconcileSmokeEvidence",
    "smoke evidence reconciliation",
  )({
    candidate,
    record,
    manifest,
    npmEvidence,
    smokeResults,
    workflowRunId,
    runAttempt,
    github,
  })
}

async function readReconciliationInputs(options, runtime) {
  const candidate = await readCandidate(runtime, options.candidate)
  const [record, manifestBytes, npmEvidence] = await Promise.all([
    readJsonFile(
      runtime.fileSystem,
      resolveCliPath(options.record, runtime.cwd),
      MAX_JSON_BYTES,
      "release record",
    ),
    readRegularFile(
      runtime.fileSystem,
      resolveCliPath(options.manifest, runtime.cwd),
      MAX_MANIFEST_BYTES,
      "manifest",
    ),
    readJsonFile(
      runtime.fileSystem,
      resolveCliPath(options["npm-evidence"], runtime.cwd),
      MAX_MANIFEST_BYTES,
      "npm evidence",
    ),
  ])
  const module = await runtime.importModule(new URL("./manifest.mjs", import.meta.url).href)
  const manifest = moduleFunction(
    module,
    "parseSealedReleaseManifest",
    "manifest parser",
  )(manifestBytes, { candidate })
  return Object.freeze({ candidate, record, manifest, npmEvidence })
}

async function readSmokeResults(runtime, value) {
  const directory = resolveCliPath(value, runtime.cwd)
  const pinned = await openPinnedDirectory(runtime.fileSystem, directory, "smoke results")
  try {
    const entries = await runtime.fileSystem.readdir(pinned.readPath, { withFileTypes: true })
    if (!Array.isArray(entries) || entries.length !== REQUIRED_RELEASE_SMOKE_LANES.length) {
      throw new TypeError(
        "Release CLI smoke result directory must contain the exact required lanes",
      )
    }
    const names = entries.map((entry) => {
      if (
        entry === null ||
        typeof entry !== "object" ||
        typeof entry.name !== "string" ||
        entry.name.length === 0 ||
        entry.name.includes("/") ||
        entry.name.includes("\\") ||
        entry.name.includes("\0") ||
        !entry.name.endsWith(".json") ||
        typeof entry.isFile !== "function" ||
        !entry.isFile() ||
        (typeof entry.isSymbolicLink === "function" && entry.isSymbolicLink())
      ) {
        throw new TypeError("Release CLI smoke result directory contains an invalid entry")
      }
      return entry.name
    })
    names.sort(compareText)
    if (new Set(names).size !== names.length) {
      throw new TypeError("Release CLI smoke result directory contains duplicate entries")
    }
    const expectedNames = REQUIRED_RELEASE_SMOKE_LANES.map((lane) => `${lane}.json`)
    if (!arraysEqual(names, expectedNames)) {
      throw new TypeError(
        "Release CLI smoke result directory does not match the exact required lanes",
      )
    }
    const results = await Promise.all(
      names.map(async (name, index) => {
        const bytes = await readRegularFile(
          runtime.fileSystem,
          path.join(pinned.readPath, name),
          MAX_JSON_BYTES,
          `smoke result ${name}`,
        )
        const result = parseSmokeResult(bytes)
        if (result.lane !== REQUIRED_RELEASE_SMOKE_LANES[index]) {
          throw new Error(`Release CLI smoke result ${name} does not match its required lane`)
        }
        return Buffer.from(bytes)
      }),
    )
    await assertPinnedDirectoryUnchanged(runtime.fileSystem, pinned, "smoke result directory")
    return Object.freeze(results)
  } finally {
    await pinned.handle.close()
  }
}

async function runDispatchAudit(options, runtime) {
  const github = await requireGitHub(runtime)
  const module = await runtime.importModule(new URL("./audit.mjs", import.meta.url).href)
  const dispatch = moduleFunction(module, "dispatchIndependentAudit", "audit dispatch")
  const candidate = candidateDocument({
    version: options.version,
    commitSha: options["commit-sha"],
  })
  const receipt = await dispatch({
    candidate,
    manifestSha256: options["manifest-sha256"],
    github: github.writer,
  })
  await writeCanonicalFile(
    runtime.fileSystem,
    resolveCliPath(options.output, runtime.cwd),
    canonicalJsonBytes(receipt),
    "audit dispatch receipt",
  )
  return receipt
}

async function runRecordAuditDispatch(options, runtime) {
  const github = await requireGitHub(runtime)
  const [candidate, dispatch] = await Promise.all([
    readCandidate(runtime, options.candidate),
    readJsonFile(
      runtime.fileSystem,
      resolveCliPath(options["dispatch-result"], runtime.cwd),
      MAX_JSON_BYTES,
      "audit dispatch result",
    ),
  ])
  const module = await runtime.importModule(new URL("./audit.mjs", import.meta.url).href)
  return moduleFunction(
    module,
    "recordAuditDispatch",
    "audit dispatch recording",
  )({
    candidate,
    dispatch,
    github,
  })
}

async function runWaitAudit(options, runtime) {
  const github = await requireGitHub(runtime)
  const [candidate, dispatch] = await Promise.all([
    readCandidate(runtime, options.candidate),
    readJsonFile(
      runtime.fileSystem,
      resolveCliPath(options["dispatch-result"], runtime.cwd),
      MAX_JSON_BYTES,
      "audit dispatch result",
    ),
  ])
  const runId = auditDispatchRunId(dispatch)
  const module = await runtime.importModule(new URL("./audit.mjs", import.meta.url).href)
  const observed = await moduleFunction(
    module,
    "waitForAudit",
    "audit wait",
  )({
    runId,
    candidate,
    github: github.reader,
    attempts: 181,
    delayMs: 10_000,
    delay: runtime.wait ?? defaultWait,
    now: runtime.now,
  })
  if (observed?.status !== "terminal" || observed.workflowRunId !== runId) {
    const error = new Error("Independent audit did not reach a terminal state within its deadline")
    Object.defineProperty(error, "code", { value: "AUDIT_PENDING", enumerable: true })
    throw error
  }
  const terminalModule = await runtime.importModule(
    new URL("./terminal-records.mjs", import.meta.url).href,
  )
  const result = moduleFunction(
    terminalModule,
    "parseAuditResult",
    "audit-result parser",
  )(observed.result)
  if (
    result.version !== candidate.version ||
    result.commitSha !== candidate.commitSha ||
    result.workflowRunId !== runId ||
    observed.runAttempt !== result.runAttempt ||
    observed.conclusion !== result.conclusion
  ) {
    throw new Error("Independent audit terminal result does not match its exact run and candidate")
  }
  const bytes = moduleFunction(
    terminalModule,
    "canonicalAuditResultBytes",
    "audit-result canonicalizer",
  )(result)
  await writeCanonicalFile(
    runtime.fileSystem,
    resolveCliPath(options.output, runtime.cwd),
    bytes,
    "audit result",
  )
  return result
}

async function runCorrelateAudit(options, runtime) {
  const github = await requireGitHub(runtime)
  const [candidate, dispatch, auditResult] = await Promise.all([
    readCandidate(runtime, options.candidate),
    readJsonFile(
      runtime.fileSystem,
      resolveCliPath(options["dispatch-result"], runtime.cwd),
      MAX_JSON_BYTES,
      "audit dispatch result",
    ),
    readJsonFile(
      runtime.fileSystem,
      resolveCliPath(options["audit-result"], runtime.cwd),
      MAX_JSON_BYTES,
      "audit result",
    ),
  ])
  const auditModule = await runtime.importModule(new URL("./audit.mjs", import.meta.url).href)
  const terminalModule = await runtime.importModule(
    new URL("./terminal-records.mjs", import.meta.url).href,
  )
  const result = moduleFunction(
    terminalModule,
    "parseAuditResult",
    "audit-result parser",
  )(auditResult)
  const recorded = await moduleFunction(
    auditModule,
    "recordAuditAttempt",
    "audit attempt recording",
  )({ candidate, dispatch, result, github })
  if (result.conclusion !== "success") return recorded
  return moduleFunction(
    auditModule,
    "verifyAuditSuccess",
    "audit success verification",
  )({
    candidate,
    dispatch,
    result,
    github,
  })
}

async function runPublishRelease(options, runtime) {
  const github = await requireGitHub(runtime)
  const [candidate, record, auditResult] = await Promise.all([
    readCandidate(runtime, options.candidate),
    readJsonFile(
      runtime.fileSystem,
      resolveCliPath(options.record, runtime.cwd),
      MAX_JSON_BYTES,
      "release record",
    ),
    readJsonFile(
      runtime.fileSystem,
      resolveCliPath(options["audit-result"], runtime.cwd),
      MAX_JSON_BYTES,
      "audit result",
    ),
  ])
  const module = await runtime.importModule(new URL("./metadata.mjs", import.meta.url).href)
  return moduleFunction(
    module,
    "publishConsolidatedRelease",
    "Release publication",
  )({
    candidate,
    record,
    auditResult,
    github,
  })
}

async function runTag(options, runtime) {
  const candidate = await readCandidate(runtime, options.candidate)
  const module = await runtime.importModule(
    new URL("./adapters/git-write.mjs", import.meta.url).href,
  )
  const createWriter = moduleFunction(module, "createCandidateTagWriter", "candidate tag writer")
  const writer = createWriter({ root: runtime.cwd })
  const createAnnotatedTag = moduleFunction(
    writer,
    "createAnnotatedTag",
    "candidate tag creation",
  ).bind(writer)
  const pushTag = moduleFunction(writer, "pushTag", "candidate tag push").bind(writer)
  const tag = `v${candidate.version}`
  const created = await createAnnotatedTag({
    tag,
    sha: candidate.commitSha,
    message: `Dawn release ${tag}`,
  })
  const pushed = await pushTag({ tag })
  return Object.freeze({ tag, commitSha: candidate.commitSha, created, pushed })
}

async function runPrepare(options, runtime) {
  const handoffBytes = await readRegularFile(
    runtime.fileSystem,
    resolveCliPath(options.handoff, runtime.cwd),
    MAX_JSON_BYTES,
    "preparation handoff",
  )
  const [handoffModule, prepareModule] = await Promise.all([
    runtime.importModule(new URL("./workflow-handoff.mjs", import.meta.url).href),
    runtime.importModule(new URL("./prepare.mjs", import.meta.url).href),
  ])
  const parseHandoff = moduleFunction(
    handoffModule,
    "parsePreparationHandoff",
    "preparation handoff parser",
  )
  const handoff = parseHandoff(handoffBytes)
  const candidate = candidateDocument(handoff.candidate)
  const prepare = moduleFunction(prepareModule, "prepareReleaseArtifacts", "release preparation")
  await writeContainedCanonicalOutput(
    runtime.fileSystem,
    resolveCliPath(options["candidate-output"], runtime.cwd),
    "candidate",
    async () => canonicalJsonBytes(candidate),
  )
  return prepare({
    candidate,
    inventory: handoff.inventory,
    root: resolveCliPath(options.root, runtime.cwd),
    outputDir: resolveCliPath(options["output-dir"], runtime.cwd),
    ci: handoff.ciReceipt,
    prepareRun: handoff.prepareRun,
    preparationAuthority: handoff.preparationAuthority,
    sourceRef: handoff.sourceRef,
  })
}

async function runRecordArtifact(options, runtime) {
  const paths = Object.fromEntries(
    Object.entries(options).map(([key, value]) => [key, resolveCliPath(value, runtime.cwd)]),
  )
  const candidate = candidateDocument(
    await readJsonFile(runtime.fileSystem, paths.candidate, MAX_JSON_BYTES, "candidate"),
  )
  const manifestBytes = await readRegularFile(
    runtime.fileSystem,
    paths.manifest,
    MAX_MANIFEST_BYTES,
    "manifest",
  )
  const upload = await readJsonFile(
    runtime.fileSystem,
    paths["artifact-upload-result"],
    MAX_JSON_BYTES,
    "artifact upload result",
  )

  const manifestModule = await runtime.importModule(new URL("./manifest.mjs", import.meta.url).href)
  const recordModule = await runtime.importModule(
    new URL("./release-record.mjs", import.meta.url).href,
  )
  const parseManifest = moduleFunction(
    manifestModule,
    "parseSealedReleaseManifest",
    "manifest parser",
  )
  const manifestDigest = moduleFunction(manifestModule, "manifestSha256", "manifest digest")
  const createRecord = moduleFunction(recordModule, "createReleaseRecord", "release-record creator")
  const canonicalRecordBytes = moduleFunction(
    recordModule,
    "canonicalReleaseRecordBytes",
    "release-record encoder",
  )

  const manifest = parseManifest(manifestBytes, { candidate })
  const receipt = normalizeArtifactUpload(upload, manifest)
  const record = createRecord({
    candidate,
    manifestSha256: manifestDigest(manifest),
    artifact: { name: manifest.artifact.name },
    artifactUpload: { id: receipt.artifactId, digest: receipt.artifactDigest },
    prepareRun: {
      id: manifest.artifact.prepareRunId,
      attempt: manifest.artifact.prepareRunAttempt,
    },
  })
  await writeCanonicalFile(
    runtime.fileSystem,
    paths.output,
    canonicalRecordBytes(record),
    "release record",
  )
  return record
}

function parseArguments(argv) {
  if (!Array.isArray(argv) || argv.length === 0 || typeof argv[0] !== "string") {
    throw usageError()
  }
  const command = argv[0]
  const fields = COMMANDS[command]
  if (fields === undefined) throw usageError()
  if ((argv.length - 1) % 2 !== 0) throw usageError()
  const options = Object.create(null)
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (
      typeof flag !== "string" ||
      typeof value !== "string" ||
      !flag.startsWith("--") ||
      value.length === 0
    ) {
      throw usageError()
    }
    const name = flag.slice(2)
    if (!fields.includes(name) || Object.hasOwn(options, name)) throw usageError()
    options[name] = value
  }
  if (Object.keys(options).length !== fields.length || fields.some((field) => !options[field])) {
    throw usageError()
  }
  return { command, options: Object.freeze(options) }
}

function normalizeDependencies(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Release CLI dependencies are invalid")
  }
  const cwd = value.cwd ?? process.cwd()
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) {
    throw new TypeError("Release CLI working directory must be absolute")
  }
  const importModule = value.importModule ?? ((specifier) => import(specifier))
  if (typeof importModule !== "function") {
    throw new TypeError("Release CLI module loader is invalid")
  }
  const fileSystem = value.fileSystem ?? defaultFileSystem
  for (const method of ["lstat", "open", "readdir", "writeFile"]) {
    if (typeof fileSystem?.[method] !== "function") {
      throw new TypeError(`Release CLI filesystem method ${method} is invalid`)
    }
  }
  const githubDescriptor = Object.getOwnPropertyDescriptor(value, "github")
  if (
    githubDescriptor !== undefined &&
    (!("value" in githubDescriptor) || !githubDescriptor.enumerable)
  ) {
    throw new TypeError("Release CLI GitHub boundary is invalid")
  }
  const environmentDescriptor = Object.getOwnPropertyDescriptor(value, "environment")
  if (
    environmentDescriptor !== undefined &&
    (!("value" in environmentDescriptor) || !environmentDescriptor.enumerable)
  ) {
    throw new TypeError("Release CLI environment boundary is invalid")
  }
  const environment = environmentDescriptor?.value ?? process.env
  if (environment === null || typeof environment !== "object" || Array.isArray(environment)) {
    throw new TypeError("Release CLI environment boundary is invalid")
  }
  const environmentSnapshot = snapshotEnvironment(environment)
  const npm = optionalDataDependency(value, "npm", "npm reader")
  const attestations = optionalDataDependency(value, "attestations", "attestation verifier")
  const git = optionalDataDependency(value, "git", "Git reader")
  const inventory = optionalDataDependency(value, "inventory", "production inventory reader")
  const githubReader = optionalDataDependency(value, "githubReader", "GitHub reader")
  const npmAuditFactory = optionalDataDependency(
    value,
    "npmAuditFactory",
    "npm audit verifier factory",
  )
  const controllerMarker = optionalDataDependency(value, "controllerMarker", "controller marker")
  const now = optionalDataDependency(value, "now", "clock") ?? Date.now
  const wait = optionalDataDependency(value, "wait", "waiter")
  if (typeof now !== "function") throw new TypeError("Release CLI clock is invalid")
  if (wait !== undefined && typeof wait !== "function") {
    throw new TypeError("Release CLI waiter is invalid")
  }
  return Object.freeze({
    cwd,
    importModule,
    fileSystem,
    github: githubDescriptor?.value,
    githubToken: environmentSnapshot.GITHUB_TOKEN,
    environment: environmentSnapshot,
    npm,
    attestations,
    git,
    inventory,
    githubReader,
    npmAuditFactory,
    controllerMarker,
    now,
    wait,
  })
}

function snapshotEnvironment(environment) {
  const result = Object.create(null)
  for (const name of [
    "GITHUB_TOKEN",
    "GITHUB_REPOSITORY",
    "GITHUB_REF",
    "GITHUB_SHA",
    "GITHUB_RUN_ID",
    "GITHUB_RUN_ATTEMPT",
    "GITHUB_ACTOR",
    "GITHUB_ACTOR_ID",
    "GITHUB_WORKFLOW_REF",
  ]) {
    const descriptor = Object.getOwnPropertyDescriptor(environment, name)
    if (descriptor === undefined) continue
    if (!("value" in descriptor) || typeof descriptor.value !== "string") {
      throw new TypeError(`Release CLI environment ${name} must be a string data property`)
    }
    result[name] = descriptor.value
  }
  return Object.freeze(result)
}

function projectEnvironment(environment, names) {
  const result = Object.create(null)
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(environment, name)
    if (descriptor === undefined) continue
    if (!("value" in descriptor) || typeof descriptor.value !== "string") {
      throw new TypeError(`Release CLI environment ${name} must be a string data property`)
    }
    result[name] = descriptor.value
  }
  return Object.freeze(result)
}

function environmentPositiveInteger(environment, name) {
  const value = environment[name]
  if (typeof value !== "string" || !DECIMAL_ID_PATTERN.test(value)) {
    throw new TypeError(`Release CLI ${name} must be a positive decimal integer`)
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new TypeError(`Release CLI ${name} must be a safe positive integer`)
  }
  return parsed
}

function optionalDataDependency(value, name, label) {
  const descriptor = Object.getOwnPropertyDescriptor(value, name)
  if (descriptor === undefined) return undefined
  if (!("value" in descriptor) || !descriptor.enumerable) {
    throw new TypeError(`Release CLI ${label} dependency is invalid`)
  }
  return descriptor.value
}

async function readCandidate(runtime, value) {
  const candidate = await readJsonFile(
    runtime.fileSystem,
    resolveCliPath(value, runtime.cwd),
    MAX_JSON_BYTES,
    "candidate",
  )
  return candidateDocument(candidate)
}

function candidateDocument(value) {
  const candidate =
    Object.keys(value).length === 2
      ? {
          version: value.version,
          commitSha: value.commitSha,
          ciWorkflow: "CI",
          ciCheck: "validate",
          publisherWorkflow: ".github/workflows/release.yml",
        }
      : value
  const fields = ["version", "commitSha", "ciWorkflow", "ciCheck", "publisherWorkflow"]
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    Array.isArray(candidate) ||
    Object.keys(candidate).length !== fields.length ||
    !fields.every((field) => Object.hasOwn(candidate, field)) ||
    typeof candidate.version !== "string" ||
    !isExactSemver(candidate.version) ||
    typeof candidate.commitSha !== "string" ||
    !/^[0-9a-f]{40}$/u.test(candidate.commitSha) ||
    candidate.ciWorkflow !== "CI" ||
    candidate.ciCheck !== "validate" ||
    candidate.publisherWorkflow !== ".github/workflows/release.yml"
  ) {
    throw new TypeError("Release CLI candidate has an invalid exact-key identity")
  }
  return Object.freeze({ ...candidate })
}

function auditDispatchRunId(value) {
  const fields = ["workflow", "workflowRunId", "runUrl", "htmlUrl"]
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== fields.length ||
    !fields.every((field) => Object.hasOwn(value, field)) ||
    value.workflow !== ".github/workflows/published-artifact-verify.yml" ||
    !Number.isSafeInteger(value.workflowRunId) ||
    value.workflowRunId < 1 ||
    value.runUrl !==
      `https://api.github.com/repos/cacheplane/dawnai/actions/runs/${value.workflowRunId}` ||
    value.htmlUrl !== `https://github.com/cacheplane/dawnai/actions/runs/${value.workflowRunId}`
  ) {
    throw new TypeError("Release CLI audit dispatch result is invalid")
  }
  return value.workflowRunId
}

function defaultWait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function isExactSemver(value) {
  const match = typeof value === "string" ? SEMVER_PATTERN.exec(value) : null
  return (
    match !== null &&
    !(match[4]?.split(".") ?? []).some(
      (identifier) => /^[0-9]+$/u.test(identifier) && /^0[0-9]+$/u.test(identifier),
    )
  )
}

async function requireGitHub(runtime) {
  if (runtime.github !== undefined) return validateGitHubBoundary(runtime.github)
  const token = runtime.githubToken
  if (
    typeof token !== "string" ||
    token.length === 0 ||
    token.length > 4_096 ||
    /[\r\n]/u.test(token)
  ) {
    throw new TypeError("Release CLI command requires GITHUB_TOKEN")
  }
  const readerModule = await runtime.importModule(
    new URL("./adapters/github.mjs", import.meta.url).href,
  )
  const writerModule = await runtime.importModule(
    new URL("./adapters/github-write.mjs", import.meta.url).href,
  )
  const reader = moduleFunction(
    readerModule,
    "createGitHubReader",
    "GitHub reader factory",
  )({
    owner: "cacheplane",
    repo: "dawnai",
    token,
  })
  const writer = moduleFunction(
    writerModule,
    "createGitHubWriter",
    "GitHub writer factory",
  )({
    owner: "cacheplane",
    repo: "dawnai",
    token,
    reader,
  })
  return validateGitHubBoundary(
    moduleFunction(
      writerModule,
      "composeGitHubEffects",
      "GitHub effect composer",
    )({
      reader,
      writer,
    }),
  )
}

async function requireProductionGit(runtime) {
  if (runtime.git !== undefined) return runtime.git
  const module = await runtime.importModule(new URL("./adapters/git.mjs", import.meta.url).href)
  return moduleFunction(module, "createGitReader", "Git reader factory")({ root: runtime.cwd })
}

async function requireProductionGitHub(runtime) {
  if (runtime.githubReader !== undefined && runtime.github !== undefined) {
    throw new TypeError("Release CLI observe GitHub reader boundary is ambiguous")
  }
  if (runtime.githubReader !== undefined) return runtime.githubReader
  if (runtime.github !== undefined) {
    if (
      runtime.github === null ||
      typeof runtime.github !== "object" ||
      Array.isArray(runtime.github) ||
      runtime.github.reader === null ||
      typeof runtime.github.reader !== "object" ||
      Array.isArray(runtime.github.reader)
    ) {
      throw new TypeError("Release CLI observe requires a valid GitHub reader")
    }
    return runtime.github.reader
  }
  const token = runtime.githubToken
  if (
    typeof token !== "string" ||
    token.length === 0 ||
    token.length > 4_096 ||
    /[\r\n]/u.test(token)
  ) {
    throw new TypeError("Release CLI observe requires GITHUB_TOKEN")
  }
  const module = await runtime.importModule(new URL("./adapters/github.mjs", import.meta.url).href)
  return moduleFunction(
    module,
    "createGitHubReader",
    "GitHub reader factory",
  )({
    owner: "cacheplane",
    repo: "dawnai",
    token,
  })
}

async function readControllerMarker(runtime) {
  if (runtime.controllerMarker !== undefined) return runtime.controllerMarker
  return readJsonFile(
    runtime.fileSystem,
    path.join(runtime.cwd, "scripts/release/controller-schema.json"),
    MAX_JSON_BYTES,
    "controller marker",
  )
}

async function requireNpmAuditFactory(runtime) {
  if (runtime.npmAuditFactory !== undefined) {
    requiredMethod(runtime.npmAuditFactory, "create", "npm audit verifier factory")
    return runtime.npmAuditFactory
  }
  const [auditModule, runnerModule] = await Promise.all([
    runtime.importModule(new URL("./npm-audit.mjs", import.meta.url).href),
    runtime.importModule(new URL("./process-runner.mjs", import.meta.url).href),
  ])
  const createVerifier = moduleFunction(
    auditModule,
    "createNpmAuditVerifier",
    "npm audit verifier factory",
  )
  const createRunner = moduleFunction(
    runnerModule,
    "createReleasePreparationRunner",
    "bounded process runner factory",
  )
  return Object.freeze({
    create() {
      return createVerifier({
        runNpm: createRunner(),
        environment: process.env,
        signal: new AbortController().signal,
      })
    },
  })
}

async function requireNpm(runtime) {
  if (runtime.npm !== undefined) {
    requiredMethod(runtime.npm, "observePackageVersion", "npm reader")
    return runtime.npm
  }
  const module = await runtime.importModule(new URL("./adapters/npm.mjs", import.meta.url).href)
  return moduleFunction(module, "createNpmReader", "npm reader factory")()
}

async function requireAttestations(runtime) {
  if (runtime.attestations !== undefined) {
    requiredMethod(runtime.attestations, "verify", "attestation verifier")
    return runtime.attestations
  }
  const token = runtime.githubToken
  if (typeof token !== "string" || token.length === 0 || /[\r\n]/u.test(token)) {
    throw new TypeError("Release CLI attestation verification requires GITHUB_TOKEN")
  }
  if (runtime.environment.GITHUB_REPOSITORY !== "cacheplane/dawnai") {
    throw new TypeError("Release CLI attestation verification requires the exact GitHub repository")
  }
  const module = await runtime.importModule(new URL("./artifact-store.mjs", import.meta.url).href)
  return moduleFunction(
    module,
    "createCliAttestationVerifier",
    "attestation verifier factory",
  )({
    repository: "cacheplane/dawnai",
    token,
    fileSystem: runtime.fileSystem,
  })
}

function validateGitHubBoundary(github) {
  if (
    github === null ||
    typeof github !== "object" ||
    Array.isArray(github) ||
    github.reader === null ||
    typeof github.reader !== "object" ||
    github.writer === null ||
    typeof github.writer !== "object"
  ) {
    throw new TypeError("Release CLI command requires a valid GitHub effect boundary")
  }
  return github
}

function normalizeArtifactUpload(value, manifest) {
  const fields = ["artifactId", "artifactUrl", "artifactDigest"]
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== fields.length ||
    !fields.every((field) => Object.hasOwn(value, field)) ||
    typeof value.artifactId !== "string" ||
    !DECIMAL_ID_PATTERN.test(value.artifactId) ||
    typeof value.artifactDigest !== "string" ||
    !SHA256_PATTERN.test(value.artifactDigest)
  ) {
    throw new TypeError("Artifact upload output has an invalid exact-key schema")
  }
  const expectedUrl = `https://github.com/cacheplane/dawnai/actions/runs/${manifest.artifact.prepareRunId}/artifacts/${value.artifactId}`
  if (value.artifactUrl !== expectedUrl) {
    throw new TypeError("Artifact upload URL does not match the run and artifact ID")
  }
  return Object.freeze({
    artifactId: value.artifactId,
    artifactUrl: value.artifactUrl,
    artifactDigest: value.artifactDigest,
  })
}

async function readJsonFile(fileSystem, filePath, maximumBytes, label) {
  const bytes = await readRegularFile(fileSystem, filePath, maximumBytes, label)
  return parseJsonBytes(bytes, label)
}

function parseJsonBytes(bytes, label) {
  let value
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
  } catch (error) {
    throw new TypeError(`Release CLI ${label} JSON is invalid`, { cause: error })
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`Release CLI ${label} must be one JSON object`)
  }
  return value
}

async function readRegularFile(fileSystem, filePath, maximumBytes, label) {
  let handle
  try {
    handle = await fileSystem.open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  } catch (error) {
    if (error?.code === "ELOOP") {
      throw new TypeError(`Release CLI ${label} must be one bounded regular file`, {
        cause: error,
      })
    }
    throw error
  }
  try {
    const before = await handle.stat({ bigint: true })
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.size < 1n ||
      before.size > BigInt(maximumBytes) ||
      before.size > BigInt(Number.MAX_SAFE_INTEGER)
    ) {
      throw new TypeError(`Release CLI ${label} must be one bounded regular file`)
    }
    const size = Number(before.size)
    const bytes = Buffer.allocUnsafe(size)
    let offset = 0
    while (offset < size) {
      const { bytesRead } = await handle.read(bytes, offset, size - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    const after = await handle.stat({ bigint: true })
    if (offset !== size || !sameOpenedFile(before, after)) {
      throw new Error(`Release CLI ${label} changed while it was read`)
    }
    return bytes
  } finally {
    await handle.close()
  }
}

async function openPinnedDirectory(fileSystem, directory, label) {
  if (!Number.isInteger(fsConstants.O_DIRECTORY) || !Number.isInteger(fsConstants.O_NOFOLLOW)) {
    throw new Error("Release CLI directory descriptor containment is unavailable")
  }
  let handle
  try {
    handle = await fileSystem.open(
      directory,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
    )
  } catch (error) {
    if (["ELOOP", "ENOTDIR"].includes(error?.code)) {
      throw new TypeError(`Release CLI ${label} must be one regular directory`, {
        cause: error,
      })
    }
    throw error
  }
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isDirectory()) {
      throw new TypeError(`Release CLI ${label} must be one regular directory`)
    }
    return {
      handle,
      before,
      originalPath: directory,
      readPath: process.platform === "linux" ? `/proc/self/fd/${handle.fd}` : directory,
    }
  } catch (error) {
    await handle.close()
    throw error
  }
}

async function assertPinnedDirectoryUnchanged(fileSystem, pinned, label) {
  const after = await pinned.handle.stat({ bigint: true })
  if (!sameOpenedDirectory(pinned.before, after)) {
    throw new Error(`Release CLI ${label} changed while it was read`)
  }
  if (process.platform !== "linux") {
    const current = await fileSystem.lstat(pinned.originalPath, { bigint: true })
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      current.dev !== pinned.before.dev ||
      current.ino !== pinned.before.ino
    ) {
      throw new Error(`Release CLI ${label} path changed while it was read`)
    }
  }
}

async function assertPinnedDirectoryStillCurrent(fileSystem, pinned, label) {
  const opened = await pinned.handle.stat({ bigint: true })
  const current = await fileSystem.lstat(pinned.originalPath, { bigint: true })
  if (
    !opened.isDirectory() ||
    !current.isDirectory() ||
    current.isSymbolicLink() ||
    opened.dev !== pinned.before.dev ||
    opened.ino !== pinned.before.ino ||
    current.dev !== pinned.before.dev ||
    current.ino !== pinned.before.ino
  ) {
    throw new Error(`Release CLI ${label} path changed while it was used`)
  }
}

function sameOpenedDirectory(before, after) {
  return (
    after.isDirectory() &&
    after.dev === before.dev &&
    after.ino === before.ino &&
    after.mtimeNs === before.mtimeNs &&
    after.ctimeNs === before.ctimeNs
  )
}

function sameOpenedFile(before, after) {
  return (
    after.isFile() &&
    after.size === before.size &&
    after.dev === before.dev &&
    after.ino === before.ino &&
    after.nlink === 1n &&
    after.mtimeNs === before.mtimeNs &&
    after.ctimeNs === before.ctimeNs
  )
}

async function appendGitHubOutputs(fileSystem, filePath, values) {
  if (typeof fileSystem.open !== "function") {
    throw new TypeError("Release CLI filesystem method open is invalid")
  }
  const fields = ["candidate_version", "candidate_sha", "state", "disposition", "next_transition"]
  if (
    values === null ||
    typeof values !== "object" ||
    Array.isArray(values) ||
    Object.keys(values).length !== fields.length ||
    fields.some(
      (field) =>
        !Object.hasOwn(values, field) ||
        typeof values[field] !== "string" ||
        /[\r\n\0]/u.test(values[field]) ||
        Buffer.byteLength(values[field], "utf8") > 1_024,
    )
  ) {
    throw new TypeError("Release CLI GitHub outputs are invalid")
  }
  const bytes = Buffer.from(`${fields.map((field) => `${field}=${values[field]}`).join("\n")}\n`)
  let before = null
  try {
    before = await fileSystem.lstat(filePath)
  } catch (error) {
    if (error?.code !== "ENOENT") throw error
  }
  if (
    before !== null &&
    (!before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1 ||
      !Number.isSafeInteger(before.size) ||
      before.size < 0 ||
      before.size + bytes.length > MAX_JSON_BYTES)
  ) {
    throw new TypeError("Release CLI GitHub output must be one bounded regular file")
  }
  const handle = await fileSystem.open(filePath, before === null ? "ax" : "a", 0o600)
  try {
    const opened = await handle.stat()
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      (before !== null && (opened.dev !== before.dev || opened.ino !== before.ino)) ||
      opened.size + bytes.length > MAX_JSON_BYTES
    ) {
      throw new Error("Release CLI GitHub output changed before append")
    }
    await handle.writeFile(bytes)
    await handle.sync()
    const after = await handle.stat()
    if (
      !after.isFile() ||
      after.nlink !== 1 ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size + bytes.length
    ) {
      throw new Error("Release CLI GitHub output append was not durable")
    }
  } finally {
    await handle.close()
  }
}

async function writeCanonicalFile(fileSystem, filePath, bytes, label) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > MAX_JSON_BYTES) {
    throw new TypeError(`Release CLI ${label} bytes are invalid`)
  }
  try {
    await fileSystem.writeFile(filePath, Buffer.from(bytes), { flag: "wx", mode: 0o600 })
  } catch (error) {
    if (error?.code !== "EEXIST") throw error
    const existing = await readRegularFile(fileSystem, filePath, MAX_JSON_BYTES, label)
    if (!existing.equals(Buffer.from(bytes))) {
      throw new Error(`Release CLI ${label} output already exists with different bytes`)
    }
  }
}

async function writeContainedCanonicalOutput(
  fileSystem,
  filePath,
  label,
  produceBytes,
  maximumBytes = MAX_JSON_BYTES,
) {
  if (
    typeof fileSystem?.open !== "function" ||
    typeof fileSystem?.lstat !== "function" ||
    typeof fileSystem?.link !== "function" ||
    typeof fileSystem?.unlink !== "function" ||
    typeof produceBytes !== "function" ||
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1 ||
    !Number.isInteger(fsConstants.O_DIRECTORY) ||
    !Number.isInteger(fsConstants.O_NOFOLLOW)
  ) {
    throw new TypeError(`Release CLI ${label} output containment is unavailable`)
  }
  const parentPath = path.dirname(filePath)
  let parentHandle
  try {
    parentHandle = await fileSystem.open(
      parentPath,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
    )
  } catch (error) {
    if (["ELOOP", "ENOTDIR"].includes(error?.code)) {
      throw new TypeError(`Release CLI ${label} output parent must be one regular directory`, {
        cause: error,
      })
    }
    throw error
  }

  let parentIdentity
  let temporaryPath = null
  let temporaryCreated = false
  let linkedIdentity = null
  let existingIdentity = null
  let expected = null
  let primaryError = null
  try {
    parentIdentity = await parentHandle.stat({ bigint: true })
    if (!parentIdentity.isDirectory()) {
      throw new TypeError(`Release CLI ${label} output parent must be one regular directory`)
    }
    await assertContainedParent(fileSystem, parentPath, parentIdentity, label)

    const bytes = await produceBytes()
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > maximumBytes) {
      throw new TypeError(`Release CLI ${label} output bytes are invalid`)
    }
    expected = Buffer.from(bytes)
    await assertContainedParent(fileSystem, parentPath, parentIdentity, label)

    temporaryPath = path.join(
      parentPath,
      `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
    )
    const temporaryHandle = await fileSystem.open(
      temporaryPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    )
    temporaryCreated = true
    try {
      await temporaryHandle.writeFile(expected)
      await temporaryHandle.sync()
      linkedIdentity = await temporaryHandle.stat({ bigint: true })
      if (
        !linkedIdentity.isFile() ||
        linkedIdentity.nlink !== 1n ||
        linkedIdentity.size !== BigInt(expected.byteLength)
      ) {
        throw new Error(`Release CLI ${label} temporary output write was not durable`)
      }
    } finally {
      await temporaryHandle.close()
    }

    await assertContainedParent(fileSystem, parentPath, parentIdentity, label)
    try {
      await fileSystem.link(temporaryPath, filePath)
      await assertLinkedOutput(fileSystem, filePath, linkedIdentity, label, false)
    } catch (error) {
      if (error?.code !== "EEXIST") {
        await assertContainedParent(fileSystem, parentPath, parentIdentity, label)
        throw error
      }
      const existing = await readExistingContainedOutput(fileSystem, filePath, maximumBytes, label)
      if (!existing.bytes.equals(expected)) {
        throw new Error(`Release CLI ${label} output already exists with different bytes`)
      }
      existingIdentity = existing.identity
      linkedIdentity = null
    }
    await parentHandle.sync()
    await assertContainedParent(fileSystem, parentPath, parentIdentity, label)
  } catch (error) {
    primaryError = error
  }

  let cleanupError = null
  if (temporaryCreated) {
    try {
      await fileSystem.unlink(temporaryPath)
      await parentHandle.sync()
    } catch (error) {
      cleanupError = error
    }
  }
  if (primaryError === null && cleanupError === null) {
    try {
      await assertContainedParent(fileSystem, parentPath, parentIdentity, label)
      if (linkedIdentity !== null) {
        await assertLinkedOutput(fileSystem, filePath, linkedIdentity, label, true)
      } else {
        await assertExistingOutput(fileSystem, filePath, existingIdentity, label)
      }
    } catch (error) {
      primaryError = error
    }
  }

  let closeError = null
  try {
    await parentHandle.close()
  } catch (error) {
    closeError = error
  }
  const errors = [primaryError, cleanupError, closeError].filter((error) => error !== null)
  if (errors.length > 1) {
    const firstMessage =
      typeof errors[0]?.message === "string" ? errors[0].message : `Release CLI ${label} failed`
    throw new AggregateError(errors, `${firstMessage}; output cleanup also failed`)
  }
  if (errors.length === 1) throw errors[0]
}

async function readExistingContainedOutput(fileSystem, filePath, maximumBytes, label) {
  let handle
  try {
    handle = await fileSystem.open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  } catch (error) {
    if (["ELOOP", "ENOTDIR"].includes(error?.code)) {
      throw new TypeError(`Release CLI ${label} output must be one regular file`, { cause: error })
    }
    throw error
  }
  try {
    const before = await handle.stat({ bigint: true })
    if (
      !before.isFile() ||
      before.nlink < 1n ||
      before.size < 1n ||
      before.size > BigInt(maximumBytes) ||
      before.size > BigInt(Number.MAX_SAFE_INTEGER)
    ) {
      throw new TypeError(`Release CLI ${label} output must be one bounded regular file`)
    }
    const bytes = Buffer.allocUnsafe(Number(before.size))
    let offset = 0
    while (offset < bytes.byteLength) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.byteLength - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    const after = await handle.stat({ bigint: true })
    if (offset !== bytes.byteLength || !sameCanonicalOutput(before, after)) {
      throw new Error(`Release CLI ${label} output changed while it was read`)
    }
    await assertExistingOutput(fileSystem, filePath, after, label)
    return { bytes, identity: after }
  } finally {
    await handle.close()
  }
}

async function assertContainedParent(fileSystem, parentPath, expected, label) {
  const actual = await fileSystem.lstat(parentPath, { bigint: true })
  if (
    !actual.isDirectory() ||
    actual.isSymbolicLink() ||
    actual.dev !== expected.dev ||
    actual.ino !== expected.ino
  ) {
    throw new Error(`Release CLI ${label} output parent changed during containment`)
  }
}

async function assertLinkedOutput(fileSystem, filePath, expected, label, unlinkedTemporary) {
  const actual = await fileSystem.lstat(filePath, { bigint: true })
  if (
    !actual.isFile() ||
    actual.isSymbolicLink() ||
    (unlinkedTemporary ? actual.nlink !== 1n : actual.nlink < 2n) ||
    actual.dev !== expected.dev ||
    actual.ino !== expected.ino ||
    actual.size !== expected.size
  ) {
    throw new Error(`Release CLI ${label} output changed during containment`)
  }
}

async function assertExistingOutput(fileSystem, filePath, expected, label) {
  const actual = await fileSystem.lstat(filePath, { bigint: true })
  if (actual.isSymbolicLink() || !sameCanonicalOutput(expected, actual)) {
    throw new Error(`Release CLI ${label} output changed during containment`)
  }
}

function sameCanonicalOutput(before, after) {
  return (
    after.isFile() &&
    after.size === before.size &&
    after.dev === before.dev &&
    after.ino === before.ino &&
    after.nlink === before.nlink &&
    after.mtimeNs === before.mtimeNs &&
    after.ctimeNs === before.ctimeNs
  )
}

function resolveCliPath(value, cwd) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > MAX_PATH_BYTES
  ) {
    throw new TypeError("Release CLI path argument is invalid")
  }
  return path.resolve(cwd, value)
}

function moduleFunction(module, name, label) {
  if (
    module === null ||
    typeof module !== "object" ||
    typeof Object.getOwnPropertyDescriptor(module, name)?.value !== "function"
  ) {
    throw new TypeError(`Release CLI ${label} module is invalid`)
  }
  return Object.getOwnPropertyDescriptor(module, name).value
}

function moduleValue(module, name, label) {
  if (module === null || typeof module !== "object") {
    throw new TypeError(`Release CLI ${label} module is invalid`)
  }
  const descriptor = Object.getOwnPropertyDescriptor(module, name)
  if (descriptor === undefined || !("value" in descriptor)) {
    throw new TypeError(`Release CLI ${label} module is invalid`)
  }
  return descriptor.value
}

function requiredMethod(value, name, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`Release CLI ${label} is invalid`)
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, name)
  if (
    descriptor === undefined ||
    descriptor.enumerable !== true ||
    !("value" in descriptor) ||
    typeof descriptor.value !== "function"
  ) {
    throw new TypeError(`Release CLI ${label} method ${name} is invalid`)
  }
  return descriptor.value.bind(value)
}

async function readPresentValue(promise, operation) {
  const envelope = snapshotCliData(await promise, `${operation} envelope`)
  if (
    !hasExactDataFields(envelope, ["status", "operation", "httpStatus", "code", "value"]) ||
    envelope.status !== "PRESENT" ||
    envelope.operation !== operation ||
    !Number.isInteger(envelope.httpStatus) ||
    envelope.httpStatus < 200 ||
    envelope.httpStatus >= 300 ||
    envelope.code !== null
  ) {
    throw new Error(`Release CLI ${operation} observation is not exact`)
  }
  return envelope.value
}

function snapshotCliData(value, label, ancestors = new Set()) {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value
  }
  if (typeof value !== "object" || ancestors.has(value)) {
    throw new TypeError(`Release CLI ${label} is not acyclic JSON data`)
  }
  const next = new Set(ancestors).add(value)
  if (Array.isArray(value)) {
    const expected = new Set(["length", ...value.map((_entry, index) => String(index))])
    if (Reflect.ownKeys(value).some((key) => typeof key !== "string" || !expected.has(key))) {
      throw new TypeError(`Release CLI ${label} array is sparse or contains extra fields`)
    }
    return value.map((_entry, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        throw new TypeError(`Release CLI ${label} array contains an accessor`)
      }
      return snapshotCliData(descriptor.value, label, next)
    })
  }
  if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new TypeError(`Release CLI ${label} contains a non-JSON object`)
  }
  const result = Object.create(null)
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = typeof key === "string" ? Object.getOwnPropertyDescriptor(value, key) : null
    if (
      typeof key !== "string" ||
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      throw new TypeError(`Release CLI ${label} contains an accessor or symbol field`)
    }
    result[key] = snapshotCliData(descriptor.value, label, next)
  }
  return result
}

function dataValue(value, field, label) {
  const descriptor = Object.getOwnPropertyDescriptor(value, field)
  if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
    throw new TypeError(`Release CLI ${label} field ${field} is invalid`)
  }
  return descriptor.value
}

function hasExactDataFields(value, fields) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field))
  )
}

function timestamp(now) {
  const value = now()
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("Release CLI clock returned an invalid timestamp")
  }
  return new Date(value).toISOString()
}

function isNullableTimestamp(value) {
  return (
    value === null ||
    (typeof value === "string" &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value) &&
      Number.isFinite(Date.parse(value)))
  )
}

function canonicalJsonBytes(value) {
  return Buffer.from(`${JSON.stringify(canonicalize(value), null, 2)}\n`, "utf8")
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value === null || typeof value !== "object") return value
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  )
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

function arraysEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function digest(bytes, algorithm) {
  return createHash(algorithm).update(bytes).digest("hex")
}

function usageError() {
  return new TypeError(
    "Usage: cli.mjs record-artifact --candidate <path> --manifest <path> --artifact-upload-result <path> --output <path>",
  )
}

const executedPath =
  process.argv[1] === undefined ? null : pathToFileURL(path.resolve(process.argv[1])).href
if (executedPath === import.meta.url) {
  try {
    await runReleaseCli(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`release CLI failed: ${safeCode(error)}\n`)
    process.exitCode = 1
  }
}

function safeCode(error) {
  const code = error?.code
  return typeof code === "string" && /^[A-Z0-9_]{1,128}$/u.test(code)
    ? code
    : "INVALID_RELEASE_COMMAND"
}

function safeObservationFailure(error, fallback) {
  const code = error?.code
  return Object.freeze({
    code: typeof code === "string" && /^[A-Z][A-Z0-9_-]{0,127}$/u.test(code) ? code : fallback,
  })
}

function normalizeObservationDiagnostics(value) {
  const diagnostics = snapshotCliData(value, "production observation diagnostics")
  if (!Array.isArray(diagnostics) || diagnostics.length > 256) {
    throw new TypeError("Release CLI production observation diagnostics exceed their bound")
  }
  const normalized = diagnostics.map((entry) => {
    if (
      !hasExactDataFields(entry, ["source", "operation", "status", "httpStatus", "code"]) ||
      typeof entry.source !== "string" ||
      !/^[a-z][a-z0-9-]{0,63}$/u.test(entry.source) ||
      typeof entry.operation !== "string" ||
      !/^[a-z][a-z0-9-]{0,127}$/u.test(entry.operation) ||
      !["AMBIGUOUS", "ERROR"].includes(entry.status) ||
      !(
        entry.httpStatus === null ||
        (Number.isInteger(entry.httpStatus) && entry.httpStatus >= 100 && entry.httpStatus <= 599)
      ) ||
      typeof entry.code !== "string" ||
      !/^[A-Z][A-Z0-9_-]{0,127}$/u.test(entry.code)
    ) {
      throw new TypeError("Release CLI production observation diagnostic is malformed")
    }
    return observationDiagnostic(entry.source, entry.operation, entry.code, {
      status: entry.status,
      httpStatus: entry.httpStatus,
    })
  })
  normalized.sort((left, right) =>
    compareText(
      `${left.source}\0${left.operation}\0${left.code}`,
      `${right.source}\0${right.operation}\0${right.code}`,
    ),
  )
  return normalized
}

function observationDiagnostic(
  source,
  operation,
  code,
  { status = "AMBIGUOUS", httpStatus = null } = {},
) {
  return {
    source,
    operation,
    status,
    httpStatus,
    code,
    classification: transientObservationCode(code) ? "transient-error" : "conflict",
  }
}

function transientObservationCode(code) {
  return (
    /(?:TIMEOUT|NETWORK|RATE_LIMIT|THROTTL|ABORTED|HTTP_408)/u.test(code) ||
    /^HTTP_(?:429|5[0-9]{2})$/u.test(code)
  )
}
