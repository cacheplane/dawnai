import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { createGitReader } from "../../adapters/git.mjs"
import { createNpmReader } from "../../adapters/npm.mjs"
import { loadVerifiedReleaseArtifact } from "../../artifact-store.mjs"
import {
  dispatchIndependentAudit,
  recordAuditAttempt,
  recordAuditDispatch,
  verifyAuditSuccess,
} from "../../audit.mjs"
import { runReleaseCli } from "../../cli.mjs"
import { runIndependentAudit } from "../../independent-audit.mjs"
import { readReleaseInventory } from "../../inventory.mjs"
import {
  canonicalManifestBytes,
  manifestSha256,
  parseSealedReleaseManifest,
} from "../../manifest.mjs"
import {
  canonicalBaseAssetSet,
  parseReleaseMarker,
  parseSmokeReleaseAssetName,
  publishConsolidatedRelease,
  reconcileNpmEvidence,
  reconcileSmokeEvidence,
} from "../../metadata.mjs"
import { canonicalNpmEvidenceBytes } from "../../npm-evidence.mjs"
import { observeProductionCandidate } from "../../observe.mjs"
import { planRelease } from "../../planner.mjs"
import { createReleasePreparationRunner } from "../../process-runner.mjs"
import { publishManifestSerially } from "../../publisher.mjs"
import {
  canonicalSmokeResultBytes,
  REQUIRED_RELEASE_SMOKE_LANES,
  writeCanonicalSmokeResult,
} from "../../smoke-result.mjs"
import { canonicalAuditResultBytes, parseAuditResult } from "../../terminal-records.mjs"
import {
  createRehearsalCliObserver,
  runRehearsalControllerStep,
} from "./release-rehearsal-controller.mjs"
import {
  createRehearsalArtifactUploadResult,
  createRehearsalGitHub,
} from "./release-rehearsal-github.mjs"

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
  ...REQUIRED_RELEASE_SMOKE_LANES.map((lane) => `smoke-result:${lane}`),
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

export async function driveRehearsalController({
  candidate,
  observer,
  effects,
  reporter,
  maximumAttempts,
}) {
  if (!Number.isSafeInteger(maximumAttempts) || maximumAttempts < 1 || maximumAttempts > 10_000) {
    throw new TypeError("Release rehearsal controller attempt bound is invalid")
  }
  const recoveredFaults = []
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    let report
    try {
      report = await runRehearsalControllerStep({ candidate, observer, effects, reporter })
    } catch (error) {
      const crash = rehearsalCrashCause(error)
      if (crash === null) {
        const route = error?.report?.transition?.name ?? "unknown-route"
        const code = typeof error?.code === "string" ? error.code : "UNKNOWN_FAILURE"
        const causes = nestedErrorMessages(error).join(" <- ") || "unknown cause"
        throw new Error(`Release rehearsal production route ${route} failed (${code}): ${causes}`, {
          cause: error,
        })
      }
      recoveredFaults.push(crash.point)
      continue
    }
    if (
      report.before.plan.state === "AUDIT_COMPLETE" &&
      report.before.plan.disposition === "noop" &&
      report.transition.name === null &&
      report.transition.status === "not-required"
    ) {
      return Object.freeze({
        state: "AUDIT_COMPLETE",
        recoveredFaults: Object.freeze([...recoveredFaults]),
        terminalReport: report,
      })
    }
    if (report.before.plan.disposition !== "would-transition") {
      const diagnostics =
        typeof observer.latestDiagnostics === "function"
          ? observer
              .latestDiagnostics()
              .map((entry) => entry?.code)
              .filter((code) => typeof code === "string")
          : []
      throw new Error(
        `Release rehearsal controller stopped before audit completion in ${report.before.plan.state} (${report.before.plan.disposition}; conflicts: ${report.before.plan.conflicts.join(",") || "none"}; diagnostics: ${diagnostics.join(",") || "none"}; reasons: ${report.before.plan.reasons.join(",") || "none"})`,
      )
    }
  }
  throw new Error("Release rehearsal controller exceeded its bounded transition attempts")
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

