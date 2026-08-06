import {
  type BrowseQuery,
  buildConsolidationPrompt,
  buildReflectionPrompt,
  buildReflectionRecords,
  buildSummaryRecord,
  type ConsolidationBatch,
  eventTimeOf,
  type MemoryRecord,
  type MemoryStore,
  parseConsolidationOutput,
  parseReflectionOutput,
  type ReflectionInput,
  selectConsolidationBatches,
  selectReflectionInput,
} from "@dawn-ai/memory"
import { type CommandIo, formatErrorMessage, writeLine } from "../output.js"

/** The engine writes progress to the command's io — same seam every command uses. */
export type DistillIo = CommandIo

/** The only thing the engine needs from a chat model. Injected so the tests (and
 *  aimock) can drive the whole engine without a provider package. */
export interface ModelLike {
  invoke(prompt: string): Promise<{ content: unknown }>
}

export interface DistillResult {
  /** Batches ATTEMPTED this pass (already capped by `maxBatches`). */
  readonly batches: number
  /** Derived records written (summaries for consolidation, insights for reflection). */
  readonly written: number
  /** Batches that failed; each is isolated and logged, never fatal. */
  readonly failed: number
}

/** Structural view of `ResolvedDistillConfig` — deliberately widened (`provider`
 *  as a plain string) because the engine never resolves a provider itself; the
 *  caller does that when it builds `createModel`. */
export interface DistillConfigLike {
  readonly model?: string
  readonly provider?: string
  readonly maxBatches: number
  readonly consolidate: {
    readonly olderThanMs: number
    readonly minBatchSize: number
    readonly maxBatchSize: number
    readonly ttlMs?: number
    /** Optional here (the resolver always populates it) — absent falls back to
     *  DEFAULT_SOURCE_TTL_MS so a hand-built config still frees cap budget. */
    readonly sourceTtlMs?: number
  }
  readonly reflect: {
    readonly minNewRecords: number
    readonly maxRecords: number
    readonly writes: "candidate" | "auto"
  }
}

export interface DistillArgs {
  readonly store: MemoryStore
  readonly config: DistillConfigLike
  /** ISO "now" — the engine never reads a clock (same rule as the pure layer). */
  readonly now: string
  readonly io: DistillIo
  /** Report what would happen; makes ZERO model calls and writes nothing. */
  readonly dryRun?: boolean
  /** Restrict the pass to namespaces starting with this prefix. */
  readonly namespacePrefix?: string
  /** Built at most ONCE per pass, and only when there is work to do. */
  readonly createModel: () => Promise<ModelLike>
}

/**
 * Hard ceiling on rows pulled into one distillation pass. `browse` orders
 * `updated_at DESC`, so a store with more matching rows than this would silently
 * drop the OLDEST rows — exactly the ones most due for consolidation. Rather than
 * accept that, `gatherRecords` seeks the oldest window via `offset` when the
 * result is truncated (two queries, no unbounded pagination) and says so on
 * stderr. Reflection keeps the newest window instead: `selectReflectionInput`
 * caps to the newest `maxRecords` anyway.
 */
const MAX_SCAN_RECORDS = 10_000

/** How far back to look for a namespace's reflection watermark. `browse` has no
 *  exact-namespace filter, so a prefix scan can also return sibling namespaces'
 *  reflections; scanning a window and taking the max `coveredUntil` of the EXACT
 *  namespace is strictly safer than trusting the single newest row. */
const WATERMARK_SCAN_RECORDS = 200

const DEFAULT_OLDER_THAN_MS = 7 * 86_400_000
const DEFAULT_MIN_BATCH_SIZE = 5
const DEFAULT_MAX_BATCH_SIZE = 50
const DEFAULT_SOURCE_TTL_MS = 7 * 86_400_000
const DEFAULT_MIN_NEW_RECORDS = 10
const DEFAULT_MAX_RECORDS = 100

/**
 * Consolidate old episodic records into per-(namespace, week) summaries.
 *
 * Write-then-link: the summary is `put` FIRST and its sources are superseded
 * only afterwards, so a crash between the two leaves a redundant summary (cheap,
 * visible) instead of orphaned superseded records with nothing summarizing them.
 */
