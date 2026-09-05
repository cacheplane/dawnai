import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { readBoundedRegularFile } from "../../lib/published-artifacts.mjs"
import { createGitReader } from "../adapters/git.mjs"
import { createGitHubReader } from "../adapters/github.mjs"
import { createNpmReader } from "../adapters/npm.mjs"
import { createCliAttestationVerifier } from "../artifact-store.mjs"
import { RELEASE_PAYLOAD_LIMITS } from "../limits.mjs"
import { canonicalManifestBytes, parseSealedReleaseManifest } from "../manifest.mjs"
import { createNpmAuditVerifier } from "../npm-audit.mjs"
import { createReleasePreparationRunner } from "../process-runner.mjs"
import { writeCanonicalFileNoClobber } from "../smoke-result.mjs"
import { adoptRecoveryCandidate } from "./adopt.mjs"
import { dispatchRecoveryAudit, runRecoveryAudit, waitForRecoveryAudit } from "./audit.mjs"
import { auditArtifactName, auditName } from "./audit-proof.mjs"
import { captureRecoveryEligibility } from "./authority.mjs"
import { collectRecoveryEvidence } from "./evidence.mjs"
import { createRecoveryFenceReader } from "./fence.mjs"
import { finalizeRecoveryCandidate, publishRecoveryCandidate } from "./finalize.mjs"
import {
  createRecoveryImmutablePolicyReader,
  createRecoveryInvocationReader,
} from "./invocation.mjs"
import {
  inspectRecoveryOriginalPayload,
  normalizeRecoveryAssetInventory,
  observeRecoveryCandidate,
  readRecoveryReservations,
} from "./observe.mjs"
import { RECOVERY_RETRY, runRecoveryRead } from "./policy.mjs"
import {
  boundedRecoveryPath,
  canonicalRequestBytes,
  recoveryChildEnvironment,
} from "./requests.mjs"
import { canonicalRecoveryBytes, parseRecovery, RECOVERY_LIMITS } from "./schema.mjs"

export {
  canonicalRequestBytes,
  parseRecoveryRequest,
  recoveryChildEnvironment,
} from "./requests.mjs"