export function createExactCandidateCommandRunner({ root, run }) {
  if (
    typeof root !== "string" ||
    !isAbsolute(root) ||
    resolve(root) !== root ||
    typeof run !== "function"
  ) {
    throw new TypeError("Exact candidate command runner dependencies are invalid")
  }
  return async function runExactCandidateCommand(command, args, options) {
    if (
      ["git", "pnpm", "tar"].includes(command) &&
      (options === null ||
        Array.isArray(options) ||
        typeof options !== "object" ||
        options.cwd !== root)
    ) {
      throw new Error("Release preparation command escaped the exact candidate checkout")
    }
    return run(command, args, options)
  }
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
    for (const lane of REQUIRED_RELEASE_SMOKE_LANES) {
      if (state.smokeResults.has(lane)) continue
      state.smokeResults.set(
        lane,
        canonicalSmokeResultBytes(
          smokeResult({ lane, candidate, manifestSha256: record.manifestSha256 }),
        ),
      )
    }
    remote.recordSmokeArtifacts({
      receipts: REQUIRED_RELEASE_SMOKE_LANES.map((lane) => state.smokeResults.get(lane)),
      workflowRunId: 400,
      runAttempt: 1,
    })
    await reconcileSmokeEvidence({
      candidate,
      record,
      manifest,
      npmEvidence,
      smokeResults: REQUIRED_RELEASE_SMOKE_LANES.map((lane) => state.smokeResults.get(lane)),
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
  const controllerDir = join(runtime, "controller")
  let registryHarness = null
  try {
    await mkdir(controllerDir)
    const candidateRepository = await createCandidateRepositoryFixture({
      sourceRoot: canonicalRoot,
      runtime,
    })
    const inventory = await readReleaseInventory({
      root: candidateRepository.workingDirectory,
      ref: candidateRepository.commitSha,
    })
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
    const preparationRun = createExactCandidateCommandRunner({
      root: candidateRepository.workingDirectory,
      run: createReleasePreparationRunner(),
    })
    const paths = await writeCanonicalRehearsalInputs({
      directory: controllerDir,
      artifactDir,
      candidate,
      inventory,
    })
    const git = createGitReader({ root: candidateRepository.workingDirectory })
    const productionInventory = createRehearsalProductionInventory({
      candidate,
      inventory,
      parentSha: await git.firstParent(candidate.commitSha),
    })
    const controllerMarker = JSON.parse(
      await readFile(
        join(candidateRepository.workingDirectory, "scripts/release/controller-schema.json"),
        "utf8",
      ),
    )
    let npmReader = absentRehearsalNpmReader()
    const npm = deferredNpmReader(() => npmReader)
    const remote = createRehearsalGitHub({
      candidate,
      gate,
      async tagResolver() {
        return (await exactCandidateTagExists(
          candidateRepository.workingDirectory,
          candidate,
          candidateRepository.environment,
        ))
          ? candidate.commitSha
          : null
      },
    })
    let prepared = null
    let attestation = null
    let record = null
    let base = null
    let npmEvidence = null
    let registryConverged = false
    let smokeReceipts = null
    let fallback = null
    const acceptedPackages = new Set()
    let initialDispatch = null
    let retryDispatch = null
    let dispatchSequence = 0
    let auditSequence = 0
    const independentAuditResults = new Map()
    const controllerReports = []

    async function ensureRegistry() {
      if (registryHarness !== null) return
      registryHarness = await createFaultHarness({
        fixtureDirectory: THREE_PACKAGE_FIXTURE,
        publishRoots: [artifactDir],
      })
      npmReader = createProductionRehearsalNpmReader(registryHarness)
    }

    async function observeAndPublishManifest() {
      await ensureRegistry()
      remote.recordPublisherStarted()
      return publishManifestSerially({
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
          if ([1, 11, 21].includes(ordinal)) await gate.around(`publish:${ordinal}`, publish)
          else await publish()
        },
        async poll() {},
        log() {},
      })
    }

    async function ensureNpmEvidence() {
      npmEvidence = await observeAndPublishManifest()
      if (!registryConverged) {
        await gate.around("registry-convergence", async () => {
          await verifyRegistryBytes({ manifest: prepared.manifest, npmReader })
          registryConverged = true
        })
      }
      await writeCanonicalOrEqual(
        paths.npmEvidence,
        canonicalNpmEvidenceBytes(npmEvidence, {
          candidate,
          manifest: prepared.manifest,
          manifestSha256: record.manifestSha256,
        }),
      )
      return npmEvidence
    }

    async function dispatchAudit(retry) {
      let durable = retry ? retryDispatch : initialDispatch
      if (durable === null) {
        dispatchSequence += 1
        const temporary = join(controllerDir, `dispatch-response-${dispatchSequence}.json`)
        const receipt = await runReleaseCli(
          [
            "dispatch-audit",
            "--version",
            candidate.version,
            "--commit-sha",
            candidate.commitSha,
            "--manifest-sha256",
            record.manifestSha256,
            "--output",
            temporary,
          ],
          {
            cwd: controllerDir,
            github: { reader: remote.releaseGitHub.reader, writer: remote.actionsWriter },
          },
        )
        const durablePath = retry ? paths.retryDispatch : paths.initialDispatch
        const transition = retry ? "retry-audit-dispatch-receipt" : "audit-dispatch-receipt"
        await gate.around(transition, async () => {
          await writeCanonicalOrEqual(
            durablePath,
            Buffer.from(`${JSON.stringify(receipt)}\n`, "utf8"),
          )
          durable = Object.freeze({ receipt, path: durablePath })
          if (retry) retryDispatch = durable
          else initialDispatch = durable
        })
      }
      await runReleaseCli(
        [
          "record-audit-dispatch",
          "--candidate",
          paths.candidate,
          "--dispatch-result",
          durable.path,
        ],
        { cwd: controllerDir, github: remote.releaseGitHub },
      )
      return durable.receipt
    }

    async function executeIndependentAuditor(dispatch) {
      const workflowRunId = dispatch.workflowRunId
      const expectedConclusion =
        workflowRunId === initialDispatch?.receipt.workflowRunId ? "failure" : "success"
      const output = join(controllerDir, `independent-audit-${workflowRunId}-1.json`)
      const auditInventory =
        expectedConclusion === "failure"
          ? createFailingIndependentAuditInventory(productionInventory, candidate)
          : productionInventory
      let executionError = null
      try {
        await runIndependentAudit(
          [
            "--version",
            candidate.version,
            "--commit-sha",
            candidate.commitSha,
            "--manifest-sha256",
            record.manifestSha256,
            "--result",
            output,
          ],
          {
            cwd: candidateRepository.workingDirectory,
            environment: independentAuditEnvironment({ candidate, workflowRunId }),
            async createRuntime() {
              return {
                git,
                github: remote.releaseGitHub.reader,
                npm,
                npmAuditFactory: rehearsalNpmAuditFactory(candidate),
                attestations: verifiedAttestations,
                inventory: auditInventory,
                controllerMarker,
                observeProductionCandidate,
                planRelease,
              }
            },
            now: deterministicIndependentAuditClock(),
            clock: () => 0,
            pollAttempts: 1,
            pollDelayMs: 0,
            pollTimeoutMs: 1_000,
            async delay() {},
            async writeResult(target, result) {
              const bytes = canonicalAuditResultBytes(result)
              await writeCanonicalOrEqual(target, bytes)
              await remote.recordIndependentAuditResult({ workflowRunId, result, bytes })
            },
          },
        )
      } catch (error) {
        executionError = error
      }
      const outputBytes = await readFile(output)
      const result = parseAuditResult(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(outputBytes)),
      )
      if (
        !outputBytes.equals(canonicalAuditResultBytes(result)) ||
        result.workflowRunId !== workflowRunId ||
        result.runAttempt !== 1 ||
        result.conclusion !== expectedConclusion ||
        (expectedConclusion === "success") !== (executionError === null)
      ) {
        const executionDetail =
          executionError === null
            ? "none"
            : `${executionError.code ?? "UNKNOWN"}:${executionError.message ?? "unknown error"}`
        throw new Error(
          `Release rehearsal independent auditor conclusion conflicts (expected ${expectedConclusion}, observed ${result.conclusion}, execution ${executionDetail})`,
        )
      }
      independentAuditResults.set(workflowRunId, result)
      return result
    }

    const effects = Object.freeze({
      async "create-candidate-tag"() {
        return gate.around("tag", () =>
          runReleaseCli(["tag", "--candidate", paths.candidate], {
            cwd: candidateRepository.workingDirectory,
          }),
        )
      },
      async "prepare-artifacts"() {
        return gate.around("prepare", async () => {
          await preparationRun(
            "pnpm",
            ["install", "--offline", "--frozen-lockfile", "--ignore-scripts"],
            { cwd: candidateRepository.workingDirectory },
          )
          await runReleaseCli(
            [
              "prepare",
              "--candidate",
              paths.candidate,
              "--inventory",
              paths.inventory,
              "--root",
              candidateRepository.workingDirectory,
              "--output-dir",
              artifactDir,
              "--ci-receipt",
              paths.ci,
              "--prepare-run",
              paths.prepareRun,
              "--preparation-authority",
              paths.preparationAuthority,
              "--source-ref",
              `refs/tags/v${candidate.version}`,
            ],
            { cwd: candidateRepository.workingDirectory },
          )
          await assertCleanRehearsalCheckout(
            candidateRepository.workingDirectory,
            candidateRepository.environment,
            "candidate",
          )
          prepared = await loadPreparedArtifact({ artifactDir, candidate })
          const upload = createRehearsalArtifactUploadResult({
            candidate,
            artifact: prepared.artifact,
          })
          await writeCanonicalOrEqual(
            paths.artifactUpload,
            Buffer.from(`${JSON.stringify(upload)}\n`, "utf8"),
          )
          record = await runReleaseCli(
            [
              "record-artifact",
              "--candidate",
              paths.candidate,
              "--manifest",
              join(artifactDir, "manifest.json"),
              "--artifact-upload-result",
              paths.artifactUpload,
              "--output",
              paths.record,
            ],
            { cwd: controllerDir },
          )
          remote.recordPreparedArtifact({ record, artifact: prepared.artifact })
          return { packageCount: prepared.manifest.packages.length }
        })
      },
      async "attest-artifacts"() {
        return gate.around("attest", async () => {
          await runReleaseCli(
            [
              "attestation-input",
              "--record",
              paths.record,
              "--artifact-dir",
              artifactDir,
              "--output",
              paths.attestationInput,
            ],
            { cwd: controllerDir },
          )
          attestation = createRehearsalAttestation({ candidate, prepared })
          await writeCanonicalOrEqual(paths.attestationBundle, attestation.bundleBytes)
          base = canonicalBaseAssetSet({
            record,
            artifact: prepared.artifact,
            attestationSet: attestation.set,
            bundles: attestation.bundles,
          })
          remote.recordBaseAssetNames(base.assets.map(({ name }) => name))
          return { subjectCount: attestation.set.subjects.length }
        })
      },
      async "escrow-candidate"() {
        await ensureRegistry()
        const result = await runReleaseCli(
          [
            "escrow",
            "--candidate",
            paths.candidate,
            "--record",
            paths.record,
            "--artifact-dir",
            artifactDir,
            "--attestation-bundle",
            paths.attestationBundle,
          ],
          {
            cwd: controllerDir,
            github: remote.releaseGitHub,
            npm,
            attestations: verifiedAttestations,
            environment: releaseRehearsalEnvironment(candidate),
            now: () => Date.parse("2026-08-25T00:05:00.000Z"),
          },
        )
        fallback ??= await verifyExpiredActionsEscrowFallback({ record, remote })
        return result
      },
      async "publish-npm-packages"() {
        return ensureNpmEvidence()
      },
      async "resume-npm-publish"() {
        return ensureNpmEvidence()
      },
      async "reconcile-npm-evidence"() {
        await ensureNpmEvidence()
        return runReleaseCli(
          [
            "reconcile-npm",
            "--candidate",
            paths.candidate,
            "--record",
            paths.record,
            "--manifest",
            join(artifactDir, "manifest.json"),
            "--npm-evidence",
            paths.npmEvidence,
          ],
          { cwd: controllerDir, github: remote.releaseGitHub },
        )
      },
      async "run-release-smokes"() {
        if (smokeReceipts === null) {
          await mkdir(paths.smokeResults)
          smokeReceipts = []
          for (const lane of REQUIRED_RELEASE_SMOKE_LANES) {
            const value = smokeResult({
              lane,
              candidate,
              manifestSha256: record.manifestSha256,
            })
            const target = join(paths.smokeResults, `${lane}.json`)
            await writeCanonicalSmokeResult(target, value)
            smokeReceipts.push(await readFile(target))
          }
          smokeReceipts = Object.freeze(smokeReceipts)
          remote.recordSmokeArtifacts({
            receipts: smokeReceipts,
            workflowRunId: 400,
            runAttempt: 1,
          })
        }
        return { lanes: [...REQUIRED_RELEASE_SMOKE_LANES] }
      },
      async "reconcile-smoke-evidence"() {
        return runReleaseCli(
          [
            "reconcile-smokes",
            "--candidate",
            paths.candidate,
            "--record",
            paths.record,
            "--manifest",
            join(artifactDir, "manifest.json"),
            "--npm-evidence",
            paths.npmEvidence,
            "--smoke-results",
            paths.smokeResults,
          ],
          {
            cwd: controllerDir,
            github: remote.releaseGitHub,
            environment: { GITHUB_RUN_ID: "400", GITHUB_RUN_ATTEMPT: "1" },
          },
        )
      },
      async "dispatch-release-audit"({ observation }) {
        return dispatchAudit(observation.release.marker.phase === "AUDIT_RETRYABLE")
      },
      async "complete-release-audit"({ observation }) {
        const workflowRunId = observation.release.marker.audit.workflowRunId
        const dispatch = [initialDispatch, retryDispatch].find(
          (entry) => entry?.receipt.workflowRunId === workflowRunId,
        )
        if (dispatch === undefined) {
          throw new Error("Release rehearsal lost the direct audit dispatch receipt")
        }
        await executeIndependentAuditor(dispatch.receipt)
        auditSequence += 1
        const auditPath = join(controllerDir, `audit-result-${workflowRunId}-${auditSequence}.json`)
        const result = await runReleaseCli(
          [
            "wait-audit",
            "--candidate",
            paths.candidate,
            "--dispatch-result",
            dispatch.path,
            "--output",
            auditPath,
          ],
          {
            cwd: controllerDir,
            github: { reader: remote.releaseGitHub.reader, writer: remote.actionsWriter },
            wait: async () => {},
            now: monotonicRehearsalClock(),
          },
        )
        await runReleaseCli(
          [
            "correlate-audit",
            "--candidate",
            paths.candidate,
            "--dispatch-result",
            dispatch.path,
            "--audit-result",
            auditPath,
          ],
          { cwd: controllerDir, github: remote.releaseGitHub },
        )
        return { workflowRunId, conclusion: result.conclusion }
      },
      async "publish-github-release"() {
        const auditPath = await downloadCanonicalAuditResult({
          directory: controllerDir,
          remote,
          sequence: auditSequence + 1,
        })
        return runReleaseCli(
          [
            "publish-release",
            "--candidate",
            paths.candidate,
            "--record",
            paths.record,
            "--audit-result",
            auditPath,
          ],
          { cwd: controllerDir, github: remote.releaseGitHub },
        )
      },
    })
    const observer = createRehearsalCliObserver({
      candidate,
      directory: controllerDir,
      dependencies: {
        cwd: candidateRepository.workingDirectory,
        git,
        inventory: productionInventory,
        githubReader: remote.releaseGitHub.reader,
        npm,
        npmAuditFactory: rehearsalNpmAuditFactory(candidate),
        attestations: verifiedAttestations,
      },
      receipts: {
        async readAttestation() {
          return attestation === null
            ? null
            : { record, artifact: prepared.artifact, bundleBytes: attestation.bundleBytes }
        },
        async readSmokes() {
          return smokeReceipts
        },
      },
    })
    const reporter = Object.freeze({
      async write(report) {
        controllerReports.push(report)
      },
    })
    const final = await driveRehearsalController({
      candidate,
      observer,
      effects,
      reporter,
      maximumAttempts: faultPoints.length + 64,
    })
    if (gate.snapshot().remaining.length !== 0) {
      throw new Error("Fixed-group release rehearsal did not consume every requested fault")
    }
    const beforeReplay = JSON.stringify(remote.snapshot())
    const replay = await runRehearsalControllerStep({ candidate, observer, effects, reporter })
    if (
      replay.before.plan.state !== "AUDIT_COMPLETE" ||
      replay.before.plan.disposition !== "noop" ||
      replay.transition.status !== "not-required" ||
      JSON.stringify(remote.snapshot()) !== beforeReplay
    ) {
      throw new Error("Fixed-group release replay was not a production-controller no-op")
    }
    const observed = remote.snapshot()
    if (
      observed.release === null ||
      observed.release.draft !== false ||
      observed.release.immutable !== true ||
      fallback?.source !== "escrow"
    ) {
      throw new Error("Fixed-group release rehearsal did not reach immutable publication")
    }
    const baseNames = new Set(base.assets.map(({ name }) => name))
    const baseAssetCount = observed.assets.filter(({ name }) => baseNames.has(name)).length
    const smokeAssetCount = observed.assets.filter(
      ({ name }) => parseSmokeReleaseAssetName(name) !== null,
    ).length
    const auditAssetCount = observed.assets.length - baseAssetCount - smokeAssetCount
    const auditConclusions = [...independentAuditResults.values()].map(
      ({ workflowRunId, runAttempt, conclusion, checks }) => ({
        workflowRunId,
        runAttempt,
        conclusion,
        checkCount: checks.length,
      }),
    )
    if (
      acceptedPackages.size !== 21 ||
      baseAssetCount !== 45 ||
      smokeAssetCount !== REQUIRED_RELEASE_SMOKE_LANES.length ||
      auditAssetCount !== 3 ||
      observed.assets.length !== 53 ||
      auditConclusions.length !== 2 ||
      auditConclusions[0].conclusion !== "failure" ||
      auditConclusions[1].conclusion !== "success"
    ) {
      throw new Error("Fixed-group release rehearsal terminal inventory is incomplete")
    }
    const controllerRoutes = controllerReports
      .map(({ transition }) => transition.name)
      .filter((name, index, names) => name !== null && names.indexOf(name) === index)
    const requiredControllerRoutes = [
      "create-candidate-tag",
      "prepare-artifacts",
      "attest-artifacts",
      "escrow-candidate",
      "publish-npm-packages",
      "reconcile-npm-evidence",
      "run-release-smokes",
      "reconcile-smoke-evidence",
      "dispatch-release-audit",
      "complete-release-audit",
      "publish-github-release",
    ]
    if (
      faultPoints.some((point) =>
        ["after-publish:1", "before-publish:11", "after-publish:11", "before-publish:21"].includes(
          point,
        ),
      )
    ) {
      requiredControllerRoutes.push("resume-npm-publish")
    }
    if (requiredControllerRoutes.some((route) => !controllerRoutes.includes(route))) {
      throw new Error("Fixed-group release rehearsal bypassed a production controller route")
    }
    return Object.freeze({
      schemaVersion: 1,
      status: final.state,
      inventory: "fixed-group",
      version: candidate.version,
      commitSha: candidate.commitSha,
      packageCount: acceptedPackages.size,
      registryVerified: true,
      baseAssetCount,
      smokeAssetCount,
      auditAssetCount,
      totalAssetCount: observed.assets.length,
      dispatchedAuditRuns: observed.dispatchedRunIds.length,
      orphanedAuditRuns: observed.dispatchedRunIds.length - 2,
      independentAuditRuns: Object.freeze(auditConclusions),
      actionsArtifactRecovery: fallback.source,
      immutable: observed.release.immutable,
      replay: "noop",
      controllerRoutes: Object.freeze(controllerRoutes),
      controllerReportCount: controllerReports.length,
      injectedFaults: gate.snapshot().injected,
    })
  } finally {
    await registryHarness?.close()
    await rm(runtime, { recursive: true, force: true })
  }
}

