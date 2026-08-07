import { sha1Hex } from "@dawn-ai/sdk/pure"
import { z } from "zod"
import { gateMemorySupersede } from "../permission-gate.js"
import type {
  CapabilityMarker,
  MemoryContext,
  MemoryKindLike,
  MemoryRecordLike,
  PromptFragment,
} from "../types.js"
import { resolveTimeExpr } from "./time-expr.js"

const DEFAULT_SEMANTIC_IDENTITY = ["subject", "predicate"] as const

// The valid memory kinds, surfaced to the MODEL via the recall schema's enum.
// `satisfies` proves every listed member IS a MemoryKindLike (a typo won't
// compile); the `_AllKindsListed` line proves the reverse — every MemoryKindLike
// is listed — so the pair keeps this in lockstep with the union in ../types.js.
const MEMORY_KINDS = [
  "semantic",
  "episodic",
  "procedural",
  "reflection",
] as const satisfies readonly MemoryKindLike[]
type _AllKindsListed = MemoryKindLike extends (typeof MEMORY_KINDS)[number] ? true : never
const _allKindsListed: _AllKindsListed = true
void _allKindsListed
// Belt to the schema's suspenders: run() casts its input without trusting
// upstream validation, so re-check membership before touching the store.
const isMemoryKind = (k: string): k is MemoryKindLike =>
  (MEMORY_KINDS as readonly string[]).includes(k)

/**
 * Shared `since`/`until` guidance. A model does not know today's date, and asked
 * a question like "what did you work on last week?" it will confidently invent an
 * ABSOLUTE window from around its training cutoff — observed live: a 2026 store
 * queried with `since: "2023-10-02", until: "2023-10-09"`, which matched nothing
 * and produced a flat "I have no memories of that". The failure is silent (an
 * empty result is indistinguishable from an empty store), so the schema steers to
 * the relative form, which `resolveTimeExpr` anchors to the request clock, and
 * says plainly that no bound at all beats a guessed one.
 * Pinned by "steers the model away from guessed absolute time windows"
 * (memory-capability-recall.test.ts).
 */
const TIME_BOUND_GUIDANCE =
  'Use a RELATIVE offset ("-24h", "-7d", "-30d"), which is resolved against the current time. ' +
  "You do NOT know today's date: an absolute ISO timestamp you guessed will silently match " +
  "nothing. Omit this unless the user asked for a specific time range — recall is already " +
  "ranked by recency."

// A route's defineMemory() schema arrives as `unknown` (loaded via dynamic
// import, validated structurally). Module-scoped (no closure deps) so it isn't
// recreated on every load(). A non-Zod value must NOT be handed to z.object()
// as the remember tool's `data` shape — it would blow up opaquely at use time.
const isZodSchema = (s: unknown): s is z.ZodTypeAny =>
  typeof s === "object" &&
  s !== null &&
  typeof (s as { safeParse?: unknown }).safeParse === "function"

/**
 * Long-term memory (L3): contributes `recall` and `remember` tools backed by a
 * typed, namespaced memory store, plus a memory-index prompt fragment listing
 * the in-scope memories the agent can recall. Activated only when the CLI
 * supplies context.memory (i.e. the route has a memory.ts). Deterministic: no
 * Date.now()/new Date(); timestamps come from context.memory.now().
 */
