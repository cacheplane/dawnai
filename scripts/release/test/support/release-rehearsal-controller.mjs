import { writeFile } from "node:fs/promises"
import { isAbsolute, join } from "node:path"

import { runReleaseCli } from "../../cli.mjs"
import { runReleaseController } from "../../controller.mjs"
import { verifyReleaseAttestationAnchor } from "../../metadata.mjs"
import { correlateSmokeResults, parseSmokeResult } from "../../smoke-result.mjs"

const SMOKE_LANES = Object.freeze(["published-harness", "runtime-targets", "scaffold", "storage"])

export function createRehearsalCliObserver({
  candidate,
  directory,
  dependencies,
  receipts,
  runCli = runReleaseCli,
}) {
  const identity = exactCandidate(candidate)
  if (
    typeof directory !== "string" ||
    !isAbsolute(directory) ||
    dependencies === null ||
    typeof dependencies !== "object" ||
    Array.isArray(dependencies) ||
    typeof runCli !== "function"
  ) {
    throw new TypeError("Rehearsal CLI observer dependencies are invalid")
  }
  const receiptBoundary = normalizeReceiptBoundary(receipts)
  let sequence = 0
  return Object.freeze({
    async observe({ candidate: requestedCandidate }) {
      const requested = exactCandidate(requestedCandidate)
      if (requested.version !== identity.version || requested.commitSha !== identity.commitSha) {
        throw new Error("Rehearsal CLI observer candidate changed")
      }
      sequence += 1
      const suffix = String(sequence).padStart(4, "0")
      const paths = {
        event: join(directory, `observe-event-${suffix}.json`),
        report: join(directory, `observe-report-${suffix}.json`),
        output: join(directory, `observe-output-${suffix}.txt`),
      }
      await Promise.all([
        writeFile(
          paths.event,
          `${JSON.stringify({ ref: "refs/heads/main", after: identity.commitSha })}\n`,
          { flag: "wx", mode: 0o600 },
        ),
        writeFile(paths.output, "", { flag: "wx", mode: 0o600 }),
      ])
      const report = await runCli(
        [
          "observe",
          "--event",
          paths.event,
          "--report",
          paths.report,
          "--github-output",
          paths.output,
        ],
        { ...dependencies, cwd: dependencies.cwd ?? directory },
      )
      if (
        report === null ||
        typeof report !== "object" ||
        Array.isArray(report) ||
        report.candidate?.version !== identity.version ||
        report.candidate?.commitSha !== identity.commitSha ||
        report.before?.observation === null ||
        typeof report.before?.observation !== "object" ||
        Array.isArray(report.before.observation)
      ) {
        const state = report?.before?.plan?.state ?? "unknown"
        const conflicts = Array.isArray(report?.before?.plan?.conflicts)
          ? report.before.plan.conflicts.join(",")
          : "unknown"
        const diagnostics = Array.isArray(report?.diagnostics)
          ? report.diagnostics.map((entry) => entry?.code).join(",")
          : "unknown"
        throw new Error(
          `Rehearsal production observe CLI returned a malformed snapshot (${state}: ${conflicts}; ${diagnostics})`,
        )
      }
      let observation = deepFreeze(structuredClone(report.before.observation))
      if (
        receiptBoundary !== null &&
        observation.artifacts?.status === "prepared" &&
        observation.release?.status === "absent"
      ) {
        const receipt = await receiptBoundary.readAttestation()
        if (receipt !== null) {
          observation = await applyRehearsalAttestationReceipt({
            observation,
            candidate: identity,
            ...receipt,
            attestations: dependencies.attestations,
          })
        }
      }
      if (
        receiptBoundary !== null &&
        observation.release?.status === "draft" &&
        observation.release.marker?.phase === "NPM_COMPLETE"
      ) {
        const smokeReceipts = await receiptBoundary.readSmokes()
        if (smokeReceipts !== null) {
          observation = applyRehearsalSmokeReceipts({
            observation,
            candidate: identity,
            receipts: smokeReceipts,
          })
        }
      }
      return observation
    },
  })
}

export async function runRehearsalControllerStep({ candidate, observer, effects, reporter }) {
  return runReleaseController({
    candidate: exactCandidate(candidate),
    observer,
    effects,
    reporter,
  })
}

