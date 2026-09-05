import {
  canonicalRecoveryBytes,
  parseRecovery,
  RECOVERY_LIMITS,
  recoveryDigest,
  snapshotRecoveryData,
} from "./schema.mjs"

export const RECOVERY_MARKER_START = "<!-- DAWN_RELEASE_CONTROLLER_MARKER\n"
const END = "\nEND_DAWN_RELEASE_CONTROLLER_MARKER -->"

export function parseRecoveryReleaseMarker(body) {
  if (typeof body !== "string" || Buffer.byteLength(body) > RECOVERY_LIMITS.selectionBytes)
    throw new TypeError("Recovery release body exceeds its boundary")
  const start = body.indexOf(RECOVERY_MARKER_START)
  const end = body.indexOf(END)
  if (
    start < 0 ||
    end < start ||
    body.indexOf(RECOVERY_MARKER_START, start + 1) !== -1 ||
    body.indexOf(END, end + 1) !== -1
  )
    throw new TypeError("Exactly one recovery marker envelope is required")
  return parseRecovery(`${body.slice(start + RECOVERY_MARKER_START.length, end)}\n`, {
    kind: "recovery-marker",
  })
}

export function renderRecoveryReleaseBody(input) {
  const { marker, body } = snapshotRecoveryData(input)
  if (
    typeof body !== "string" ||
    body.includes("DAWN_RELEASE_CONTROLLER_MARKER") ||
    Buffer.byteLength(body) > 128 * 1024
  )
    throw new TypeError("Recovery notes contain marker delimiters or exceed their boundary")
  const bytes = canonicalRecoveryBytes(parseRecovery(marker, { kind: "recovery-marker" }))
  return `${body}\n\n${RECOVERY_MARKER_START}${bytes.toString("utf8").slice(0, -1)}${END}`
}

export function renderRecoveryFinalMetadata(finalization, finalizationRef) {
  finalizationRef = snapshotRecoveryData(finalizationRef)
  const value = parseRecovery(finalization, { kind: "recovery-finalization" })
  if (
    finalizationRef?.assetName !== "recovery-v2-finalization.json" ||
    finalizationRef.sha256 !== recoveryDigest(value) ||
    finalizationRef.size !== canonicalRecoveryBytes(value).length
  )
    throw new TypeError("Exact finalization reference required for rendering")
  const marker = parseRecovery({
    schemaVersion: 2,
    kind: "recovery-marker",
    candidate: value.candidate,
    policySha256: value.policySha256,
    revision: value.metadata.markerRevision,
    phase: "PUBLICATION_READY",
    adoption: value.adoption,
    verificationSet: value.verificationSet,
    audit: value.audit,
    finalization: finalizationRef,
  })
  return Object.freeze({
    title: value.metadata.title,
    body: renderRecoveryReleaseBody({ marker, body: value.metadata.body }),
  })
}
