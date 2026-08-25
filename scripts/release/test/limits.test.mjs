import assert from "node:assert/strict"
import test from "node:test"

import { RELEASE_PAYLOAD_LIMITS } from "../limits.mjs"

const MEBIBYTE = 1024 * 1024

test("one payload contract reserves deterministic Actions and escrow headroom", () => {
  assert.deepEqual(RELEASE_PAYLOAD_LIMITS, {
    actionsArchiveBytes: 40 * MEBIBYTE,
    actionsExpandedBytes: 32 * MEBIBYTE,
    archiveFilenameBytes: 512,
    auditEvidenceBytes: 16 * MEBIBYTE,
    auditReceiptBytes: MEBIBYTE,
    attestationBundleBytes: 2 * MEBIBYTE,
    attestationBundlesBytes: 31 * MEBIBYTE,
    escrowBytes: 64 * MEBIBYTE,
    manifestBytes: 256 * 1024,
    packedManifestBytes: 1024 * 1024,
    preparedTarballsBytes: 32 * MEBIBYTE - 256 * 1024,
    releaseRecordBytes: 16 * 1024,
    tarballBytes: 32 * MEBIBYTE,
    tarEntries: 16_384,
    tarExpandedBytes: 256 * MEBIBYTE,
    tarPathBytes: 4 * 1024,
    tarPaxHeaderBytes: 64 * 1024,
    zipEntries: 22,
    zipOverheadReserveBytes: 8 * MEBIBYTE,
  })
  assert.equal(
    RELEASE_PAYLOAD_LIMITS.actionsExpandedBytes + RELEASE_PAYLOAD_LIMITS.zipOverheadReserveBytes,
    RELEASE_PAYLOAD_LIMITS.actionsArchiveBytes,
  )
  assert.ok(
    RELEASE_PAYLOAD_LIMITS.actionsExpandedBytes +
      RELEASE_PAYLOAD_LIMITS.attestationBundlesBytes +
      RELEASE_PAYLOAD_LIMITS.releaseRecordBytes <
      RELEASE_PAYLOAD_LIMITS.escrowBytes,
  )
})