async function writeCanonicalRehearsalInputs({ directory, artifactDir, candidate, inventory }) {
  const paths = Object.freeze({
    candidate: join(directory, "candidate.json"),
    inventory: join(directory, "inventory.json"),
    ci: join(directory, "ci-receipt.json"),
    prepareRun: join(directory, "prepare-run.json"),
    preparationAuthority: join(directory, "preparation-authority.json"),
    artifactUpload: join(directory, "artifact-upload.json"),
    record: join(directory, "release-record.json"),
    attestationInput: join(directory, "attestation-input.txt"),
    attestationBundle: join(directory, "attestation.intoto.jsonl"),
    npmEvidence: join(directory, "npm-evidence.json"),
    smokeResults: join(directory, "smoke-results"),
    initialDispatch: join(directory, "audit-dispatch-initial.json"),
    retryDispatch: join(directory, "audit-dispatch-retry.json"),
    artifactDir,
  })
  await Promise.all([
    writeCanonicalOrEqual(paths.candidate, Buffer.from(`${JSON.stringify(candidate)}\n`, "utf8")),
    writeCanonicalOrEqual(paths.inventory, Buffer.from(`${JSON.stringify(inventory)}\n`, "utf8")),
    writeCanonicalOrEqual(
      paths.ci,
      Buffer.from(
        `${JSON.stringify({
          status: "success",
          retryable: false,
          commitSha: candidate.commitSha,
          workflow: "CI",
          check: "validate",
          runId: 100,
          runAttempt: 1,
        })}\n`,
        "utf8",
      ),
    ),
    writeCanonicalOrEqual(
      paths.prepareRun,
      Buffer.from(`${JSON.stringify({ id: 300, attempt: 1 })}\n`, "utf8"),
    ),
    writeCanonicalOrEqual(
      paths.preparationAuthority,
      Buffer.from(
        `${JSON.stringify({
          state: "CANDIDATE_TAGGED",
          releaseRecord: "absent",
          npm: "absent",
        })}\n`,
        "utf8",
      ),
    ),
  ])
  return paths
}

