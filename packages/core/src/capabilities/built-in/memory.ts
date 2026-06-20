import { createHash } from "node:crypto"
import type { CapabilityMarker, MemoryContext, PromptFragment } from "../types.js"

const DEFAULT_SEMANTIC_IDENTITY = ["subject", "predicate"] as const

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
      const indexEntries = await mem.store.search({
        namespace: mem.namespace,
        status: "active",
        limit: mem.indexMaxEntries ?? 20,
      })

      const recall = {
        name: "recall",
        description: "Recall typed long-term memories by keyword/kind/tags.",
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
          })
          if (rows.length === 0) return "(no memories found)"
          return rows.map((r) => `${r.id}: ${r.content}`).join("\n")
        },
      }

      const remember = {
        name: "remember",
        description: "Store a typed long-term memory for later recall.",
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

          const status = mem.writes === "auto" ? "active" : "candidate"
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

          if (mem.writes === "auto") {
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
              // Same identity but different value — write new active row then supersede old
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

      const promptFragment: PromptFragment = {
        placement: "after_user_prompt",
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
