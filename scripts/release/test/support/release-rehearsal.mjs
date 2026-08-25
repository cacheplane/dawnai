import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { createCandidateTagWriter } from "../../adapters/git-write.mjs"
import { createNpmReader } from "../../adapters/npm.mjs"
import { loadVerifiedReleaseArtifact } from "../../artifact-store.mjs"
import {
  dispatchIndependentAudit,
  recordAuditAttempt,
  recordAuditDispatch,
  verifyAuditSuccess,
} from "../../audit.mjs"
import { readReleaseInventory } from "../../inventory.mjs"
import {
  canonicalManifestBytes,
  manifestSha256,
  parseSealedReleaseManifest,
} from "../../manifest.mjs"
import {
  canonicalBaseAssetSet,
  escrowCandidate,
  parseReleaseMarker,
  publishConsolidatedRelease,
  reconcileNpmEvidence,
  reconcileSmokeEvidence,
} from "../../metadata.mjs"
import { prepareReleaseArtifacts } from "../../prepare.mjs"
import { createReleasePreparationRunner } from "../../process-runner.mjs"
import { publishManifestSerially } from "../../publisher.mjs"
import { createReleaseRecord } from "../../release-record.mjs"
import { createRehearsalGitHub } from "./release-rehearsal-github.mjs"

const SMOKE_LANES = Object.freeze(["published-harness", "runtime-targets", "scaffold", "storage"])
const execFileAsync = promisify(execFile)
const THREE_PACKAGE_FIXTURE = fileURLToPath(new URL("../fixtures/fault-workspace", import.meta.url))

const FIXED_GROUP_TRANSITIONS = Object.freeze([
  "tag",
  "prepare",
  "attest",
  "draft-create",
  "escrow-asset:1",
  "escrow-asset:23",
  "escrow-asset:45",
  "publish:1",
  "publish:11",
  "publish:21",
  "registry-convergence",
  "reconcile-npm",
  ...SMOKE_LANES.map((lane) => `smoke-result:${lane}`),
  "reconcile-smokes",
  "audit-dispatch",
  "audit-dispatch-receipt",
  "audit-dispatched-cas",
  "failed-audit-attempt",
  "audit-retryable-cas",
  "retry-audit-dispatch",
  "retry-audit-dispatch-receipt",
  "retry-audit-dispatched-cas",
  "successful-audit-attempt",
  "canonical-audit-success",
  "audit-verified-cas",
  "release-publication",
  "immutable-reread",
])

export const FIXED_GROUP_REHEARSAL_FAULTS = Object.freeze(
  FIXED_GROUP_TRANSITIONS.flatMap((transition) => [`before-${transition}`, `after-${transition}`]),
)

const durableStates = new WeakMap()

export class RehearsalCrashError extends Error {
  constructor(point) {
    super(`Injected release rehearsal runner loss at ${point}`)
    this.name = "RehearsalCrashError"
    Object.defineProperty(this, "point", {
      value: point,
      enumerable: true,
      writable: false,
      configurable: false,
    })
  }
}

export function createOrderedFaultGate(points) {
  if (
    !Array.isArray(points) ||
    points.some((point) => typeof point !== "string") ||
    new Set(points).size !== points.length
  ) {
    throw new TypeError("Release rehearsal fault sequence is invalid")
  }
  let previous = -1
  for (const point of points) {
    const index = FIXED_GROUP_REHEARSAL_FAULTS.indexOf(point)
    if (index < 0 || index <= previous) {
      throw new TypeError("Release rehearsal fault sequence is invalid or out of order")
    }
    previous = index
  }
  const remaining = [...points]
  const injected = []
  const gate = Object.freeze({
    checkpoint(point) {
      if (!FIXED_GROUP_REHEARSAL_FAULTS.includes(point)) {
        throw new TypeError(`Unknown release rehearsal checkpoint: ${point}`)
      }
      if (remaining[0] !== point) return
      remaining.shift()
      injected.push(point)
      throw new RehearsalCrashError(point)
    },
    async around(transition, operation) {
      if (typeof transition !== "string" || typeof operation !== "function") {
        throw new TypeError("Release rehearsal transition is invalid")
      }
      gate.checkpoint(`before-${transition}`)
      const result = await operation()
      gate.checkpoint(`after-${transition}`)
      return result
    },
    snapshot() {
      return Object.freeze({
        injected: Object.freeze([...injected]),
        remaining: Object.freeze([...remaining]),
      })
    },
  })
  return gate
}

