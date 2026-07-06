import { createHash } from "node:crypto"
import { z } from "zod"
import { gateMemorySupersede } from "../permission-gate.js"
import type { CapabilityMarker, PromptFragment } from "../types.js"

const DEFAULT_SEMANTIC_IDENTITY = ["subject", "predicate"] as const

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
 * Date.now()/new Date(); timestamps come from context.memory.now.
 */
export function createMemoryMarker(): CapabilityMarker {
  return {
    name: "memory",
    detect: async (_routeDir, context) => context.memory !== undefined,
    load: async (_routeDir, context) => {
      const mem = context.memory
      if (!mem) return {}
      const permissions = context.permissions
      const indexEntries = await mem.store.search({
        namespace: mem.namespace,
        status: "active",
        limit: mem.indexMaxEntries ?? 20,
      })

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
        kind: z.string().optional(),
        tags: z.array(z.string()).optional(),
        limit: z.number().int().positive().optional(),
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
          }
          const rows = await mem.store.search({
            namespace: mem.namespace,
            ...(q.query ? { query: q.query } : {}),
            ...(q.kind ? { kind: q.kind } : {}),
            ...(q.tags ? { tags: q.tags } : {}),
            limit: q.limit ?? 8,
            // Recency reference for ranked recall — the per-request timestamp,
            // NOT Date.now() (determinism rule; see module docblock).
            now: mem.now,
          })
          if (rows.length === 0) return "(no memories found)"
          return rows.map((r) => `${r.id}: ${r.content}`).join("\n")
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
          if (!validated.ok) return `Rejected: ${validated.errors}`
          const data = validated.value
          const identityKeys = mem.defined.identity ?? DEFAULT_SEMANTIC_IDENTITY

          // id is DATA-derived so contradicting values (same identity, different
          // value) get distinct ids and can coexist as active/superseded rows.
          const id = `memory_${createHash("sha1")
            .update(`${mem.namespace}|${JSON.stringify(data)}`)
            .digest("hex")
            .slice(0, 16)}`

          // "ask" shares auto's write semantics; only its SUPERSEDE branch gates.
          const autoLike = mem.writes === "auto" || mem.writes === "ask"
          const status = autoLike ? "active" : "candidate"
          const content =
            typeof inp.content === "string" && inp.content.length > 0
              ? inp.content
              : JSON.stringify(data)
          const confidence = typeof inp.confidence === "number" ? inp.confidence : 1
          const tags = inp.tags ?? []

          const record = {
            id,
            kind: mem.defined.kind,
            namespace: mem.namespace,
            content,
            data,
            source: { type: "tool", id: "remember" },
            confidence,
            tags,
            status,
            createdAt: mem.now,
            updatedAt: mem.now,
          }

          if (autoLike) {
            // Inline identity key helper — avoids importing from @dawn-ai/memory
            const identityKey = (d: Record<string, unknown>) =>
              identityKeys.map((k) => JSON.stringify(d[k] ?? null)).join(" ")

            const existing = await mem.store.search({
              namespace: mem.namespace,
              status: "active",
              limit: 50,
            })
            const target = existing.find((m) => identityKey(m.data) === identityKey(data))

            if (target) {
              if (JSON.stringify(target.data) === JSON.stringify(data)) {
                // Idempotent update — same identity AND same data
                await mem.store.update(target.id, {
                  updatedAt: mem.now,
                  content,
                  confidence,
                  tags,
                })
                return `Updated memory ${target.id}.`
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
                  return (
                    `Kept existing memory ${target.id} ("${target.content}"); ` +
                    `your contradicting value was not stored (${gate.reason}).`
                  )
                }
              }
              await mem.store.put(record)
              await mem.store.supersede(target.id, id)
              return `Superseded ${target.id} with ${id}.`
            }

            // No existing record with same identity — add new active row
            await mem.store.put(record)
            return `Stored memory ${id}.`
          }

          // Candidate mode (and "off" never reaches here — remember tool absent):
          // write a candidate; reconciliation happens later at CLI approval.
          await mem.store.put(record)
          return `Stored memory candidate ${id} (pending approval).`
        },
      }

      // Fingerprint the snapshot the render closure froze at load time. `id`
      // covers adds/removes (supersede flips a row out of the active set);
      // `updatedAt` covers in-place content/confidence updates that keep the
      // same id. The agent adapter folds this into its materialize cache key so
      // a memory written after first materialize re-keys the cache (see
      // PromptFragment.cacheKey).
      const indexCacheKey =
        indexEntries.length === 0
          ? "memory:empty"
          : `memory:${createHash("sha1")
              .update(indexEntries.map((r) => `${r.id}@${r.updatedAt}`).join("\n"))
              .digest("hex")
              .slice(0, 16)}`

      const promptFragment: PromptFragment = {
        placement: "after_user_prompt",
        cacheKey: indexCacheKey,
        render: () => {
          if (indexEntries.length === 0) return ""
          const lines = indexEntries.map((r) => `- ${r.id}: ${r.content.slice(0, 80)}`).join("\n")
          return `# Long-Term Memory\n\nThese memories are available — call \`recall({ query })\` to load full details before relying on them.\n\n${lines}`
        },
      }

      const tools = mem.writes === "off" ? [recall] : [recall, remember]
      return { tools, promptFragment }
    },
  }
}
