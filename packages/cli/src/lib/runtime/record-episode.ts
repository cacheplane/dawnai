/**
 * The episode recorder: builds and writes one episodic memory per settled run.
 *
 * REQUEST PATH — this module is reached from `execute-route-core.ts`, so it
 * must stay free of `node:` imports (see test/fetch-entry-purity.test.ts).
 * That is why the record id hashes through `pure-hash.ts` rather than
 * `node:crypto`; the digest is byte-identical either way. The `@dawn-ai/memory`
 * import below is TYPE-ONLY and therefore erased at bundle time — it never
 * pulls the barrel (and its `node:sqlite`) onto the graph.
 */
import type { MemoryRecord, MemoryStore } from "@dawn-ai/memory"
import { sha1Hex } from "./pure-hash.js"

/** The two store methods the recorder needs. `Pick`ed so both the memory
 *  package's `MemoryStore` and core's structural `MemoryStoreLike` satisfy it. */
export type EpisodeStore = Pick<MemoryStore, "put" | "prune">

/** Resolved `config.memory.episodes` — the runtime episode recorder's knobs. */
export interface ResolvedEpisodesConfig {
  readonly enabled: boolean
  readonly ttlMs: number
  readonly cap: number
  readonly includeFailedRuns: boolean
  readonly embed: boolean
}

let warnedEmbedUnsupported = false

/**
 * Apply the episode-recorder defaults to a `config.memory.episodes` block.
 *
 * Defaults: disabled, 30-day TTL, 500-episode per-namespace cap, failed runs
 * included, no embeddings. Absent/undefined config ⇒ all defaults, which is
 * why an app with no `dawn.config.ts` records nothing.
 *
 * `embed: true` is not supported this cycle — it resolves to `false` and logs
 * a one-line warning once per process (honest, forward-compatible).
 *
 * Pure by design: the request path derives this from the `DawnConfig` it has
 * already loaded (or that the caller injected), while the node-side
 * `resolveEpisodesConfig` in `resolve-memory.ts` reads `dawn.config.ts` from
 * disk and delegates here. One defaulting rule, two entry points.
 */
export function resolveEpisodesFromConfig(
  episodes:
    | {
        readonly enabled?: boolean
        readonly ttlMs?: number
        readonly cap?: number
        readonly includeFailedRuns?: boolean
        readonly embed?: boolean
      }
    | undefined,
): ResolvedEpisodesConfig {
  if (episodes?.embed === true && !warnedEmbedUnsupported) {
    warnedEmbedUnsupported = true
    console.warn(
      "[dawn] memory.episodes.embed is not yet supported; episodes are recorded without embeddings",
    )
  }
  return {
    enabled: episodes?.enabled ?? false,
    ttlMs: episodes?.ttlMs ?? 30 * 86_400_000,
    cap: episodes?.cap ?? 500,
    includeFailedRuns: episodes?.includeFailedRuns ?? true,
    embed: false,
  }
}

export interface EpisodeInput {
  readonly namespace: string
  readonly input: string
  readonly outcome: "ok" | "error"
  readonly toolsUsed: readonly string[]
  readonly startedAt: number
  readonly finishedAt: number
  readonly ttlMs: number
  readonly runId?: string
  readonly threadId?: string
}

export function buildEpisode(ep: EpisodeInput): MemoryRecord {
  const startedIso = new Date(ep.startedAt).toISOString()
  const sourceId = ep.runId ?? ep.threadId ?? startedIso
  const id = `memory_ep_${sha1Hex(`${ep.namespace}|${sourceId}|${startedIso}`).slice(0, 16)}`
  const durationMs = Math.max(0, ep.finishedAt - ep.startedAt)
  const seconds = (durationMs / 1000).toFixed(1)
  const inputLine = ep.input.replaceAll("\n", " ").slice(0, 80)
  const writtenAt = new Date(ep.finishedAt).toISOString()
  return {
    id,
    kind: "episodic",
    namespace: ep.namespace,
    content: `run ${ep.outcome}: ${inputLine} (${ep.toolsUsed.length} tools, ${seconds}s)`,
    data: {
      input: ep.input.slice(0, 500),
      outcome: ep.outcome,
      toolsUsed: [...ep.toolsUsed],
      durationMs,
      ...(ep.threadId ? { threadId: ep.threadId } : {}),
      ...(ep.runId ? { runId: ep.runId } : {}),
    },
    source: { type: "run", id: sourceId },
    confidence: 1,
    tags: [],
    status: "active",
    createdAt: writtenAt,
    updatedAt: writtenAt,
    effectiveAt: startedIso,
    expiresAt: new Date(ep.startedAt + ep.ttlMs).toISOString(),
  }
}

/** Write an episode + lazy retention. NEVER throws — recorder failures must not
 *  fail a user's run; logged once per process. */