export function createRehearsalDurableState() {
  const handle = Object.freeze({
    snapshot() {
      const state = durableStates.get(handle)
      return durableSnapshot(state)
    },
  })
  durableStates.set(handle, {
    smokeResults: new Map(),
    initialDispatch: null,
    retryDispatch: null,
  })
  return handle
}

export async function resumeFixedGroupEvidence({
  candidate,
  record,
  manifest,
  npmEvidence,
  gate,
  remote,
  durable,
}) {
  const state = durableStates.get(durable)
  if (state === undefined) throw new TypeError("Release rehearsal durable state is invalid")
  if (
    gate === null ||
    typeof gate !== "object" ||
    typeof gate.around !== "function" ||
    remote === null ||
    typeof remote !== "object" ||
    typeof remote.snapshot !== "function" ||
    remote.releaseGitHub === undefined ||
    remote.actionsWriter === undefined
  ) {
    throw new TypeError("Release rehearsal evidence dependencies are invalid")
  }
  const before = rehearsalMutationSnapshot(remote, state)
  let observed = remote.snapshot()
  if (observed.release === null) throw new Error("Release rehearsal draft is missing")
  if (observed.release.draft === false) {
    const reread = await remote.releaseGitHub.reader.getRelease({
      releaseId: observed.release.id,
    })
    if (reread.value.draft !== false || reread.value.immutable !== true) {
      throw new Error("Release rehearsal immutable publication re-read failed")
    }
    return evidenceResult(remote, state, before)
  }

  let marker = parseReleaseMarker(observed.release.body)
  if (marker.phase === "ESCROWED") {
    await reconcileNpmEvidence({
      candidate,
      record,
      manifest,
      npmEvidence,
      github: remote.releaseGitHub,
    })
    marker = currentMarker(remote)
  }

  if (marker.phase === "NPM_COMPLETE") {
    for (const lane of SMOKE_LANES) {
      if (state.smokeResults.has(lane)) continue
      await gate.around(`smoke-result:${lane}`, async () => {
        state.smokeResults.set(
          lane,
          smokeResult({ lane, candidate, manifestSha256: record.manifestSha256 }),
        )
      })
    }
    await reconcileSmokeEvidence({
      candidate,
      record,
      manifest,
      npmEvidence,
      smokeResults: SMOKE_LANES.map((lane) => state.smokeResults.get(lane)),
      requiredLanes: SMOKE_LANES,
      workflowRunId: 400,
      runAttempt: 1,
      github: remote.releaseGitHub,
    })
    marker = currentMarker(remote)
  }

  if (marker.phase === "SMOKES_COMPLETE") {
    if (state.initialDispatch === null) {
      const dispatch = await dispatchIndependentAudit({
        candidate,
        manifestSha256: record.manifestSha256,
        github: remote.actionsWriter,
      })
      await gate.around("audit-dispatch-receipt", async () => {
        state.initialDispatch = dispatch
      })
    }
    await recordAuditDispatch({
      candidate,
      dispatch: state.initialDispatch,
      github: remote.releaseGitHub,
    })
    marker = currentMarker(remote)
  }

  if (
    marker.phase === "AUDIT_DISPATCHED" &&
    state.initialDispatch !== null &&
    marker.audit.workflowRunId === state.initialDispatch.workflowRunId
  ) {
    await recordAuditAttempt({
      candidate,
      dispatch: state.initialDispatch,
      result: auditResult({
        candidate,
        manifestSha256: record.manifestSha256,
        workflowRunId: state.initialDispatch.workflowRunId,
        conclusion: "failure",
      }),
      github: remote.releaseGitHub,
    })
    marker = currentMarker(remote)
  }

  if (marker.phase === "AUDIT_RETRYABLE") {
    if (state.retryDispatch === null) {
      const dispatch = await dispatchIndependentAudit({
        candidate,
        manifestSha256: record.manifestSha256,
        github: remote.actionsWriter,
      })
      await gate.around("retry-audit-dispatch-receipt", async () => {
        state.retryDispatch = dispatch
      })
    }
    await recordAuditDispatch({
      candidate,
      dispatch: state.retryDispatch,
      github: remote.releaseGitHub,
    })
    marker = currentMarker(remote)
  }

  let successfulAudit = null
  if (
    marker.phase === "AUDIT_DISPATCHED" &&
    state.retryDispatch !== null &&
    marker.audit.workflowRunId === state.retryDispatch.workflowRunId
  ) {
    successfulAudit = auditResult({
      candidate,
      manifestSha256: record.manifestSha256,
      workflowRunId: state.retryDispatch.workflowRunId,
      conclusion: "success",
    })
    await recordAuditAttempt({
      candidate,
      dispatch: state.retryDispatch,
      result: successfulAudit,
      github: remote.releaseGitHub,
    })
    await verifyAuditSuccess({
      candidate,
      dispatch: state.retryDispatch,
      result: successfulAudit,
      github: remote.releaseGitHub,
    })
    marker = currentMarker(remote)
  }

  if (marker.phase === "AUDIT_VERIFIED") {
    successfulAudit ??= auditResult({
      candidate,
      manifestSha256: record.manifestSha256,
      workflowRunId: marker.audit.workflowRunId,
      conclusion: "success",
    })
    await publishConsolidatedRelease({
      candidate,
      record,
      auditResult: successfulAudit,
      github: remote.releaseGitHub,
    })
  }

  observed = remote.snapshot()
  if (observed.release?.draft !== false || observed.release.immutable !== true) {
    throw new Error("Release rehearsal did not reach immutable publication")
  }
  return evidenceResult(remote, state, before)
}