function createRehearsalProductionInventory({ candidate, inventory, parentSha }) {
  const packageNames = inventory.workspacePackages
    .filter((pkg) => pkg.private !== true)
    .map((pkg) => pkg.name)
    .sort(compareText)
  if (packageNames.length !== 21 || new Set(packageNames).size !== 21) {
    throw new Error("Release rehearsal production inventory is not the exact fixed group")
  }
  const previousVersion = previousPatchVersion(candidate.version)
  return Object.freeze({
    async read({ ref }) {
      if (typeof ref !== "string" || ref.length === 0) {
        throw new TypeError("Release rehearsal production inventory ref is invalid")
      }
      const version = ref === candidate.commitSha ? candidate.version : previousVersion
      if (ref === parentSha && version !== previousVersion) {
        throw new Error("Release rehearsal first-parent inventory is invalid")
      }
      return Object.freeze({
        status: "valid",
        packages: Object.freeze(packageNames.map((name) => Object.freeze({ name, version }))),
      })
    },
  })
}

function previousPatchVersion(version) {
  const match = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u.exec(version)
  if (match === null || Number(match[3]) < 1) {
    throw new Error("Release rehearsal version requires a preceding patch version")
  }
  return `${match[1]}.${match[2]}.${Number(match[3]) - 1}`
}