let warnedOnce = false
export async function recordEpisode(
  store: EpisodeStore,
  ep: EpisodeInput,
  opts: { readonly cap: number },
): Promise<void> {
  try {
    const record = buildEpisode(ep)
    await store.put(record)
    await store.prune({
      now: new Date(ep.finishedAt).toISOString(),
      namespacePrefix: ep.namespace,
      cap: opts.cap,
    })
  } catch (error) {
    if (!warnedOnce) {
      warnedOnce = true
      console.warn(`[dawn] episode recording failed (further failures muted): ${String(error)}`)
    }
  }
}

/**
 * Collect the unique tool names invoked during a run from the final LangGraph
 * state's `messages`. Handles both live LangChain message instances (plain
 * property access: `type: "ai"` + `tool_calls`, `type: "tool"` + `name`) and
 * the serialized-constructor shape (`id: [..., "AIMessage"|"ToolMessage"]` +
 * `kwargs`). Purely structural — no instanceof, no LangChain imports.
 */
export function extractToolNames(output: unknown): string[] {
  const messages =
    output !== null &&
    typeof output === "object" &&
    Array.isArray((output as { messages?: unknown }).messages)
      ? ((output as { messages: unknown[] }).messages as unknown[])
      : []
  const seen = new Set<string>()
  const names: string[] = []
  const add = (name: unknown): void => {
    if (typeof name === "string" && name !== "" && !seen.has(name)) {
      seen.add(name)
      names.push(name)
    }
  }
  for (const m of messages) {
    if (m === null || typeof m !== "object") continue
    const msg = m as Record<string, unknown>
    const kwargs =
      msg.kwargs !== null && typeof msg.kwargs === "object"
        ? (msg.kwargs as Record<string, unknown>)
        : undefined
    // AIMessage tool_calls: live/plain shape carries them on the message,
    // serialized shape nests them under kwargs.
    const rawToolCalls = Array.isArray(msg.tool_calls)
      ? msg.tool_calls
      : Array.isArray(kwargs?.tool_calls)
        ? kwargs.tool_calls
        : []
    for (const call of rawToolCalls) {
      if (call === null || typeof call !== "object") continue
      const c = call as { name?: unknown; function?: unknown }
      const fn =
        c.function !== null && typeof c.function === "object"
          ? (c.function as { name?: unknown })
          : undefined
      add(c.name ?? fn?.name)
    }
    // ToolMessage name fallback (covers tools whose AIMessage was summarized away).
    const idArr = msg.id
    const isSerializedToolMessage =
      Array.isArray(idArr) && idArr[idArr.length - 1] === "ToolMessage"
    if (msg.type === "tool") add(msg.name)
    else if (isSerializedToolMessage) add(kwargs?.name)
  }
  return names
}

/**
 * True when a final LangGraph output represents a PARKED (interrupted) turn
 * rather than a completed run: LangGraph's invoke() path surfaces pending
 * HITL interrupts as a non-empty `__interrupt__` array on the final state.
 * (The streamEvents path does NOT include the key — interrupts surface as
 * stream chunks there, which the stream-path recorder tracks separately.)
 */
export function hasPendingInterrupt(output: unknown): boolean {
  if (output === null || typeof output !== "object") return false
  const interrupts = (output as { __interrupt__?: unknown }).__interrupt__
  return Array.isArray(interrupts) && interrupts.length > 0
}

/**
 * Extract the user's message text for a run from the raw route input.
 * Accepts a bare string, or a `{ messages: [...] }` envelope in which the
 * LAST human message wins ("user" role, "human" type, or a serialized
 * HumanMessage). Content may be a string or an array of `{type:"text",text}`
 * parts. Defensive throughout; empty string fallback.
 */
export function extractUserInputText(input: unknown): string {
  if (typeof input === "string") return input
  if (input === null || typeof input !== "object") return ""
  const messages = (input as { messages?: unknown }).messages
  if (!Array.isArray(messages)) return ""
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m === null || typeof m !== "object") continue
    const msg = m as Record<string, unknown>
    const idArr = msg.id
    const isHuman =
      msg.role === "user" ||
      msg.type === "human" ||
      (Array.isArray(idArr) && idArr[idArr.length - 1] === "HumanMessage")
    if (!isHuman) continue
    const kwargs =
      msg.kwargs !== null && typeof msg.kwargs === "object"
        ? (msg.kwargs as Record<string, unknown>)
        : undefined
    const text = contentText(msg.content ?? kwargs?.content)
    if (text !== "") return text
  }
  return ""
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  const parts: string[] = []
  for (const part of content) {
    if (part === null || typeof part !== "object") continue
    const p = part as { type?: unknown; text?: unknown }
    if (p.type === "text" && typeof p.text === "string") parts.push(p.text)
  }
  return parts.join(" ")
}