export async function verifyExpiredActionsEscrowFallback({ record, remote }) {
  if (remote === null || typeof remote !== "object" || remote.escrowReader === undefined) {
    throw new TypeError("Release rehearsal escrow reader is invalid")
  }
  const artifact = await loadVerifiedReleaseArtifact({
    record,
    actionsReader: {
      async getArtifactMetadata() {
        return {
          status: "PRESENT",
          value: {
            id: record.actionsArtifact.id,
            name: record.actionsArtifact.name,
            serviceDigest: record.actionsArtifact.serviceDigest,
            expired: true,
            prepareRunId: record.actionsArtifact.prepareRunId,
            prepareRunAttempt: record.actionsArtifact.prepareRunAttempt,
            headSha: record.commitSha,
          },
        }
      },
      async downloadArtifactById() {
        return { status: "GONE", httpStatus: 410, code: "RETENTION_EXPIRED" }
      },
    },
    releaseReader: remote.escrowReader,
    attestations: {
      async verify({ source, subjects, bundles }) {
        if (source !== "escrow" || bundles.length !== subjects.length) {
          throw new Error("Release rehearsal escrow attestation set is incomplete")
        }
        return { status: "VERIFIED", subjects }
      },
    },
  })
  if (artifact.source !== "escrow") {
    throw new Error("Expired Actions artifact did not resolve from draft escrow")
  }
  return Object.freeze({
    source: artifact.source,
    fileCount: artifact.files.length,
    actionsExpired: true,
  })
}