export async function applyRehearsalAttestationReceipt({
  observation,
  candidate,
  record,
  artifact,
  bundleBytes,
  attestations,
}) {
  const observed = structuredClone(observation)
  if (
    observed === null ||
    typeof observed !== "object" ||
    Array.isArray(observed) ||
    observed.artifacts?.status !== "prepared" ||
    observed.artifacts.manifestSha256 !== record?.manifestSha256 ||
    observed.artifacts.manifestVersion !== candidate?.version ||
    observed.artifacts.manifestCommitSha !== candidate?.commitSha ||
    observed.inventory?.status !== "valid" ||
    !Array.isArray(observed.inventory.packages)
  ) {
    throw new Error("Rehearsal attestation receipt requires the exact prepared observation")
  }
  const expectedPackageNames = artifact?.manifest?.packages
    ?.map((pkg) => pkg.name)
    .sort(compareText)
  const observedPackageNames = observed.inventory.packages.map((pkg) => pkg.name).sort(compareText)
  if (
    !Array.isArray(expectedPackageNames) ||
    expectedPackageNames.length !== 21 ||
    observedPackageNames.length !== expectedPackageNames.length ||
    observedPackageNames.some((name, index) => name !== expectedPackageNames[index])
  ) {
    throw new Error("Rehearsal attestation receipt requires the exact package inventory")
  }
  const verified = await verifyReleaseAttestationAnchor({
    candidate,
    record,
    artifact,
    bundleBytes,
    attestations,
  })
  const subjects = new Map(
    verified.attestationSet.subjects.map((subject) => [subject.subjectName, subject]),
  )
  const manifestSubject = subjects.get("manifest.json")
  if (manifestSubject === undefined) {
    throw new Error("Rehearsal attestation receipt omitted the manifest subject")
  }
  observed.inventory.packages = observed.inventory.packages.map((pkg) => {
    const subject = subjects.get(pkg.filename)
    if (
      subject === undefined ||
      subject.subjectSha256 !== pkg.tarballSha256 ||
      subject.bundleName !== pkg.attestationFilename
    ) {
      throw new Error(`Rehearsal attestation receipt conflicts with ${pkg.name}`)
    }
    return { ...pkg, attestationSha256: subject.bundleSha256 }
  })
  observed.artifacts = {
    ...observed.artifacts,
    status: "attested",
    manifestAttestationAsset: {
      name: manifestSubject.bundleName,
      sha256: manifestSubject.bundleSha256,
    },
    attestations: observed.artifacts.attestations.map((entry) => {
      const subject = subjects.get(entry.subjectName)
      if (
        subject === undefined ||
        subject.bundleName !== entry.name ||
        subject.subjectSha256 !== entry.subjectSha256
      ) {
        throw new Error(`Rehearsal attestation receipt conflicts with ${entry.subjectName}`)
      }
      return { ...entry, status: "valid", sha256: subject.bundleSha256 }
    }),
  }
  return deepFreeze(observed)
}

export function applyRehearsalSmokeReceipts({ observation, candidate, receipts }) {
  const observed = structuredClone(observation)
  if (observed.release?.marker?.phase !== "NPM_COMPLETE") return deepFreeze(observed)
  if (
    !Array.isArray(receipts) ||
    receipts.length !== SMOKE_LANES.length ||
    !Array.isArray(observed.requiredSmokeLanes) ||
    observed.requiredSmokeLanes.length !== SMOKE_LANES.length ||
    observed.requiredSmokeLanes.some((lane, index) => lane !== SMOKE_LANES[index]) ||
    observed.release.status !== "draft" ||
    observed.release.immutable !== false ||
    !Array.isArray(observed.smokes) ||
    observed.smokes.length !== SMOKE_LANES.length ||
    observed.smokes.some(
      (smoke, index) =>
        smoke?.name !== SMOKE_LANES[index] ||
        smoke.status !== "pending" ||
        smoke.version !== candidate.version ||
        smoke.commitSha !== candidate.commitSha ||
        smoke.manifestSha256 !== observed.release.marker.manifestSha256 ||
        smoke.workflowRunId !== null ||
        smoke.runAttempt !== null,
    )
  ) {
    throw new Error(
      "Rehearsal smoke readiness requires the exact pending production smoke observation",
    )
  }
  const parsed = receipts.map((receipt) => parseSmokeResult(receipt))
  const first = parsed[0]
  const correlated = correlateSmokeResults(parsed, {
    requiredLanes: SMOKE_LANES,
    version: candidate.version,
    commitSha: candidate.commitSha,
    manifestSha256: observed.release.marker.manifestSha256,
    workflowRunId: first.workflowRunId,
    runAttempt: first.runAttempt,
  })
  observed.smokes = correlated.map((receipt) => ({
    name: receipt.lane,
    status: receipt.conclusion === "success" ? "passed" : "failed",
    version: receipt.version,
    commitSha: receipt.commitSha,
    manifestSha256: receipt.manifestSha256,
    workflowRunId: receipt.workflowRunId,
    runAttempt: receipt.runAttempt,
  }))
  return deepFreeze(observed)
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

function exactCandidate(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !==
      "ciCheck,ciWorkflow,commitSha,publisherWorkflow,version" ||
    typeof value.version !== "string" ||
    !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u.test(value.version) ||
    typeof value.commitSha !== "string" ||
    !/^[0-9a-f]{40}$/u.test(value.commitSha) ||
    value.ciWorkflow !== "CI" ||
    value.ciCheck !== "validate" ||
    value.publisherWorkflow !== ".github/workflows/release.yml"
  ) {
    throw new TypeError("Rehearsal controller candidate is invalid")
  }
  return deepFreeze(structuredClone(value))
}

function normalizeReceiptBoundary(value) {
  if (value === undefined) return null
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Rehearsal workflow receipt boundary is invalid")
  }
  for (const method of ["readAttestation", "readSmokes"]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, method)
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor) ||
      typeof descriptor.value !== "function"
    ) {
      throw new TypeError("Rehearsal workflow receipt boundary is invalid")
    }
  }
  return Object.freeze({
    readAttestation: value.readAttestation.bind(value),
    readSmokes: value.readSmokes.bind(value),
  })
}
