import assert from "node:assert/strict"
import test from "node:test"

import { normalizeAdapterEnvelope } from "../adapter-normalize.mjs"

test("adapter envelopes are descriptor-safe snapshots read once", () => {
  let reads = 0
  const envelope = Object.create(null)
  for (const [key, value] of Object.entries({
    status: "PRESENT",
    operation: "package-version",
    httpStatus: 200,
    code: null,
    package: { name: "@dawn-ai/sdk" },
  })) {
    Object.defineProperty(envelope, key, {
      enumerable: true,
      get() {
        reads += 1
        return value
      },
    })
  }

  const result = normalizeAdapterEnvelope(envelope, {
    source: "npm",
    operation: "package-version",
    payloadKey: "package",
  })
  assert.equal(reads, 0)
  assert.equal(result.status, "ERROR")
  assert.equal(result.code, "MALFORMED_ENVELOPE")
})

test("adapter envelopes require exact operation and status tuples", () => {
  for (const value of [
    { status: "ABSENT", operation: "provenance", httpStatus: 404, code: "E404" },
    { status: "ABSENT", operation: "package-version", httpStatus: 404, code: "HTTP_404" },
    { status: "ABSENT", operation: "package-version", httpStatus: "404", code: "E404" },
    { status: "PRESENT", operation: "package-version", httpStatus: 404, code: null, package: {} },
    { status: "PRESENT", operation: "package-metadata", httpStatus: 200, code: null, package: {} },
    {
      status: "AMBIGUOUS",
      operation: "package-version",
      httpStatus: 429,
      code: "Bearer ghp_123456789abcdef",
    },
  ]) {
    const result = normalizeAdapterEnvelope(value, {
      source: "npm",
      operation: "package-version",
      payloadKey: "package",
    })
    assert.equal(result.status, "ERROR")
  }

  assert.deepEqual(
    normalizeAdapterEnvelope(
      { status: "ABSENT", operation: "package-version", httpStatus: 404, code: "E404" },
      { source: "npm", operation: "package-version", payloadKey: "package" },
    ),
    { status: "ABSENT", operation: "package-version", httpStatus: 404, code: "E404" },
  )
})

test("GitHub raw 404 stays ambiguous", () => {
  assert.deepEqual(
    normalizeAdapterEnvelope(
      { status: "ABSENT", operation: "ref", httpStatus: 404, code: "HTTP_404" },
      { source: "github", operation: "ref", payloadKey: "value" },
    ),
    { status: "AMBIGUOUS", operation: "ref", httpStatus: 404, code: "HTTP_404" },
  )
})

test("transport ambiguity retains an exact operation and code without an HTTP status", () => {
  assert.deepEqual(
    normalizeAdapterEnvelope(
      { status: "AMBIGUOUS", operation: "workflow-runs", httpStatus: null, code: "TIMEOUT" },
      { source: "github", operation: "workflow-runs", payloadKey: "value" },
    ),
    { status: "AMBIGUOUS", operation: "workflow-runs", httpStatus: null, code: "TIMEOUT" },
  )
})

test("adapter envelopes reject symbols, extra keys, prototypes, and sparse arrays", () => {
  const sparse = []
  sparse.length = 2
  sparse[1] = "x"
  const cases = [
    { status: "AMBIGUOUS", operation: "ref", httpStatus: 429, code: "RATE_LIMITED", extra: 1 },
    Object.assign(Object.create({ inherited: true }), {
      status: "AMBIGUOUS",
      operation: "ref",
      httpStatus: 429,
      code: "RATE_LIMITED",
    }),
    Object.assign(
      { status: "PRESENT", operation: "ref", httpStatus: 200, code: null, value: [] },
      { [Symbol("secret")]: true },
    ),
    { status: "PRESENT", operation: "ref", httpStatus: 200, code: null, value: sparse },
  ]
  for (const value of cases) {
    assert.equal(
      normalizeAdapterEnvelope(value, {
        source: "github",
        operation: "ref",
        payloadKey: "value",
      }).status,
      "ERROR",
    )
  }
})