export async function runCanonicalFixedGroupRehearsal(options, { root, createFaultHarness }) {
  const rehearsal = validateFixedGroupOptions(options)
  if (
    typeof root !== "string" ||
    !isAbsolute(root) ||
    resolve(root) !== root ||
    typeof createFaultHarness !== "function"
  ) {
    throw new TypeError("Canonical fixed-group rehearsal dependencies are invalid")
  }
  const canonicalRoot = await realpath(root)
  if (canonicalRoot !== root) throw new TypeError("Canonical fixed-group rehearsal root is invalid")
  const faultPoints = rehearsal.allFaults
    ? FIXED_GROUP_REHEARSAL_FAULTS
    : Object.freeze([rehearsal.inject])
  const gate = createOrderedFaultGate(faultPoints)
  const runtime = await realpath(await mkdtemp(join(tmpdir(), "dawn-fixed-group-rehearsal-")))
  const artifactDir = join(runtime, "artifact")
  let registryHarness = null
  try {
    const candidateRepository = await createCandidateRepositoryFixture({
      sourceRoot: canonicalRoot,
      runtime,
    })
    const inventory = await readReleaseInventory({ root: canonicalRoot, ref: "HEAD" })
    const versions = new Set(
      inventory.workspacePackages
        .filter((pkg) => pkg.private !== true)
        .map(({ version }) => version),
    )
    if (versions.size !== 1) throw new Error("Fixed-group rehearsal versions are not uniform")
    const version = [...versions][0]
    const candidate = Object.freeze({
      version,
      commitSha: candidateRepository.commitSha,
      ciWorkflow: "CI",
      ciCheck: "validate",
      publisherWorkflow: ".github/workflows/release.yml",
    })
    const tagWriter = createCandidateTagWriter({
      root: candidateRepository.workingDirectory,
      run: (command, args, commandOptions) =>
        isolatedGitCommand(command, args, commandOptions, candidateRepository.environment),
    })
    const baseRun = createReleasePreparationRunner()
    const preparationRun = (command, args, commandOptions) =>
      baseRun(command, args, {
        ...commandOptions,
        cwd: command === "git" ? candidateRepository.workingDirectory : commandOptions.cwd,
      })

    let prepared = null
    let attestation = null
    let record = null
    let remote = null
    let npmReader = null
    let publicationState = null
    let npmEvidence = null
    let fallback = null
    const durable = createRehearsalDurableState()
    const acceptedPackages = new Set()
    let final = null
    const maximumAttempts = faultPoints.length + 20
    for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
      try {
        if (
          !(await exactCandidateTagExists(
            candidateRepository.workingDirectory,
            candidate,
            candidateRepository.environment,
          ))
        ) {
          await gate.around("tag", async () => {
            await tagWriter.createAnnotatedTag({
              tag: `v${candidate.version}`,
              sha: candidate.commitSha,
              message: `release rehearsal v${candidate.version}`,
            })
            await tagWriter.pushTag({ tag: `v${candidate.version}` })
          })
        }

        prepared ??= await loadPreparedArtifactIfPresent({ artifactDir, candidate })
        if (prepared === null) {
          await gate.around("prepare", async () => {
            await prepareReleaseArtifacts({
              candidate,
              inventory,
              root: canonicalRoot,
              outputDir: artifactDir,
              ci: {
                status: "success",
                retryable: false,
                commitSha: candidate.commitSha,
                workflow: "CI",
                check: "validate",
                runId: 100,
                runAttempt: 1,
              },
              prepareRun: { id: 200, attempt: 1 },
              preparationAuthority: {
                state: "CANDIDATE_TAGGED",
                releaseRecord: "absent",
                npm: "absent",
              },
              sourceRef: `refs/tags/v${candidate.version}`,
              run: preparationRun,
            })
            prepared = await loadPreparedArtifact({ artifactDir, candidate })
          })
        }

        record ??= createRehearsalReleaseRecord({ candidate, prepared })
        if (attestation === null) {
          await gate.around("attest", async () => {
            attestation = createRehearsalAttestation({ candidate, prepared })
          })
        }
        const base = canonicalBaseAssetSet({
          record,
          artifact: prepared.artifact,
          attestationSet: attestation.set,
          bundles: attestation.bundles,
        })
        remote ??= createRehearsalGitHub({
          candidate,
          gate,
          baseAssetNames: base.assets.map(({ name }) => name),
        })
        if (registryHarness === null) {
          registryHarness = await createFaultHarness({
            fixtureDirectory: THREE_PACKAGE_FIXTURE,
            publishRoots: [artifactDir],
          })
          npmReader = createRehearsalNpmReader(registryHarness)
          publicationState = await captureAbsentPublicationState({
            candidate,
            manifest: prepared.manifest,
            npmReader,
          })
        }

        const release = remote.snapshot().release
        if (release === null || parseReleaseMarker(release.body).phase === "ESCROWING") {
          await escrowCandidate({
            candidate,
            record,
            artifact: prepared.artifact,
            attestationSet: attestation.set,
            bundles: attestation.bundles,
            publicationState,
            attestations: verifiedAttestations,
            github: remote.releaseGitHub,
          })
        }
        if (fallback === null) {
          fallback = await verifyExpiredActionsEscrowFallback({ record, remote })
        }

        const marker = parseReleaseMarker(remote.snapshot().release.body)
        if (marker.phase === "ESCROWED" && npmEvidence === null) {
          const observedEvidence = await publishManifestSerially({
            candidate,
            manifest: prepared.manifest,
            observeRegistry: ({ name, version: exactVersion }) =>
              exactVersion === undefined
                ? npmReader.observePackageMetadata({ name })
                : npmReader.observePackageVersion({ name, version: exactVersion }),
            downloadRegistryTarball: (request) => npmReader.downloadRegistryTarball(request),
            verifyPackage: ({ entry }) => verifiedNpmAudit({ candidate, entry }),
            publishTarball: async ({ entry }) => {
              const ordinal = prepared.manifest.packageOrder.indexOf(entry.name) + 1
              const publish = async () => {
                if (acceptedPackages.has(entry.name)) {
                  throw new Error(`Fixed-group rehearsal attempted to republish ${entry.name}`)
                }
                await registryHarness.publishPreparedTarball({
                  tarballPath: join(artifactDir, entry.filename),
                })
                acceptedPackages.add(entry.name)
              }
              if ([1, 11, 21].includes(ordinal)) {
                await gate.around(`publish:${ordinal}`, publish)
              } else {
                await publish()
              }
            },
            async poll() {},
            log() {},
          })
          await gate.around("registry-convergence", async () => {
            await verifyRegistryBytes({ manifest: prepared.manifest, npmReader })
          })
          npmEvidence = observedEvidence
        }

        final = await resumeFixedGroupEvidence({
          candidate,
          record,
          manifest: prepared.manifest,
          npmEvidence,
          gate,
          remote,
          durable,
        })
        if (final.status === "AUDIT_COMPLETE" && gate.snapshot().remaining.length === 0) break
      } catch (error) {
        if (!(error instanceof RehearsalCrashError)) throw error
      }
    }
    if (final?.status !== "AUDIT_COMPLETE" || gate.snapshot().remaining.length !== 0) {
      throw new Error("Fixed-group release rehearsal did not consume every requested fault")
    }
    const replay = await resumeFixedGroupEvidence({
      candidate,
      record,
      manifest: prepared.manifest,
      npmEvidence,
      gate,
      remote,
      durable,
    })
    if (replay.mutations !== 0) throw new Error("Fixed-group release replay was not a no-op")
    const observed = remote.snapshot()
    if (acceptedPackages.size !== 21 || observed.assets.length !== 48) {
      throw new Error("Fixed-group release rehearsal terminal inventory is incomplete")
    }
    return Object.freeze({
      schemaVersion: 1,
      status: final.status,
      inventory: "fixed-group",
      version: candidate.version,
      commitSha: candidate.commitSha,
      packageCount: acceptedPackages.size,
      registryVerified: true,
      baseAssetCount: 45,
      auditAssetCount: observed.assets.length - 45,
      dispatchedAuditRuns: observed.dispatchedRunIds.length,
      orphanedAuditRuns: observed.dispatchedRunIds.length - 2,
      actionsArtifactRecovery: fallback.source,
      immutable: final.immutable,
      replay: "noop",
      injectedFaults: gate.snapshot().injected,
    })
  } finally {
    await registryHarness?.close()
    await rm(runtime, { recursive: true, force: true })
  }
}