function deferredNpmReader(readCurrent) {
  if (typeof readCurrent !== "function") {
    throw new TypeError("Release rehearsal deferred npm reader is invalid")
  }
  return Object.freeze({
    observePackageMetadata(input) {
      return readCurrent().observePackageMetadata(input)
    },
    observePackageVersion(input) {
      return readCurrent().observePackageVersion(input)
    },
    downloadRegistryTarball(input) {
      return readCurrent().downloadRegistryTarball(input)
    },
  })
}

function absentRehearsalNpmReader() {
  return Object.freeze({
    async observePackageMetadata() {
      return { status: "ABSENT", operation: "package-metadata", httpStatus: 404, code: "E404" }
    },
    async observePackageVersion() {
      return { status: "ABSENT", operation: "package-version", httpStatus: 404, code: "E404" }
    },
    async downloadRegistryTarball() {
      throw new Error("Release rehearsal absent npm package has no tarball")
    },
  })
}

function rehearsalNpmAuditFactory(candidate) {
  return Object.freeze({
    async create() {
      return Object.freeze({
        async verifyPackage({ entry }) {
          return verifiedNpmAudit({ candidate, entry })
        },
        async dispose() {},
      })
    },
  })
}

function releaseRehearsalEnvironment(candidate) {
  return Object.freeze({
    GITHUB_REPOSITORY: "cacheplane/dawnai",
    GITHUB_WORKFLOW_REF: `cacheplane/dawnai/${candidate.publisherWorkflow}@refs/tags/v${candidate.version}`,
    GITHUB_REF: `refs/tags/v${candidate.version}`,
    GITHUB_SHA: candidate.commitSha,
    GITHUB_RUN_ID: "300",
    GITHUB_RUN_ATTEMPT: "1",
  })
}

