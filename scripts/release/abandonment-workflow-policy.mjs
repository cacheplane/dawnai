import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"

import { isAlias, parseDocument, visit } from "yaml"

import { snapshotJson } from "./adapter-normalize.mjs"

const MAX_WORKFLOW_BYTES = 2 * 1024 * 1024
const MAX_POLICY_BYTES = 64 * 1024
const CANONICALIZATION = "dawn-release-workflow-execution-v1"
const CANONICAL_DOMAIN = "dawn.release-workflow.execution.v1\0"
const POLICY_URL = new URL("./abandonment-workflow-policy.json", import.meta.url)
const EXPECTED_VARIANTS = Object.freeze([
  Object.freeze({ id: "disabled-2026-08-28", mode: "disabled" }),
  Object.freeze({ id: "protected-2026-08-28", mode: "protected" }),
])
const SHA256_PATTERN = /^[0-9a-f]{64}$/u

export function parseCanonicalReleaseWorkflow(bytes) {
  return canonicalizeReleaseWorkflow(parseReleaseWorkflow(bytes))
}

export function parseReleaseWorkflow(bytes) {
  return parseWorkflow(bytes)
}

export function canonicalizeReleaseWorkflow(value) {
  let workflow
  try {
    workflow = snapshotJson(value)
  } catch (error) {
    throw invalidWorkflow(error)
  }
  if (!isRecord(workflow)) throw invalidWorkflow()
  const canonicalJson = JSON.stringify(sortMappings(workflow))
  const canonicalSha256 = createHash("sha256")
    .update(CANONICAL_DOMAIN, "utf8")
    .update(canonicalJson, "utf8")
    .digest("hex")
  return deepFreeze({ workflow, canonicalJson, canonicalSha256 })
}

export function validateAbandonmentWorkflowPolicy(value) {
  let policy
  try {
    policy = snapshotJson(value)
  } catch (error) {
    throw invalidPolicy(error)
  }
  if (
    !isRecord(policy) ||
    !sameStringSets(Object.keys(policy), ["schemaVersion", "canonicalization", "variants"]) ||
    policy.schemaVersion !== 1 ||
    policy.canonicalization !== CANONICALIZATION ||
    !Array.isArray(policy.variants) ||
    policy.variants.length !== EXPECTED_VARIANTS.length
  ) {
    throw invalidPolicy()
  }

  const ids = new Set()
  const digests = new Set()
  let previousId = null
  for (const [index, variant] of policy.variants.entries()) {
    const expected = EXPECTED_VARIANTS[index]
    if (
      !isRecord(variant) ||
      !sameStringSets(Object.keys(variant), ["id", "mode", "canonicalSha256"]) ||
      variant.id !== expected.id ||
      variant.mode !== expected.mode ||
      typeof variant.canonicalSha256 !== "string" ||
      !SHA256_PATTERN.test(variant.canonicalSha256) ||
      (previousId !== null && previousId >= variant.id) ||
      ids.has(variant.id) ||
      digests.has(variant.canonicalSha256)
    ) {
      throw invalidPolicy()
    }
    previousId = variant.id
    ids.add(variant.id)
    digests.add(variant.canonicalSha256)
  }
  return deepFreeze(policy)
}

export function loadAbandonmentWorkflowPolicy() {
  let bytes
  try {
    bytes = readFileSync(POLICY_URL)
  } catch (error) {
    throw invalidPolicy(error)
  }
  return parseAbandonmentWorkflowPolicy(bytes)
}

export function parseAbandonmentWorkflowPolicy(value) {
  const bytes = normalizePolicyBytes(value)
  let source
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch (error) {
    throw invalidPolicy(error)
  }
  let parsed
  try {
    parsed = JSON.parse(source)
  } catch (error) {
    throw invalidPolicy(error)
  }
  let document
  try {
    document = parseDocument(source, {
      maxAliasCount: 0,
      schema: "json",
      strict: true,
      uniqueKeys: true,
      version: "1.2",
    })
  } catch (error) {
    throw invalidPolicy(error)
  }
  if (
    document.errors.length > 0 ||
    document.warnings.length > 0 ||
    !hasOnlyImplicitDocumentDirectives(document)
  ) {
    throw invalidPolicy()
  }
  return validateAbandonmentWorkflowPolicy(parsed)
}

function parseWorkflow(value) {
  const bytes = normalizeBytes(value)
  let source
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch (error) {
    throw invalidWorkflow(error)
  }

  let document
  try {
    document = parseDocument(source, {
      maxAliasCount: 0,
      strict: true,
      uniqueKeys: true,
      version: "1.2",
    })
  } catch (error) {
    throw invalidWorkflow(error)
  }
  if (
    document.errors.length > 0 ||
    document.warnings.length > 0 ||
    !hasOnlyImplicitDocumentDirectives(document)
  ) {
    throw invalidWorkflow()
  }

  let forbiddenNode = false
  visit(document, (_key, node) => {
    if (isAlias(node) || node?.anchor !== undefined || node?.tag !== undefined) {
      forbiddenNode = true
    }
  })
  if (forbiddenNode) throw invalidWorkflow()

  let workflow
  try {
    workflow = snapshotJson(document.toJS({ maxAliasCount: 0 }))
  } catch (error) {
    throw invalidWorkflow(error)
  }
  if (!isRecord(workflow)) throw invalidWorkflow()
  return deepFreeze(workflow)
}

function normalizeBytes(value) {
  let bytes
  if (Buffer.isBuffer(value)) bytes = Buffer.from(value)
  else if (value instanceof Uint8Array) bytes = Buffer.from(value)
  else throw invalidWorkflow()
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_WORKFLOW_BYTES) throw invalidWorkflow()
  return bytes
}

function normalizePolicyBytes(value) {
  let bytes
  if (Buffer.isBuffer(value)) bytes = Buffer.from(value)
  else if (value instanceof Uint8Array) bytes = Buffer.from(value)
  else throw invalidPolicy()
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_POLICY_BYTES) throw invalidPolicy()
  return bytes
}

function sortMappings(value) {
  if (Array.isArray(value)) return value.map(sortMappings)
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.keys(value)
      .sort(compareText)
      .map((key) => [key, sortMappings(value[key])]),
  )
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value
  for (const nested of Object.values(value)) deepFreeze(nested)
  return Object.freeze(value)
}

function hasOnlyImplicitDocumentDirectives(document) {
  const { directives } = document
  return (
    directives.docStart === null &&
    directives.docEnd === false &&
    directives.yaml?.explicit === false &&
    directives.yaml.version === "1.2" &&
    sameStringSets(Object.keys(directives.tags), ["!!"]) &&
    directives.tags["!!"] === "tag:yaml.org,2002:"
  )
}

function sameStringSets(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
  const sortedLeft = [...left].sort(compareText)
  const sortedRight = [...right].sort(compareText)
  return sortedLeft.every((value, index) => value === sortedRight[index])
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function compareText(left, right) {
  return left === right ? 0 : left < right ? -1 : 1
}

function invalidWorkflow(cause) {
  return new TypeError("Release workflow bytes are invalid", {
    ...(cause === undefined ? {} : { cause }),
  })
}

function invalidPolicy(cause) {
  return new TypeError("Abandonment workflow policy is invalid", {
    ...(cause === undefined ? {} : { cause }),
  })
}