export async function runConsolidation(args: DistillArgs): Promise<DistillResult> {
  const { store, config, now, io } = args
  const cutoff = new Date(
    parseNow(now) - nonNegativeMs(config.consolidate.olderThanMs, DEFAULT_OLDER_THAN_MS),
  ).toISOString()

  const actives = await gatherRecords(
    store,
    {
      kind: "episodic",
      status: "active",
      ...(args.namespacePrefix === undefined ? {} : { namespacePrefix: args.namespacePrefix }),
    },
    { oldestWhenTruncated: true, io, label: "episodic" },
  )
  // A summary is itself an active episodic record; re-consolidating it would
  // summarize summaries and lose the provenance chain, so `derivedFrom` records
  // are excluded from every pass.
  const eligible = actives.filter((r) => !isDerived(r) && eventTimeOf(r) <= cutoff)

  const selected = selectConsolidationBatches(eligible, {
    minBatchSize: positiveInt(config.consolidate.minBatchSize, DEFAULT_MIN_BATCH_SIZE),
    maxBatchSize: positiveInt(config.consolidate.maxBatchSize, DEFAULT_MAX_BATCH_SIZE),
  }).sort(oldestBatchFirst)
  // Oldest batch first, so a capped pass always makes progress on the records
  // that have been waiting longest instead of re-picking whatever browse
  // happened to return first.
  const batches = selected.slice(0, batchLimit(config.maxBatches))

  if (batches.length === 0) {
    writeLine(io.stdout, "nothing to consolidate")
    return { batches: 0, written: 0, failed: 0 }
  }

  if (args.dryRun) {
    for (const batch of batches) {
      writeLine(
        io.stdout,
        `${batch.namespace}  ${batch.period.since} → ${batch.period.until}  ${batch.records.length} records`,
      )
    }
    const records = batches.reduce((sum, b) => sum + b.records.length, 0)
    writeLine(
      io.stdout,
      `${batches.length} batch(es), ${records} records — dry run, nothing written`,
    )
    reportRemaining(io, selected.length - batches.length, "consolidate", "batch(es)")
    return { batches: batches.length, written: 0, failed: 0 }
  }

  const model = await args.createModel()
  const ttlMs = config.consolidate.ttlMs
  // A superseded source is invisible to recall but still occupies a slot in the
  // per-namespace episodic cap, which is status-agnostic — so without an expiry
  // the compacted rows would keep evicting live ones forever (agent-authored
  // episodic writes carry no expiresAt of their own). Stamping one hands the
  // budget back on the next prune, after a window in which the source is still
  // inspectable. Covered by "stamps the default source TTL…" (distill-engine).
  const sourceExpiresAt = new Date(
    parseNow(now) + nonNegativeMs(config.consolidate.sourceTtlMs, DEFAULT_SOURCE_TTL_MS),
  ).toISOString()
  let written = 0
  let failed = 0
  for (const batch of batches) {
    try {
      const response = await model.invoke(buildConsolidationPrompt(batch))
      const { summary } = parseConsolidationOutput(messageText(response.content))
      const record = buildSummaryRecord(
        batch,
        summary,
        now,
        ttlMs !== undefined && Number.isFinite(ttlMs) && ttlMs > 0 ? { ttlMs } : undefined,
      )
      await store.put(record)
      written += 1
      // Link only after the write lands. The expiry is stamped per source and
      // only once ITS supersede succeeded — a source that is still active must
      // never be scheduled for deletion, because nothing summarizes it yet.
      // `update` merges the patch over the row it re-reads (and re-attaches the
      // persisted embedding), so this preserves status/content/provenance.
      for (const source of batch.records) {
        await store.supersede(source.id, record.id)
        await store.update(source.id, { expiresAt: sourceExpiresAt })
      }
      writeLine(
        io.stdout,
        `consolidated ${batch.records.length} records in ${batch.namespace} → ${record.id}`,
      )
    } catch (error) {
      failed += 1
      writeLine(
        io.stderr,
        `consolidation failed for ${batch.namespace} (${batch.period.since}): ${formatErrorMessage(error)}`,
      )
    }
  }
  reportRemaining(io, selected.length - batches.length, "consolidate", "batch(es)")
  return { batches: batches.length, written, failed }
}