export function parseReleaseRehearsalArguments(argv) {
  if (!Array.isArray(argv) || argv.some((value) => typeof value !== "string")) {
    throw new TypeError("Release rehearsal arguments are invalid")
  }
  const values = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (["--all-faults", "--resume"].includes(flag)) {
      if (values.has(flag)) throw rehearsalUsage()
      values.set(flag, true)
      continue
    }
    if (["--inventory", "--fixture", "--inject"].includes(flag)) {
      const value = argv[index + 1]
      if (values.has(flag) || typeof value !== "string" || value.length === 0) {
        throw rehearsalUsage()
      }
      values.set(flag, value)
      index += 1
      continue
    }
    throw rehearsalUsage()
  }

  if (values.has("--fixture")) {
    if (values.get("--fixture") === "three-package" && values.has("--all-faults")) {
      throw new Error(
        "The three-package fixture covers real Git, registry, and proxy faults only; full fixed-group 45-asset release coverage requires --inventory fixed-group --all-faults",
      )
    }
    throw rehearsalUsage()
  }
  if (values.has("--inventory") && values.get("--inventory") !== "fixed-group") {
    throw rehearsalUsage()
  }

  const allFaults = values.has("--all-faults")
  const inject = values.get("--inject") ?? null
  const resume = values.has("--resume") || allFaults
  if (allFaults === (inject !== null) || (!allFaults && !resume)) throw rehearsalUsage()
  if (inject !== null && !FIXED_GROUP_REHEARSAL_FAULTS.includes(inject)) {
    throw new Error(`Unknown fixed-group rehearsal fault: ${inject}`)
  }

  return Object.freeze({
    inventory: "fixed-group",
    allFaults,
    inject,
    resume,
  })
}