function independentAuditEnvironment({ candidate, workflowRunId }) {
  return Object.freeze({
    GITHUB_REPOSITORY: "cacheplane/dawnai",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_WORKFLOW_REF: `cacheplane/dawnai/.github/workflows/published-artifact-verify.yml@refs/tags/v${candidate.version}`,
    GITHUB_REF: `refs/tags/v${candidate.version}`,
    GITHUB_SHA: candidate.commitSha,
    GITHUB_RUN_ID: String(workflowRunId),
    GITHUB_RUN_ATTEMPT: "1",
  })
}

function deterministicIndependentAuditClock() {
  let invocation = 0
  const values = [new Date("2026-08-25T01:00:00.000Z"), new Date("2026-08-25T01:01:00.000Z")]
  return () => new Date(values[Math.min(invocation++, values.length - 1)])
}

function createFailingIndependentAuditInventory(inventory, candidate) {
  return Object.freeze({
    async read(input) {
      const value = await inventory.read(input)
      if (input?.ref !== candidate.commitSha || !Array.isArray(value?.packages)) return value
      return {
        ...value,
        packages: value.packages.map((pkg, index) =>
          index === 0 ? { ...pkg, version: previousPatchVersion(candidate.version) } : pkg,
        ),
      }
    },
  })
}

