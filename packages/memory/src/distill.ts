import type { MemoryRecord } from "./types.js"

/** Event time for distillation ordering/grouping: when it happened, not when the row moved. */
export function eventTimeOf(record: MemoryRecord): string {
  return record.effectiveAt ?? record.createdAt
}

/** ISO-week key (UTC): "<isoYear>-W<isoWeek>", so a batch is one namespace-week. */
export function isoWeekKey(iso: string): string {
  const d = new Date(iso)
  const day = (d.getUTCDay() + 6) % 7 // Monday = 0
  const thursday = new Date(d)
  thursday.setUTCDate(d.getUTCDate() - day + 3)
  const isoYear = thursday.getUTCFullYear()
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4))
  const firstDay = (firstThursday.getUTCDay() + 6) % 7
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDay + 3)
  const week = 1 + Math.round((thursday.getTime() - firstThursday.getTime()) / (7 * 86_400_000))
  return `${isoYear}-W${String(week).padStart(2, "0")}`
}

export interface ConsolidationBatch {
  readonly namespace: string
  readonly period: { readonly since: string; readonly until: string }
  readonly records: readonly MemoryRecord[]
}

/** Group active episodic records into per-(namespace, ISO week) batches, ordered by
 *  event time; groups below minBatchSize are dropped (summarizing 2 runs is noise),
 *  groups above maxBatchSize are chunked. Pure: the caller filters by age/status. */
export function selectConsolidationBatches(
  records: readonly MemoryRecord[],
  opts: { readonly minBatchSize: number; readonly maxBatchSize: number },
): ConsolidationBatch[] {
  // The group carries its own namespace instead of re-parsing it back out of the
  // composite key: spaces are LEGAL in namespace values (serializeNamespace encodes
  // only "%", "|", "="), so splitting the key on " " would truncate "user=Ada
  // Lovelace" to "user=Ada" and file the summary under the wrong namespace.
  // Covered by "preserves namespaces containing spaces" in distill-select.test.ts.
  const groups = new Map<string, { namespace: string; records: MemoryRecord[] }>()
  for (const r of records) {
    const key = `${r.namespace} ${isoWeekKey(eventTimeOf(r))}`
    const bucket = groups.get(key)
    if (bucket) bucket.records.push(r)
    else groups.set(key, { namespace: r.namespace, records: [r] })
  }
  const batches: ConsolidationBatch[] = []
  for (const group of groups.values()) {
    if (group.records.length < opts.minBatchSize) continue
    const sorted = [...group.records].sort((a, b) =>
      eventTimeOf(a) < eventTimeOf(b)
        ? -1
        : eventTimeOf(a) > eventTimeOf(b)
          ? 1
          : a.id < b.id
            ? -1
            : 1,
    )
    for (let i = 0; i < sorted.length; i += opts.maxBatchSize) {
      const chunk = sorted.slice(i, i + opts.maxBatchSize)
      const first = chunk[0]
      const last = chunk[chunk.length - 1]
      if (!first || !last) continue
      batches.push({
        namespace: group.namespace,
        period: { since: eventTimeOf(first), until: nextMillis(eventTimeOf(last)) },
        records: chunk,
      })
    }
  }
  return batches
}

/** `until` is exclusive everywhere in this codebase; +1ms makes the last record inclusive. */
function nextMillis(iso: string): string {
  return new Date(Date.parse(iso) + 1).toISOString()
}

export interface ReflectionInput {
  readonly namespace: string
  readonly records: readonly MemoryRecord[]
  /** The newest event time covered — becomes the next pass's watermark. */
  readonly coveredUntil: string
}

/** Records strictly newer than the watermark, newest-capped then re-sorted ascending.
 *  Returns null below the threshold — that null is what makes `dawn memory reflect`
 *  a cheap no-op for cron. Callers pass records from ONE namespace. */
export function selectReflectionInput(
  records: readonly MemoryRecord[],
  opts: {
    readonly minNewRecords: number
    readonly maxRecords: number
    readonly coveredUntil?: string
  },
): ReflectionInput | null {
  const watermark = opts.coveredUntil ?? new Date(0).toISOString()
  const fresh = records.filter((r) => eventTimeOf(r) > watermark)
  if (fresh.length < opts.minNewRecords) return null
  const byTimeDesc = [...fresh].sort((a, b) => compareEventTime(b, a) || compareId(b, a))
  const capped = byTimeDesc.slice(0, opts.maxRecords)
  const ascending = [...capped].sort((a, b) => compareEventTime(a, b) || compareId(a, b))
  const newest = capped[0]
  const namespace = ascending[0]?.namespace ?? ""
  if (!newest) return null
  return { namespace, records: ascending, coveredUntil: eventTimeOf(newest) }
}

/** Total, antisymmetric comparators — a sort comparator that returns 1 for equal
 *  elements is inconsistent and makes the cap non-deterministic at ties.
 *  Covered by "breaks maxRecords ties deterministically by id" in distill-select.test.ts. */
function compareEventTime(a: MemoryRecord, b: MemoryRecord): number {
  const ta = eventTimeOf(a)
  const tb = eventTimeOf(b)
  return ta < tb ? -1 : ta > tb ? 1 : 0
}
function compareId(a: MemoryRecord, b: MemoryRecord): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}