export async function runReleaseRehearsal(argv, dependencies = {}) {
  const options = parseReleaseRehearsalArguments(argv)
  if (
    dependencies === null ||
    Array.isArray(dependencies) ||
    typeof dependencies !== "object" ||
    typeof dependencies.runFixedGroup !== "function"
  ) {
    throw new TypeError("Fixed-group release rehearsal dependency is unavailable")
  }
  return dependencies.runFixedGroup(options)
}

function rehearsalUsage() {
  return new Error(
    "Usage: release:rehearse [--inventory fixed-group] (--all-faults | --inject <fault> --resume)",
  )
}

function validateFixedGroupOptions(value) {
  if (
    value === null ||
    Array.isArray(value) ||
    typeof value !== "object" ||
    Object.keys(value).sort().join(",") !== "allFaults,inject,inventory,resume" ||
    value.inventory !== "fixed-group" ||
    typeof value.allFaults !== "boolean" ||
    typeof value.resume !== "boolean" ||
    value.resume !== true ||
    (value.allFaults ? value.inject !== null : !FIXED_GROUP_REHEARSAL_FAULTS.includes(value.inject))
  ) {
    throw new TypeError("Canonical fixed-group rehearsal options are invalid")
  }
  return value
}

async function createCandidateRepositoryFixture({ sourceRoot, runtime }) {
  const home = join(runtime, "git-home")
  const config = join(runtime, "git-config")
  const remote = join(runtime, "candidate.git")
  const workingDirectory = join(runtime, "candidate")
  await Promise.all([mkdir(home), mkdir(config)])
  const environment = {
    PATH: requiredPath(),
    HOME: home,
    XDG_CONFIG_HOME: config,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    LANG: "C",
    LC_ALL: "C",
  }
  const commitSha = (await gitCommand(sourceRoot, ["rev-parse", "HEAD"], environment)).trim()
  if (!/^[0-9a-f]{40}$/u.test(commitSha)) {
    throw new Error("Fixed-group rehearsal source HEAD is not an exact SHA")
  }
  await gitCommand(runtime, ["clone", "--bare", "--no-local", sourceRoot, remote], environment)
  await gitCommand(runtime, ["clone", remote, workingDirectory], environment)
  await gitCommand(
    workingDirectory,
    ["config", "--local", "user.name", "Release Rehearsal"],
    environment,
  )
  await gitCommand(
    workingDirectory,
    ["config", "--local", "user.email", "release-rehearsal@example.invalid"],
    environment,
  )
  await gitCommand(workingDirectory, ["branch", "--force", "main", commitSha], environment)
  return Object.freeze({
    commitSha,
    workingDirectory: await realpath(workingDirectory),
    environment: Object.freeze({ ...environment }),
  })
}

async function exactCandidateTagExists(root, candidate, environment) {
  try {
    const sha = (
      await gitCommand(root, ["rev-parse", `refs/tags/v${candidate.version}^{commit}`], environment)
    ).trim()
    if (sha !== candidate.commitSha) {
      throw new Error("Fixed-group rehearsal candidate tag conflicts with the source commit")
    }
    return true
  } catch (error) {
    if (error?.code === 128) return false
    throw error
  }
}

async function isolatedGitCommand(command, args, options, environment) {
  if (command !== "git") throw new TypeError("Fixed-group rehearsal Git command is invalid")
  const result = await execFileAsync(command, args, {
    ...options,
    env: environment,
  })
  return result.stdout
}

async function gitCommand(cwd, args, env) {
  try {
    const result = await execFileAsync("git", args, {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 16 * 1024 * 1024,
    })
    return result.stdout
  } catch (error) {
    const wrapped = new Error("Fixed-group rehearsal Git command failed", { cause: error })
    Object.defineProperty(wrapped, "code", {
      value: Number.isInteger(error?.code) ? error.code : "GIT_REHEARSAL_FAILED",
      enumerable: true,
    })
    throw wrapped
  }
}

async function loadPreparedArtifactIfPresent({ artifactDir, candidate }) {
  try {
    await readFile(join(artifactDir, "manifest.json"))
  } catch (error) {
    if (error?.code === "ENOENT") return null
    throw error
  }
  return loadPreparedArtifact({ artifactDir, candidate })
}