/**
 * Derive durable insights from each namespace's recent memories, once per
 * namespace, advancing a per-namespace watermark so re-running is cheap.
 */
export async function runReflection(args: DistillArgs): Promise<DistillResult> {
  const { store, config, now, io } = args
  const stats = await store.stats(
    args.namespacePrefix === undefined ? {} : { namespacePrefix: args.namespacePrefix },
  )
  const namespaces = Object.keys(stats.byNamespace).sort()
  const limit = batchLimit(config.maxBatches)
  const minNewRecords = positiveInt(config.reflect.minNewRecords, DEFAULT_MIN_NEW_RECORDS)
  const maxRecords = positiveInt(config.reflect.maxRecords, DEFAULT_MAX_RECORDS)

  // Phase 1 — selection only. No model exists yet, so a pass with nothing to do
  // never constructs one (and a dry run never can).
  const inputs: ReflectionInput[] = []
  let skipped = 0
  let failed = 0
  for (const namespace of namespaces) {
    if (inputs.length >= limit) {
      skipped += 1
      continue
    }
    try {
      const coveredUntil = await readWatermark(store, namespace)
      const records = await gatherNamespaceMemories(store, namespace, io)
      const input = selectReflectionInput(records, {
        minNewRecords,
        maxRecords,
        ...(coveredUntil === undefined ? {} : { coveredUntil }),
      })
      if (input) inputs.push(input)
    } catch (error) {
      failed += 1
      writeLine(io.stderr, `reflection failed for ${namespace}: ${formatErrorMessage(error)}`)
    }
  }

  if (inputs.length === 0) {
    writeLine(io.stdout, "nothing to reflect on")
    return { batches: 0, written: 0, failed }
  }

  if (args.dryRun) {
    for (const input of inputs) {
      writeLine(
        io.stdout,
        `${input.namespace}  ${input.records.length} records through ${input.coveredUntil}`,
      )
    }
    writeLine(io.stdout, `${inputs.length} namespace(s) — dry run, nothing written`)
    reportRemaining(io, skipped, "reflect", "namespace(s)")
    return { batches: inputs.length, written: 0, failed }
  }

  const status = config.reflect.writes === "auto" ? "active" : "candidate"
  const model = await args.createModel()
  let written = 0
  for (const input of inputs) {
    try {
      const response = await model.invoke(buildReflectionPrompt(input))
      const { insights } = parseReflectionOutput(messageText(response.content))
      const records = buildReflectionRecords(input, insights, now, { status })
      for (const record of records) {
        await store.put(record)
        written += 1
      }
      writeLine(
        io.stdout,
        `reflected on ${input.records.length} records in ${input.namespace} → ${records.length} ${status} insight(s)`,
      )
    } catch (error) {
      failed += 1
      writeLine(io.stderr, `reflection failed for ${input.namespace}: ${formatErrorMessage(error)}`)
    }
  }
  reportRemaining(io, skipped, "reflect", "namespace(s)")
  return { batches: inputs.length, written, failed }
}

/** Newest `coveredUntil` already reflected for EXACTLY this namespace, if any. */
async function readWatermark(store: MemoryStore, namespace: string): Promise<string | undefined> {
  const page = await store.browse({
    kind: "reflection",
    namespacePrefix: namespace,
    limit: WATERMARK_SCAN_RECORDS,
  })
  let watermark: string | undefined
  for (const record of page.records) {
    if (record.namespace !== namespace) continue
    const covered = record.data.coveredUntil
    if (typeof covered !== "string") continue
    if (watermark === undefined || covered > watermark) watermark = covered
  }
  return watermark
}

/** A namespace's reflection input: its active episodic (summaries included — a
 *  summary is a legitimate, denser memory and its sources are superseded, so it
 *  cannot be counted twice) plus its active semantic records. */
