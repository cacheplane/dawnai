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

// FNV-1a/32 over UTF-8 bytes, the input the algorithm is defined on: the canonical string
// carries non-ASCII namespaces and filter values, where UTF-16 code units would diverge.
// A cursor is server-issued over localhost, so this is a mismatch DETECTOR, not a MAC —
// and staying dependency-free keeps the module isomorphic.
function fnv1a32(input: string): string {
  let hash = 0x811c9dc5
  for (const byte of new TextEncoder().encode(input)) {
    hash ^= byte
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
    case "updatedAt":
      return filter.op === "betweenDays"
        ? `updatedAt|betweenDays|${filter.fromDay}|${filter.untilDay}`
        : `updatedAt|${filter.op}|${filter.day}`
    default: {
      // In-process callers are trusted past validateBrowseQuery, so an unmapped field
      // arrives here unchecked. Borrowing another field's canonical form would hand two
      // different datasets ONE fingerprint — the collision this whole function prevents.
      const unmapped: never = filter
      throw new BrowseQueryError(
        `unknown filter field ${JSON.stringify((unmapped as BrowseFilter).field)}`,
      )
    }
  }
}

/** A set filter is a SET, so member order is not identity. `undefined` (no filter, every
 *  row) stays distinct from `[]` (matches nothing) — see `normalizeSetFilter`. */
function canonicalSet<T extends string>(value: T | readonly T[] | undefined): readonly T[] | null {
  const values = normalizeSetFilter(value)
  return values === undefined ? null : [...values].sort()
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
    status: canonicalSet(query.status),
    kind: canonicalSet(query.kind),
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
      case "status":
        return record.status
      default: {
        // A stand-in value here is a key read off the WRONG column: the next page then
        // continues from a boundary that never existed in this ordering.
        const unmapped: never = entry.field
        throw new BrowseQueryError(`unknown sort field ${JSON.stringify(unmapped)}`)
      }
    }
  })
}

export function encodeBrowseCursor(fingerprint: string, payload: BrowseCursorPayload): string {
  return toBase64Url(
    JSON.stringify({ v: BROWSE_CURSOR_VERSION, fp: fingerprint, key: payload.key, id: payload.id }),
  )
}

function invalid(reason: string): never {
  throw new BrowseQueryError(reason, "continuation-invalid")
}

/** Decode a continuation and check it against the request's OWN parameters. */
export function decodeBrowseCursor(
  cursor: string,
  fingerprint: string,
  order: readonly ResolvedBrowseSort[],
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
  if (!Array.isArray(decoded.key) || decoded.key.length !== order.length)
    invalid("cursor key does not match the requested sort order")
  // Checked against the ORDERED FIELD, not merely "some string or number": a cursor is
  // unauthenticated, and a text value bound against a numeric column is compared across
  // SQLite's storage classes — every number sorts below every string, so the keyset
  // boundary silently admits every row — while Postgres rejects the ::real bind outright.
  for (const [index, entry] of order.entries()) {
    const value: unknown = decoded.key[index]
    const wellTyped = entry.numeric
      ? typeof value === "number" && Number.isFinite(value)
      : typeof value === "string"
    if (!wellTyped)
      invalid(
        `cursor key for "${entry.field}" must be ${entry.numeric ? "a finite number" : "a string"}`,
      )
  }
  if (typeof decoded.id !== "string" || decoded.id.length === 0) invalid("cursor id is missing")
  return { key: decoded.key as readonly BrowseCursorValue[], id: decoded.id }
}