function monotonicRehearsalClock() {
  let value = Date.parse("2026-08-25T01:02:00.000Z")
  return () => {
    value += 1
    return value
  }
}

async function downloadCanonicalAuditResult({ directory, remote, sequence }) {
  const release = remote.snapshot().release
  if (release === null) throw new Error("Release rehearsal audit Release is missing")
  const listed = await remote.releaseGitHub.reader.listReleaseAssets({ releaseId: release.id })
  const assets = listed?.value
  const matches = Array.isArray(assets)
    ? assets.filter(({ name }) => name === "audit-result.json")
    : []
  if (matches.length !== 1) throw new Error("Release rehearsal canonical audit asset is missing")
  const download = await remote.releaseGitHub.reader.downloadReleaseAsset({
    assetId: matches[0].id,
    maximumBytes: matches[0].size,
  })
  if (
    download?.status !== "PRESENT" ||
    typeof download.contentBase64 !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(matches[0].digest)
  ) {
    throw new Error("Release rehearsal canonical audit download is invalid")
  }
  const bytes = Buffer.from(download.contentBase64, "base64")
  if (
    bytes.toString("base64") !== download.contentBase64 ||
    `sha256:${hash("sha256", bytes)}` !== matches[0].digest
  ) {
    throw new Error("Release rehearsal canonical audit bytes conflict")
  }
  const target = join(directory, `canonical-audit-result-${sequence}.json`)
  await writeCanonicalOrEqual(target, bytes)
  return target
}

async function writeCanonicalOrEqual(path, bytes) {
  const content = Buffer.from(bytes)
  try {
    const existing = await readFile(path)
    if (!existing.equals(content)) throw new Error(`Release rehearsal file conflicts: ${path}`)
    return
  } catch (error) {
    if (error?.code !== "ENOENT") throw error
  }
  await writeFile(path, content, { flag: "wx", mode: 0o600 })
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

export async function createCandidateRepositoryFixture({ sourceRoot, runtime }) {
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
  await assertCleanRehearsalCheckout(sourceRoot, environment, "source")
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
  await gitCommand(workingDirectory, ["checkout", "--detach", commitSha], environment)
  await gitCommand(workingDirectory, ["branch", "--force", "main", commitSha], environment)
  const sourceHeadAfterClone = (
    await gitCommand(sourceRoot, ["rev-parse", "HEAD"], environment)
  ).trim()
  if (sourceHeadAfterClone !== commitSha) {
    throw new Error("Fixed-group rehearsal source HEAD drifted while cloning the candidate")
  }
  await assertCleanRehearsalCheckout(sourceRoot, environment, "source")
  const candidateHead = (
    await gitCommand(workingDirectory, ["rev-parse", "HEAD"], environment)
  ).trim()
  if (candidateHead !== commitSha) {
    throw new Error("Fixed-group rehearsal candidate checkout does not match the source commit")
  }
  await assertCleanRehearsalCheckout(workingDirectory, environment, "candidate")
  return Object.freeze({
    commitSha,
    workingDirectory: await realpath(workingDirectory),
    environment: Object.freeze({ ...environment }),
  })
}

async function assertCleanRehearsalCheckout(root, environment, label) {
  const status = await gitCommand(
    root,
    ["status", "--porcelain=v1", "--untracked-files=all"],
    environment,
  )
  if (status !== "") {
    throw new Error(`Fixed-group rehearsal ${label} checkout must be clean with no source drift`)
  }
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

function createRehearsalAttestation({ candidate, prepared }) {
  const repository = "https://github.com/cacheplane/dawnai"
  const ref = `refs/tags/v${candidate.version}`
  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    subject: prepared.artifact.files.map(({ name, bytes }) => ({
      name,
      digest: { sha256: hash("sha256", bytes) },
    })),
    predicateType: "https://slsa.dev/provenance/v1",
    predicate: {
      buildDefinition: {
        buildType: "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1",
        externalParameters: {
          workflow: {
            ref,
            repository,
            path: candidate.publisherWorkflow,
          },
        },
        internalParameters: { github: { event_name: "workflow_dispatch" } },
        resolvedDependencies: [
          { uri: `git+${repository}@${ref}`, digest: { gitCommit: candidate.commitSha } },
        ],
      },
      runDetails: {
        builder: { id: "https://github.com/actions/runner/github-hosted" },
        metadata: {
          invocationId: "https://github.com/cacheplane/dawnai/actions/runs/300/attempts/1",
        },
      },
    },
  }
  const bundleBytes = Buffer.from(
    `${JSON.stringify({
      mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
      verificationMaterial: {
        certificate: { rawBytes: "release-rehearsal" },
        tlogEntries: [{}],
        timestampVerificationData: { rfc3161Timestamps: [] },
      },
      dsseEnvelope: {
        payload: Buffer.from(JSON.stringify(statement)).toString("base64"),
        payloadType: "application/vnd.in-toto+json",
        signatures: [{ sig: "verified-by-release-rehearsal", keyid: "" }],
      },
    })}\n`,
    "utf8",
  )
  const bundleSha256 = hash("sha256", bundleBytes)
  const bundles = prepared.artifact.files.map(({ name }) => ({
    name: `${name}.intoto.jsonl`,
    bytes: bundleBytes,
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
          bundleSha256,
        }),
      ),
    ),
  })
  return Object.freeze({ set, bundles: Object.freeze(bundles), bundleBytes })
}