async function gatherNamespaceMemories(
  store: MemoryStore,
  namespace: string,
  io: DistillIo,
): Promise<MemoryRecord[]> {
  const records: MemoryRecord[] = []
  for (const kind of ["episodic", "semantic"] as const) {
    const page = await gatherRecords(
      store,
      { kind, status: "active", namespacePrefix: namespace },
      { oldestWhenTruncated: false, io, label: kind },
    )
    // `namespacePrefix` is a prefix, not an equality filter: "route=/a" also
    // matches "route=/ab", whose records belong to their own pass.
    for (const record of page) {
      if (record.namespace === namespace) records.push(record)
    }
  }
  return records
}

/** Read up to MAX_SCAN_RECORDS matching rows, keeping the end of the ordering
 *  that matters for the caller when the store holds more than the ceiling. */
async function gatherRecords(
  store: MemoryStore,
  query: BrowseQuery,
  opts: { oldestWhenTruncated: boolean; io: DistillIo; label: string },
): Promise<readonly MemoryRecord[]> {
  const page = await store.browse({ ...query, limit: MAX_SCAN_RECORDS })
  if (page.total <= page.records.length) return page.records
  const dropped = page.total - page.records.length
  if (!opts.oldestWhenTruncated) {
    writeLine(
      opts.io.stderr,
      `note: ${page.total} ${opts.label} records match; only the newest ${page.records.length} were considered (${dropped} skipped)`,
    )
    return page.records
  }
  // browse is updated_at DESC — seek the tail so the OLDEST rows (the ones most
  // due for consolidation) are the ones that survive the ceiling.
  const oldest = await store.browse({
    ...query,
    limit: MAX_SCAN_RECORDS,
    offset: page.total - MAX_SCAN_RECORDS,
  })
  writeLine(
    opts.io.stderr,
    `note: ${page.total} ${opts.label} records match; only the oldest ${oldest.records.length} were considered (${dropped} skipped — re-run to continue)`,
  )
  return oldest.records
}

function reportRemaining(io: DistillIo, remaining: number, command: string, unit: string): void {
  if (remaining > 0) {
    writeLine(
      io.stdout,
      `${remaining} more ${unit} not examined (maxBatches) — re-run \`dawn memory ${command}\` to continue`,
    )
  }
}

function isDerived(record: MemoryRecord): boolean {
  return record.data.derivedFrom !== undefined
}

function oldestBatchFirst(a: ConsolidationBatch, b: ConsolidationBatch): number {
  if (a.period.since !== b.period.since) return a.period.since < b.period.since ? -1 : 1
  return a.namespace < b.namespace ? -1 : a.namespace > b.namespace ? 1 : 0
}

/** LangChain message content is a string OR an array of content blocks; the
 *  parser only ever sees text either way. */
function messageText(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    const parts = content
      .filter(
        (part): part is { type: string; text: string } =>
          part !== null &&
          typeof part === "object" &&
          (part as { type?: unknown }).type === "text" &&
          typeof (part as { text?: unknown }).text === "string",
      )
      .map((part) => part.text)
    if (parts.length > 0) return parts.join("")
  }
  return String(content)
}

function parseNow(now: string): number {
  const ms = Date.parse(now)
  if (Number.isNaN(ms)) {
    throw new Error(`invalid timestamp for distillation: "${now}" (expected an ISO date-time)`)
  }
  return ms
}

/** `resolveDistillConfig` does no range validation by design — the engine clamps
 *  at use-site. Sizes must be integers ≥ 1: `selectConsolidationBatches` advances
 *  its chunk loop by `maxBatchSize`, so 0 or a negative would spin forever, and a
 *  negative `maxRecords` would make `slice(0, n)` drop from the wrong end.
 *  Non-finite (NaN, ±Infinity) falls back to the documented default. */
function positiveInt(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.max(1, Math.trunc(value))
}

/** `maxBatches` is a hard stop, not a size: 0 and negatives mean "do nothing"
 *  (an explicit off switch is more useful than a second spelling of unlimited),
 *  non-integers truncate, `Infinity` means unlimited, and NaN fails CLOSED — a
 *  typo must not authorize an unbounded model spend. */
function batchLimit(value: number): number {
  if (Number.isNaN(value)) return 0
  return Math.max(0, Math.trunc(value))
}

/** Durations only need to be non-negative and finite. `undefined` (an optional
 *  knob a hand-built config omitted) takes the documented default. */
function nonNegativeMs(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.max(0, value)
}