async function loadPreparedArtifact({ artifactDir, candidate }) {
  const manifestBytes = await readFile(join(artifactDir, "manifest.json"))
  const manifest = parseSealedReleaseManifest(manifestBytes, { candidate })
  if (!manifestBytes.equals(canonicalManifestBytes(manifest))) {
    throw new Error("Fixed-group rehearsal manifest is not canonical")
  }
  const expected = ["manifest.json", ...manifest.packages.map(({ filename }) => filename)].sort()
  const actual = (await readdir(artifactDir)).sort()
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
    throw new Error("Fixed-group rehearsal artifact file set is incomplete")
  }
  const files = [
    { name: "manifest.json", bytes: manifestBytes },
    ...(await Promise.all(
      manifest.packages.map(async ({ filename }) => ({
        name: filename,
        bytes: await readFile(join(artifactDir, filename)),
      })),
    )),
  ]
  return Object.freeze({
    artifactName: manifest.artifact.name,
    manifest,
    manifestSha256: manifestSha256(manifest),
    artifact: Object.freeze({ manifest, files: Object.freeze(files) }),
  })
}

function createRehearsalReleaseRecord({ candidate, prepared }) {
  const serviceBytes = Buffer.concat(
    prepared.artifact.files.flatMap(({ name, bytes }) => [
      Buffer.from(`${name}\0`, "utf8"),
      Buffer.from(bytes),
    ]),
  )
  return createReleaseRecord({
    candidate,
    manifestSha256: prepared.manifestSha256,
    artifact: { name: prepared.artifactName },
    artifactUpload: {
      id: "900",
      digest: `sha256:${hash("sha256", serviceBytes)}`,
    },
    prepareRun: { id: 200, attempt: 1 },
  })
}

function createRehearsalAttestation({ candidate, prepared }) {
  const bundles = prepared.artifact.files.map(({ name }) => ({
    name: `${name}.intoto.jsonl`,
    bytes: Buffer.from(`fixed-group-rehearsal-bundle:${name}`, "utf8"),
  }))
  const set = Object.freeze({
    repository: "cacheplane/dawnai",
    workflow: ".github/workflows/release.yml",
    sourceRef: `refs/tags/v${candidate.version}`,
    commitSha: candidate.commitSha,
    workflowRunId: 300,
    runAttempt: 1,
    subjects: Object.freeze(
      prepared.artifact.files.map((file, index) =>
        Object.freeze({
          subjectName: file.name,
          subjectSha256: hash("sha256", file.bytes),
          bundleName: bundles[index].name,
          bundleSha256: hash("sha256", bundles[index].bytes),
        }),
      ),
    ),
  })
  return Object.freeze({ set, bundles: Object.freeze(bundles) })
}

const verifiedAttestations = Object.freeze({
  async verify({ subjects, bundles }) {
    if (!Array.isArray(subjects) || !Array.isArray(bundles) || subjects.length !== bundles.length) {
      throw new Error("Fixed-group rehearsal attestation set is incomplete")
    }
    return { status: "VERIFIED", subjects }
  },
})

function createRehearsalNpmReader(harness) {
  const registry = new URL(harness.registry.url)
  return createNpmReader({
    registryUrl: registry.href,
    trustedRegistryOrigins: [registry.origin],
    async fetchImpl(url, options) {
      const target = new URL(url)
      if (target.origin !== registry.origin) {
        throw new Error("Fixed-group rehearsal npm reader left its disposable registry")
      }
      const response = await fetch(
        new URL(`${target.pathname}${target.search}`, harness.proxy.url),
        {
          ...options,
          redirect: "manual",
        },
      )
      if (response.status !== 404) return response
      const accept = new Headers(options?.headers).get("accept") ?? ""
      if (accept === "application/vnd.npm.install-v1+json") {
        const name = decodeURIComponent(target.pathname.slice(1))
        return jsonResponse(200, { name, "dist-tags": {}, versions: {} })
      }
      if (accept === "application/json") return jsonResponse(404, { code: "E404" })
      return response
    },
  })
}

async function captureAbsentPublicationState({ candidate, manifest, npmReader }) {
  const packages = []
  for (const { name } of manifest.packages) {
    const observed = await npmReader.observePackageVersion({ name, version: candidate.version })
    if (observed.status !== "ABSENT" || observed.httpStatus !== 404 || observed.code !== "E404") {
      throw new Error(`Fixed-group rehearsal registry absence is ambiguous for ${name}`)
    }
    packages.push({
      name,
      version: candidate.version,
      status: "ABSENT",
      httpStatus: 404,
      observedAt: "2026-08-25T00:00:00Z",
    })
  }
  return Object.freeze({
    schemaVersion: 1,
    version: candidate.version,
    commitSha: candidate.commitSha,
    tag: `v${candidate.version}`,
    observedAt: "2026-08-25T00:00:00Z",
    candidateRuns: Object.freeze([]),
    registryMutationReceipts: Object.freeze([]),
    packages: Object.freeze(packages),
  })
}