const verifiedAttestations = Object.freeze({
  async verify({ source, subjects, files, bundles }) {
    if (
      source !== "escrow" ||
      !Array.isArray(subjects) ||
      !Array.isArray(files) ||
      !Array.isArray(bundles) ||
      subjects.length !== 22 ||
      files.length !== subjects.length ||
      bundles.length !== subjects.length
    ) {
      throw new Error("Fixed-group rehearsal attestation set is incomplete")
    }
    const anchor = Buffer.from(bundles[0].bytes)
    for (const [index, subject] of subjects.entries()) {
      const file = files[index]
      const bundle = bundles[index]
      if (
        file.name !== subject.name ||
        hash("sha256", file.bytes) !== subject.sha256 ||
        !Buffer.from(bundle.bytes).equals(anchor)
      ) {
        throw new Error("Fixed-group rehearsal attestation evidence conflicts")
      }
    }
    return { status: "VERIFIED", subjects }
  },
})

function createProductionRehearsalNpmReader(harness) {
  const registry = new URL(harness.registry.url)
  const local = createNpmReader({
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
  return Object.freeze({
    observePackageMetadata(input) {
      return local.observePackageMetadata(input)
    },
    async observePackageVersion(input) {
      const observed = await local.observePackageVersion(input)
      if (observed.status !== "PRESENT") return observed
      return {
        ...observed,
        package: {
          ...observed.package,
          tarballUrl: officialRegistryTarballUrl(input.name, input.version),
        },
      }
    },
    async downloadRegistryTarball({ tarballUrl, signal }) {
      const official = new URL(tarballUrl)
      if (official.origin !== "https://registry.npmjs.org") {
        throw new Error("Fixed-group rehearsal npm tarball did not use the production origin")
      }
      const localUrl = new URL(`${official.pathname}${official.search}`, registry)
      const downloaded = await local.downloadRegistryTarball({
        tarballUrl: localUrl.href,
        ...(signal === undefined ? {} : { signal }),
      })
      if (downloaded.status !== "PRESENT") return downloaded
      return {
        ...downloaded,
        tarball: { ...downloaded.tarball, url: official.href },
      }
    },
  })
}

function officialRegistryTarballUrl(name, version) {
  const packageName = name.startsWith("@") ? name.slice(name.indexOf("/") + 1) : name
  return new URL(`${name}/-/${packageName}-${version}.tgz`, "https://registry.npmjs.org/").href
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

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

function requiredPath() {
  const value = Reflect.get(process.env, "PATH")
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new TypeError("Fixed-group rehearsal requires a safe PATH")
  }
  return value
}

function rehearsalCrashCause(error) {
  const seen = new Set()
  let current = error
  while (current !== null && typeof current === "object" && !seen.has(current)) {
    if (current instanceof RehearsalCrashError) return current
    seen.add(current)
    current = current.cause
  }
  return null
}

function nestedErrorMessages(error) {
  const messages = []
  const seen = new Set()
  let current = error
  while (
    current !== null &&
    typeof current === "object" &&
    !seen.has(current) &&
    messages.length < 16
  ) {
    seen.add(current)
    if (typeof current.message === "string" && current.message.length > 0) {
      messages.push(current.message)
    }
    current = current.cause
  }
  return messages
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
