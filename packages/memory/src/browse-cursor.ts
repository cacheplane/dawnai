import { normalizeSetFilter } from "./browse-filter.js"
import type { ResolvedBrowseSort } from "./browse-order.js"
import { resolveBrowseOrder } from "./browse-order.js"
import { BrowseQueryError } from "./browse-validate.js"
import type { BrowseFilter, BrowseQuery, MemoryRecord } from "./types.js"

export const BROWSE_CURSOR_VERSION = 1

export type BrowseCursorValue = string | number

export interface BrowseCursorPayload {
  /** Raw stored sort-key values, one per ordered field, in order. */
  readonly key: readonly BrowseCursorValue[]
  readonly id: string
}

// btoa/atob + TextEncoder are available in Node 24 AND browsers; Buffer is not, and
// slice 3's hook imports this module from client code.
function toBase64Url(json: string): string {
  const bytes = new TextEncoder().encode(json)
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function fromBase64Url(cursor: string): string {
  const base64 = cursor.replace(/-/g, "+").replace(/_/g, "/")
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4)
  const binary = atob(padded)
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)))
}

// FNV-1a/32. A cursor is server-issued over localhost, so this is a mismatch
// DETECTOR, not a MAC — and staying dependency-free keeps the module isomorphic.
function fnv1a32(input: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, "0")
}

function canonicalFilter(filter: BrowseFilter): string {
  switch (filter.field) {
    case "status":
    case "kind":
      return `${filter.field}|${filter.op}|${[...filter.values].sort().join(",")}`
    case "content":
    case "namespace":
      return `${filter.field}|${filter.op}|${filter.value}`
    case "confidence":
      return filter.op === "between"
        ? `confidence|between|${filter.min}|${filter.max}`
        : `confidence|${filter.op}|${filter.value}`
    default:
      return filter.op === "betweenDays"
        ? `updatedAt|betweenDays|${filter.fromDay}|${filter.untilDay}`
        : `updatedAt|${filter.op}|${filter.day}`
  }
}

/**
 * Fingerprint of the query's DATASET IDENTITY — every field that changes which rows
 * match or in what order, and nothing else. `limit`/`offset`/`cursor` are paging,
 * not identity. Encoded into every cursor so a continuation can never smuggle its
 * own query into a different request.
 */
export function browseQueryFingerprint(query: BrowseQuery): string {
  const canonical = JSON.stringify({
    namespace: query.namespace ?? null,
    namespacePrefix: query.namespacePrefix ?? null,
    status: normalizeSetFilter(query.status) ?? null,
    kind: normalizeSetFilter(query.kind) ?? null,
    sourceType: query.sourceType ?? null,
    since: query.since ?? null,
    until: query.until ?? null,
    now: query.now ?? null,
    filters: (query.filters ?? []).map(canonicalFilter).sort(),
    order: resolveBrowseOrder(query.orderBy).map((entry) => `${entry.field}:${entry.dir}`),
  })
  return fnv1a32(canonical)
}

/** The raw stored values of `record` for the ordered fields, in order. */
export function browseCursorKey(
  record: MemoryRecord,
  order: readonly ResolvedBrowseSort[],
): readonly BrowseCursorValue[] {
  return order.map((entry) => {
    switch (entry.field) {
      case "updatedAt":
        return record.updatedAt
      case "createdAt":
        return record.createdAt
      case "confidence":
        return record.confidence
      case "namespace":
        return record.namespace
      case "kind":
        return record.kind
      default:
        return record.status
    }
  })
}

export function encodeBrowseCursor(fingerprint: string, payload: BrowseCursorPayload): string {
  return toBase64Url(
    JSON.stringify({ v: BROWSE_CURSOR_VERSION, fp: fingerprint, key: payload.key, id: payload.id }),
  )
}

function invalid(reason: string): never {
  throw new BrowseQueryError(`continuation-invalid: ${reason}`, "continuation-invalid")
}

/** Decode and authenticate a continuation against the request's OWN parameters. */
export function decodeBrowseCursor(
  cursor: string,
  fingerprint: string,
  expectedKeyLength: number,
): BrowseCursorPayload {
  let parsed: unknown
  try {
    parsed = JSON.parse(fromBase64Url(cursor))
  } catch {
    invalid("cursor is not decodable")
  }
  const decoded = parsed as { v?: unknown; fp?: unknown; key?: unknown; id?: unknown }
  if (decoded?.v !== BROWSE_CURSOR_VERSION) invalid("cursor version is not supported")
  if (decoded.fp !== fingerprint) invalid("cursor belongs to a different query")
  if (!Array.isArray(decoded.key) || decoded.key.length !== expectedKeyLength)
    invalid("cursor key does not match the requested sort order")
  for (const value of decoded.key) {
    if (typeof value !== "string" && !(typeof value === "number" && Number.isFinite(value)))
      invalid("cursor key holds a value that is neither a string nor a finite number")
  }
  if (typeof decoded.id !== "string" || decoded.id.length === 0) invalid("cursor id is missing")
  return { key: decoded.key as readonly BrowseCursorValue[], id: decoded.id }
}