export function createMemoryMarker(): CapabilityMarker {
  return {
    name: "memory",
    detect: async (_routeDir, context) => context.memory !== undefined,
    load: async (_routeDir, context) => {
      const mem = context.memory
      if (!mem) return {}
      const permissions = context.permissions
      let indexEntries = await loadIndexEntries(mem)
      // Tool input schemas exposed to the MODEL (so it knows what to pass). The
      // `remember.data` shape is the route's own defineMemory() zod schema; without
      // this the model calls remember/recall with the wrong/empty args and writes
      // are rejected by validate(). Guarded (see isZodSchema) so a non-Zod value
      // falls back to a permissive map instead of failing opaquely.
      const routeDataSchema: z.ZodTypeAny = isZodSchema(mem.schema)
        ? mem.schema
        : z.record(z.string(), z.unknown())
      const rememberSchema = z.object({
        data: routeDataSchema,
        content: z
          .string()
          .describe("A short human-readable summary of this memory (what you'd recall)."),
        tags: z.array(z.string()).optional().describe("Optional tags to filter on later."),
        confidence: z.number().min(0).max(1).optional(),
      })
      const recallSchema = z.object({
        query: z.string().optional().describe("Keywords to match against stored memories."),
        kind: z.enum(MEMORY_KINDS).optional().describe("Filter by memory kind."),
        tags: z.array(z.string()).optional(),
        limit: z.number().int().positive().optional(),
        since: z
          .string()
          .optional()
          .describe(`Inclusive lower bound on when the memory happened. ${TIME_BOUND_GUIDANCE}`),
        until: z
          .string()
          .optional()
          .describe(`Exclusive upper bound on when the memory happened. ${TIME_BOUND_GUIDANCE}`),
      })

      const recall = {
        name: "recall",
        description: "Recall typed long-term memories by keyword/kind/tags.",
        schema: recallSchema,
        run: async (input: unknown) => {
          const q = (input ?? {}) as {
            query?: string
            kind?: string
            tags?: string[]
            limit?: number
            since?: string
            until?: string
          }
          // An unknown kind can never match a stored row — answer directly
          // instead of passing an out-of-contract string to the store.
          let kind: MemoryKindLike | undefined
          if (q.kind) {
            if (!isMemoryKind(q.kind)) return { result: "(no memories found)" }
            kind = q.kind
          }
          const now = mem.now()
          // Resolve since/until (ISO or relative "-24h") against the request
          // clock. A parse failure is a MODEL mistake — return the actionable
          // message as the tool result (never throw) so it can self-correct.
          let since: string | undefined
          let until: string | undefined
          try {
            if (q.since) since = resolveTimeExpr(q.since, now)
            if (q.until) until = resolveTimeExpr(q.until, now)
          } catch (err) {
            return { result: err instanceof Error ? err.message : String(err) }
          }
          // Embed the query for the hybrid keyword+vector path when an embedder
          // is configured. Embed FAILURE degrades to keyword-only — never throw,
          // so a flaky/offline embedder can't break recall.
          let queryVec: Float32Array | undefined
          if (mem.embedder && q.query) {
            try {
              ;[queryVec] = await mem.embedder.embed([q.query])
            } catch (err) {
              // Gated: silent embed failures are an ops footgun (user thinks
              // vector recall works while every embed errors). Mirrors the
              // summarization hook's DAWN_DEBUG_SUMMARIZATION convention.
              if (process.env.DAWN_DEBUG_MEMORY === "1") {
                console.warn(
                  `[dawn:memory] recall embed failed, falling back to keyword-only: ${String(err)}`,
                )
              }
              queryVec = undefined
            }
          }
          const rows = await mem.store.search({
            namespace: mem.namespace,
            ...(q.query ? { query: q.query } : {}),
            ...(kind ? { kind } : {}),
            ...(q.tags ? { tags: q.tags } : {}),
            ...(since ? { since } : {}),
            ...(until ? { until } : {}),
            limit: q.limit ?? 8,
            // Recency reference for ranked recall — the per-request timestamp,
            // NOT Date.now() (determinism rule; see module docblock).
            now,
            ...(queryVec && mem.embedder
              ? {
                  queryEmbedding: queryVec,
                  embedderId: mem.embedder.id,
                  vector: mem.vector,
                }
              : {}),
          })
          // Wrap in {result} so the langchain bridge uses the string verbatim as
          // the ToolMessage content; a bare string hits unwrapToolResult's
          // JSON.stringify path, quoting it and escaping the newlines below.
          if (rows.length === 0) return { result: "(no memories found)" }
          return {
            result: rows.map((r) => `${r.id}: ${r.content}`).join("\n"),
          }
        },
      }

      const remember = {
        name: "remember",
        description: "Store a typed long-term memory for later recall.",
        schema: rememberSchema,
        run: async (input: unknown) => {
          const inp = (input ?? {}) as {
            data?: unknown
            content?: string
            tags?: string[]
            confidence?: number
          }
          const validated = mem.validate(inp.data)
          // All returns below wrap in {result} — see the recall tool's note.
          if (!validated.ok) return { result: `Rejected: ${validated.errors}` }
          const data = validated.value

          // Per-kind write policy. Core cannot import @dawn-ai/memory (its
          // barrel pulls node:sqlite), so the policy is inlined: semantic →
          // reconcile, episodic/reflection → append, procedural → not yet wired.
          // Mirrored in packages/memory/src/reconcile.ts writePolicyFor — keep in sync.
          if (mem.defined.kind === "procedural") {
            return {
              result: `memory kind '${mem.defined.kind}' is not yet wired (semantic, episodic and reflection are)`,
            }
          }
          // Reflection insights ACCUMULATE (a later insight never contradicts an
          // earlier one), so they append exactly like episodes; superseding
          // stale insights is a future concern.
          const append = mem.defined.kind === "episodic" || mem.defined.kind === "reflection"
          const identityKeys = mem.defined.identity ?? DEFAULT_SEMANTIC_IDENTITY
          const now = mem.now()

          // id is DATA-derived so contradicting values (same identity, different
          // value) get distinct ids and can coexist as active/superseded rows.
          // Append kinds additionally hash the request timestamp: identical
          // episodic data on different runs is DIFFERENT events, and put() is
          // an id-keyed upsert in the real stores — same-id appends would
          // silently collapse into one row.
          const id = `memory_${sha1Hex(
            `${mem.namespace}|${JSON.stringify(data)}${append ? `|${now}` : ""}`,
          ).slice(0, 16)}`

          // "ask" shares auto's write semantics; only its SUPERSEDE branch gates.
          // Append kinds never supersede, so in "ask" mode no gate ever fires
          // for them — episodic writes land silently, exactly like "auto".
          const autoLike = mem.writes === "auto" || mem.writes === "ask"
          const status = autoLike ? "active" : "candidate"
          const content =
            typeof inp.content === "string" && inp.content.length > 0
              ? inp.content
              : JSON.stringify(data)
          const confidence = typeof inp.confidence === "number" ? inp.confidence : 1
          const tags = inp.tags ?? []

          const record: MemoryRecordLike = {
            id,
            kind: mem.defined.kind,
            namespace: mem.namespace,
            content,
            data,
            source: { type: "tool", id: "remember" },
            confidence,
            tags,
            status,
            createdAt: now,
            updatedAt: now,
            // Append kinds record WHEN the event happened (the request time —
            // same clock as createdAt/updatedAt above). No expiresAt: TTL for
            // agent-authored episodes is the store-level prune's business.
            ...(append ? { effectiveAt: now } : {}),
          }

          // Embed the content for vector recall when an embedder is configured.
          // Embed FAILURE degrades to keyword-only (putOpts stays undefined) —
          // NEVER lose the write. Forwarded to EVERY put site below.
          let putOpts: { embedding?: Float32Array; embeddingModel?: string } | undefined
          if (mem.embedder) {
            try {
              const [ev] = await mem.embedder.embed([content])
              if (ev) putOpts = { embedding: ev, embeddingModel: mem.embedder.id }
            } catch (err) {
              // Gated warn — see the recall catch above. The write still lands
              // keyword-only (putOpts undefined); we never lose the memory.
              if (process.env.DAWN_DEBUG_MEMORY === "1") {
                console.warn(
                  `[dawn:memory] remember embed failed, storing keyword-only: ${String(err)}`,
                )
              }
              putOpts = undefined
            }
          }

          // Append-only kinds skip the entire identity/reconcile block: an
          // episode is an event, not a belief — a later one never contradicts
          // an earlier one, so nothing is deduped, updated, or superseded (and
          // the "ask" gate never fires; see the autoLike comment above).
          if (append) {
            await mem.store.put(record, putOpts)
            return {
              result: autoLike
                ? `Stored memory ${id}.`
                : `Stored memory candidate ${id} (pending approval).`,
            }
          }

          if (autoLike) {
            // Inline identity key helper — avoids importing from @dawn-ai/memory
            const identityKey = (d: Record<string, unknown>) =>
              identityKeys.map((k) => JSON.stringify(d[k] ?? null)).join(" ")

            const existing = await mem.store.search({
              namespace: mem.namespace,
              status: "active",
              limit: 50,
              // Deliberately NO `now`: an expired-but-still-active row must
              // remain visible here so a new write can still supersede it.
            })
            const target = existing.find((m) => identityKey(m.data) === identityKey(data))

            if (target) {
              if (JSON.stringify(target.data) === JSON.stringify(data)) {
                // Idempotent update — same identity AND same data
                await mem.store.update(target.id, {
                  updatedAt: now,
                  content,
                  confidence,
                  tags,
                })
                return { result: `Updated memory ${target.id}.` }
              }
              // Same identity but different value — supersede. In "ask" mode this
              // is the one write that gates: the agent is contradicting a prior
              // belief. ADDs/idempotent UPDATEs above never reach the gate.
              if (mem.writes === "ask") {
                const gate = await gateMemorySupersede(permissions, {
                  namespace: mem.namespace,
                  // Human-readable display form for the prompt — deliberately NOT
                  // the `identityKey` match key above (which JSON.stringifies to
                  // stay unambiguous); do not merge the two.
                  identity: identityKeys.map((k) => String(data[k] ?? "")).join(" / "),
                  oldId: target.id,
                  oldContent: target.content,
                  newContent: content,
                })
                if (!gate.allowed) {
                  return {
                    result:
                      `Kept existing memory ${target.id} ("${target.content}"); ` +
                      `your contradicting value was not stored (${gate.reason}).`,
                  }
                }
              }
              await mem.store.put(record, putOpts)
              await mem.store.supersede(target.id, id)
              return { result: `Superseded ${target.id} with ${id}.` }
            }

            // No existing record with same identity — add new active row
            await mem.store.put(record, putOpts)
            return { result: `Stored memory ${id}.` }
          }

          // Candidate mode (and "off" never reaches here — remember tool absent):
          // write a candidate; reconciliation happens later at CLI approval.
          await mem.store.put(record, putOpts)
          return {
            result: `Stored memory candidate ${id} (pending approval).`,
          }
        },
      }

      // Fingerprint the snapshot captured at load time for callers that cache
      // materialized agents. renderAsync below handles longer-lived prepared
      // child graphs that do not pass through materialization again.
      const indexCacheKey =
        indexEntries.length === 0
          ? "memory:empty"
          : `memory:${sha1Hex(indexEntries.map((r) => `${r.id}@${r.updatedAt}`).join("\n")).slice(
              0,
              16,
            )}`

      const promptFragment: PromptFragment = {
        placement: "after_user_prompt",
        cacheKey: indexCacheKey,
        render: () => renderIndexEntries(indexEntries),
        renderAsync: async () => {
          const refreshed = await loadIndexEntries(mem)
          indexEntries = refreshed
          return renderIndexEntries(refreshed)
        },
      }

      const tools = mem.writes === "off" ? [recall] : [recall, remember]
      return { tools, promptFragment }
    },
  }
}

function loadIndexEntries(mem: MemoryContext) {
  return mem.store.search({
    namespace: mem.namespace,
    status: "active",
    limit: mem.indexMaxEntries ?? 20,
    // Keep the index and recall views consistent by filtering expired rows
    // against the live clock supplied by the runtime.
    now: mem.now(),
  })
}

function renderIndexEntries(entries: Awaited<ReturnType<typeof loadIndexEntries>>): string {
  if (entries.length === 0) return ""
  const lines = entries.map((r) => `- ${r.id}: ${r.content.slice(0, 80)}`).join("\n")
  return `# Long-Term Memory\n\nThese memories are available — call \`recall({ query })\` to load full details before relying on them.\n\n${lines}`
}