function verifiedNpmAudit({ candidate }) {
  return Object.freeze({
    status: "verified",
    signature: { status: "valid", verifier: "npm-audit-signatures@11.17.0" },
    provenance: {
      predicateType: "https://slsa.dev/provenance/v1",
      workflow: candidate.publisherWorkflow,
      commitSha: candidate.commitSha,
      repository: "https://github.com/cacheplane/dawnai",
      ref: `refs/tags/v${candidate.version}`,
    },
  })
}

async function verifyRegistryBytes({ manifest, npmReader }) {
  for (const entry of manifest.packages) {
    const observed = await npmReader.observePackageVersion({
      name: entry.name,
      version: entry.version,
    })
    if (observed.status !== "PRESENT") {
      throw new Error(`Fixed-group rehearsal registry did not converge for ${entry.name}`)
    }
    const download = await npmReader.downloadRegistryTarball({
      tarballUrl: observed.package.tarballUrl,
    })
    if (
      download.status !== "PRESENT" ||
      download.tarball.size !== entry.size ||
      download.tarball.sha256 !== entry.sha256 ||
      download.tarball.sha512 !== entry.sha512
    ) {
      throw new Error(`Fixed-group rehearsal registry bytes conflict for ${entry.name}`)
    }
  }
}

function jsonResponse(status, value) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function hash(algorithm, bytes) {
  return createHash(algorithm).update(bytes).digest("hex")
}

function requiredPath() {
  const value = Reflect.get(process.env, "PATH")
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new TypeError("Fixed-group rehearsal requires a safe PATH")
  }
  return value
}

function currentMarker(remote) {
  const release = remote.snapshot().release
  if (release === null || release.draft !== true) {
    throw new Error("Release rehearsal expected one mutable draft")
  }
  return parseReleaseMarker(release.body)
}

function smokeResult({ lane, candidate, manifestSha256 }) {
  return Object.freeze({
    schemaVersion: 1,
    lane,
    version: candidate.version,
    commitSha: candidate.commitSha,
    manifestSha256,
    workflowRunId: 400,
    runAttempt: 1,
    startedAt: "2026-08-25T00:10:00.000Z",
    finishedAt: "2026-08-25T00:11:00.000Z",
    checks: [{ name: "exact-local-registry", conclusion: "success", detail: "verified" }],
    conclusion: "success",
  })
}

function auditResult({ candidate, manifestSha256, workflowRunId, conclusion }) {
  return Object.freeze({
    schemaVersion: 1,
    version: candidate.version,
    commitSha: candidate.commitSha,
    manifestSha256,
    workflowRunId,
    runAttempt: 1,
    startedAt: "2026-08-25T01:00:00Z",
    finishedAt: "2026-08-25T01:01:00Z",
    checks: [
      {
        name: "published-artifacts",
        conclusion,
        detail: conclusion === "success" ? "verified" : "injected retryable failure",
      },
    ],
    conclusion,
  })
}

function durableSnapshot(state) {
  if (state === undefined) throw new TypeError("Release rehearsal durable state is invalid")
  return Object.freeze({
    smokeLanes: Object.freeze([...state.smokeResults.keys()]),
    initialDispatchRunId: state.initialDispatch?.workflowRunId ?? null,
    retryDispatchRunId: state.retryDispatch?.workflowRunId ?? null,
  })
}

function rehearsalMutationSnapshot(remote, state) {
  return JSON.stringify({ remote: remote.snapshot(), durable: durableSnapshot(state) })
}

function evidenceResult(remote, state, before) {
  const observed = remote.snapshot()
  const release = observed.release
  if (release === null || release.draft !== false || release.immutable !== true) {
    throw new Error("Release rehearsal immutable publication is incomplete")
  }
  return Object.freeze({
    status: "AUDIT_COMPLETE",
    immutable: true,
    mutations: rehearsalMutationSnapshot(remote, state) === before ? 0 : 1,
    releaseId: release.id,
  })
}
