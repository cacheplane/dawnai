import { gunzipSync, gzipSync } from "node:zlib"

import { EvidenceError } from "./github-evidence.mjs"

export const MAX_RECONCILIATION_RECEIPT_BYTES = 256 * 1024
export const MAX_RECONCILIATION_RECEIPT_GZIP_BYTES = 48_000

const MAX_RECONCILIATION_RECEIPT_GZIP_BASE64_CHARACTERS =
  Math.ceil(MAX_RECONCILIATION_RECEIPT_GZIP_BYTES / 3) * 4

function fail() {
  throw new EvidenceError("INVALID_RECEIPT_GZIP_BASE64")
}

export function encodeReconciliationReceiptGzipBase64(receiptBytes) {
  if (
    !Buffer.isBuffer(receiptBytes) ||
    receiptBytes.byteLength === 0 ||
    receiptBytes.byteLength > MAX_RECONCILIATION_RECEIPT_BYTES
  ) {
    fail()
  }
  let compressed
  try {
    compressed = gzipSync(receiptBytes, { level: 9 })
  } catch {
    fail()
  }
  if (
    compressed.byteLength === 0 ||
    compressed.byteLength > MAX_RECONCILIATION_RECEIPT_GZIP_BYTES
  ) {
    fail()
  }
  return compressed.toString("base64")
}

export function decodeReconciliationReceiptGzipBase64(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_RECONCILIATION_RECEIPT_GZIP_BASE64_CHARACTERS ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
  ) {
    fail()
  }
  const compressed = Buffer.from(value, "base64")
  if (
    compressed.byteLength === 0 ||
    compressed.byteLength > MAX_RECONCILIATION_RECEIPT_GZIP_BYTES ||
    compressed.toString("base64") !== value
  ) {
    fail()
  }
  let receiptBytes
  try {
    receiptBytes = gunzipSync(compressed, {
      maxOutputLength: MAX_RECONCILIATION_RECEIPT_BYTES,
    })
  } catch {
    fail()
  }
  if (receiptBytes.byteLength === 0 || receiptBytes.byteLength > MAX_RECONCILIATION_RECEIPT_BYTES) {
    fail()
  }
  return receiptBytes
}