const requireThat = (value, message) => {
  if (!value) throw new TypeError(message)
}
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex")
const jobs = {
  adopt: "recovery-adopt",
  "reconcile-verification": "recovery-evidence",
  "dispatch-audit": "recovery-dispatch-audit",
  audit: "recovery-audit",
  "reconcile-audit": "recovery-audit-evidence",
  finalize: "recovery-finalize",
  publish: "recovery-publish",
  report: "recovery-report",
  admit: "recovery-admit",
}
export function createRecoveryRuntime(
  { root, environment, command, request, expectedJobName },
  overrides = {},
) {
  boundedRecoveryPath(root)
  const candidate = request?.candidate
  const repository = candidate?.repository ?? environment.GITHUB_REPOSITORY
  const repositoryId = candidate?.repositoryId ?? environment.GITHUB_REPOSITORY_ID
  requireThat(
    repository === "cacheplane/dawnai" && /^[1-9][0-9]{0,31}$/u.test(repositoryId),
    "Exact recovery repository required",
  )
  const token = environment.GITHUB_TOKEN ?? ""
  requireThat(
    typeof token === "string" && token.length <= 4096 && !/[\r\n]/u.test(token),
    "Bounded GitHub credential required",
  )
  const fetchImpl = overrides.fetchImpl ?? fetch
  const git = (overrides.createGitReader ?? createGitReader)({ root })
  const github = (overrides.createGitHubReader ?? createGitHubReader)({
    owner: "cacheplane",
    repo: "dawnai",
    repositoryId,
    token,
    fetchImpl,
    conditionalReads: true,
    now: overrides.now ?? Date.now,
    maxResponseBytes: RELEASE_PAYLOAD_LIMITS.actionsArchiveBytes,
  })
  const npm = (overrides.createNpmReader ?? createNpmReader)({
    maxResponseBytes: RELEASE_PAYLOAD_LIMITS.tarballBytes,
  })
  const attestations = (overrides.createAttestationVerifier ?? createCliAttestationVerifier)({
    repository,
    token,
    environment: recoveryChildEnvironment(environment),
  })
  const npmAuditFactory = Object.freeze({
    async create() {
      const verifier = await (overrides.createNpmAuditVerifier ?? createNpmAuditVerifier)({
        runNpm: (overrides.createRunner ?? createReleasePreparationRunner)(),
        environment: recoveryChildEnvironment(environment),
        signal: new AbortController().signal,
      })
      return Object.freeze({
        verifyPackage: (args) => verifier.verifyPackage(args),
        verifyPackages: (args) => verifier.verifyPackages(args),
        dispose: () => verifier.dispose(),
      })
    },
  })
  const observation = { github, git, npm, npmAuditFactory, attestations }
  const dispose = () => github.dispose?.()
  const phaseDeadline = (overrides.now ?? Date.now)() + RECOVERY_RETRY.phaseDeadlineMs
  if (command === "inspect") return Object.freeze({ observation, phaseDeadline, dispose })
  const name = expectedJobName ?? (command === "smoke" ? `recovery-${request.lane}` : jobs[command])
  const now = overrides.now ?? Date.now,
    sleep = overrides.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const { readInvocation } = createRecoveryInvocationReader({
    env: environment,
    github,
    expectedJobName: name,
    now,
    sleep,
  })
  const { observeLegacyFence } = createRecoveryFenceReader({ github, git, now, sleep })
  const authority = { git, github, readInvocation, observeLegacyFence, now, sleep }
  let observeImmutableReleasePolicy = async () => {
    throw new Error("Immutable release policy reader unavailable for this phase")
  }
  if (["finalize", "publish"].includes(command) && environment.DAWN_RECOVERY_POLICY_TOKEN) {
    const policyReader = createRecoveryImmutablePolicyReader({
      owner: "cacheplane",
      repo: "dawnai",
      repositoryId,
      token: environment.DAWN_RECOVERY_POLICY_TOKEN,
      fetchImpl,
      now,
      sleep,
    })
    observeImmutableReleasePolicy = policyReader.observeImmutableReleasePolicy
  }
  return Object.freeze({
    dispose,
    observation,
    phaseDeadline,
    authority,
    fetchImpl,
    observeImmutableReleasePolicy,
    config: { repository, token },
  })
}
export function observeRecoveryRequest(request, runtime) {
  return observeRecoveryCandidate({
    ...runtime.observation,
    candidate: request.candidate,
    controllerRef: request.expectedControllerSha,
    intentPath: request.intentPath,
  })
}
export async function executeRecoveryCommand(command, request, runtime, options) {
  if (command === "inspect")
    return request.intentPath
      ? observeRecoveryRequest(request, runtime)
      : inspectRecoveryOriginalPayload({
          ...runtime.observation,
          candidate: request.candidate,
          controllerRef: request.expectedControllerSha,
        })
  if (command === "report") return observeRecoveryRequest(request, runtime)
  if (command === "smoke") return executeRecoverySmoke(request, runtime, options)
  if (command === "audit") return runRecoveryAudit(request, runtime)
  requireThat(
    typeof runtime.config?.token === "string" && runtime.config.token.length > 0,
    "Recovery writer credential unavailable",
  )
  const execute = {
    adopt: adoptRecoveryCandidate,
    "reconcile-verification": collectRecoveryEvidence,
    "dispatch-audit": dispatchRecoveryAudit,
    "reconcile-audit": waitForRecoveryAudit,
    finalize: finalizeRecoveryCandidate,
    publish: publishRecoveryCandidate,
  }[command]
  requireThat(typeof execute === "function", "Unsupported recovery command")
  return execute(request, runtime.config, runtime)
}
export async function readRecoveryApi(runtime, method, args) {
  const now = runtime.authority?.now ?? Date.now,
    sleep = runtime.authority?.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const result = await runRecoveryRead(
    { phaseDeadline: runtime.phaseDeadline, responseBytes: 16 * 1024 * 1024 },
    () => runtime.observation.github[method](args),
    { now, sleep },
  )
  requireThat(result.status === "PRESENT", "Exact recovery API evidence unavailable")
  return method === "downloadReleaseAsset" ? result.contentBase64 : result.value
}
export async function resolveRecoveryAuditRequest(inputs, runtime, actualSha) {
  requireThat(
    Object.keys(inputs).sort().join(" ") ===
      "expected_controller_sha intent_sha256 release_id request_id",
    "Exact audit dispatch inputs required",
  )
  requireThat(
    inputs.expected_controller_sha === actualSha &&
      /^[a-f0-9]{40}$/u.test(actualSha) &&
      /^[a-f0-9]{64}$/u.test(inputs.intent_sha256) &&
      /^[1-9][0-9]{0,31}$/u.test(inputs.release_id) &&
      /^[a-z0-9][a-z0-9._-]{0,127}$/u.test(inputs.request_id),
    "Exact audit dispatch identity required",
  )
  const reservations = await readRecoveryReservations({
    git: runtime.observation.git,
    terminalRecordRef: actualSha,
  })
  const matches = reservations.filter(
    (r) =>
      r.intent.candidate.repository === "cacheplane/dawnai" &&
      r.intent.candidate.releaseId === inputs.release_id,
  )
  requireThat(matches.length === 1, "Unique committed audit reservation required")
  const { intent, path: intentPath } = matches[0],
    candidate = intent.candidate
  const refs = normalizeRecoveryAssetInventory(
    await readRecoveryApi(runtime, "listReleaseAssets", { releaseId: candidate.releaseId }),
  )
  const ref = refs.find(
    (r) =>
      r.assetName === auditName({ kind: "recovery-audit-intent", requestId: inputs.request_id }),
  )
  requireThat(
    ref && ref.size <= RECOVERY_LIMITS.selectionBytes && ref.sha256 === inputs.intent_sha256,
    "Dispatched intent digest differs",
  )
  const encoded = await readRecoveryApi(runtime, "downloadReleaseAsset", {
      assetId: ref.id,
      maximumBytes: ref.size,
    }),
    bytes = Buffer.from(encoded, "base64")
  requireThat(
    bytes.toString("base64") === encoded && bytes.length === ref.size && hash(bytes) === ref.sha256,
    "Dispatched intent bytes differ",
  )
  const audit = parseRecovery(bytes, { kind: "recovery-audit-intent", candidate })
  requireThat(
    canonicalRecoveryBytes(audit).equals(bytes) &&
      audit.requestId === inputs.request_id &&
      audit.expectedAuditorSha === actualSha,
    "Dispatched intent binding differs",
  )
  return { candidate, expectedControllerSha: actualSha, intentPath, requestId: inputs.request_id }
}
async function executeRecoverySmoke(
  request,
  runtime,
  { output, environment, emitArtifact, manifest: manifestPath },
) {
  const proof = await captureRecoveryEligibility(
    { candidate: request.candidate, expectedControllerSha: request.expectedControllerSha },
    runtime.authority,
  )
  const bytes = await readBoundedRegularFile(
    boundedRecoveryPath(manifestPath),
    RELEASE_PAYLOAD_LIMITS.manifestBytes,
    "Transferred smoke manifest",
  )
  requireThat(hash(bytes) === request.candidate.manifestSha256, "Verified smoke manifest differs")
  const manifest = parseSealedReleaseManifest(bytes, {
    candidate: {
      version: request.candidate.version,
      commitSha: request.candidate.candidateSha,
      ciWorkflow: "CI",
      ciCheck: "validate",
      publisherWorkflow: ".github/workflows/release.yml",
    },
  })
  requireThat(canonicalManifestBytes(manifest).equals(bytes), "Canonical smoke manifest required")
  const artifactName = `recovery-v2-lane-${request.lane}-${proof.executor.runId}-${proof.executor.runAttempt}-${proof.executor.jobId}`
  const evidenceDirectory = path.join(path.dirname(output), artifactName)
  await mkdir(evidenceDirectory, { mode: 0o700 })
  if (emitArtifact) await emitArtifact({ artifactName, evidenceDirectory })
  const directory = await mkdtemp(path.join(os.tmpdir(), "dawn-recovery-bootstrap-"))
  try {
    const manifestPath = path.join(directory, "manifest.json"),
      preparedPath = path.join(directory, "request.json"),
      result = path.join(evidenceDirectory, `${artifactName}.json`)
    await writeCanonicalFileNoClobber(manifestPath, bytes, {}, RELEASE_PAYLOAD_LIMITS.manifestBytes)
    await writeCanonicalFileNoClobber(
      preparedPath,
      canonicalRequestBytes({
        lane: request.lane,
        candidate: request.candidate,
        executor: proof.executor,
        policySha256: proof.policySha256,
        manifest: manifestPath,
        result,
      }),
    )
    await runRecoverySmokeChild(preparedPath, environment, spawn, {
      phaseDeadline: runtime.phaseDeadline,
      now: runtime.authority.now,
    })
    const receipt = parseRecovery(
      await readBoundedRegularFile(result, RECOVERY_LIMITS.selectionBytes, "Recovery lane"),
      { kind: "recovery-lane", candidate: request.candidate },
    )
    return { receipt, artifactName, evidenceDirectory }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
export function runRecoverySmokeChild(
  requestPath,
  environment,
  spawnImpl = spawn,
  {
    phaseDeadline = Date.now() + RECOVERY_RETRY.phaseDeadlineMs,
    now = Date.now,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = {},
) {
  return new Promise((resolve, reject) => {
    const remaining = phaseDeadline - now()
    if (remaining <= 0) {
      reject(new Error("Recovery smoke phase deadline expired before child launch"))
      return
    }
    const child = spawnImpl(
      process.execPath,
      [
        fileURLToPath(new URL("./smoke-child.mjs", import.meta.url)),
        boundedRecoveryPath(requestPath),
      ],
      { env: recoveryChildEnvironment(environment), stdio: ["ignore", "ignore", "ignore"] },
    )
    let expired = false,
      hardTimer
    const timer = setTimer(() => {
      expired = true
      child.kill("SIGTERM")
      hardTimer = setTimer(() => child.kill("SIGKILL"), 180000)
    }, remaining)
    const clear = () => {
      clearTimer(timer)
      clearTimer(hardTimer)
    }
    child.once("error", (error) => {
      clear()
      reject(error)
    })
    child.once("close", (code) => {
      clear()
      code === 0 && !expired
        ? resolve()
        : reject(
            new Error(
              expired
                ? "Recovery child deadline expired; cleanup is unverified until retained evidence is independently checked"
                : "Recovery smoke child failed; inspect retained lane evidence",
            ),
          )
    })
  })
}
export async function writeRecoveryAuditArtifact(receipt, output) {
  const artifactName = auditArtifactName(receipt.executor),
    evidenceDirectory = path.join(path.dirname(output), artifactName)
  await mkdir(evidenceDirectory, { mode: 0o700 })
  await writeCanonicalFileNoClobber(
    path.join(evidenceDirectory, `${artifactName}.json`),
    canonicalRecoveryBytes(receipt),
  )
  return { artifactName, evidenceDirectory }
}
