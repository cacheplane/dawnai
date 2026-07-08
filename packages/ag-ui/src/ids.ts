/**
 * Generates ids for AG-UI events. `runId`/`threadId` never flow through here
 * (the consumer owns run identity via RunContext); a tool call's `toolCallId`
 * normally comes from the upstream chunk and only falls back to `"toolCall"`.
 */
export type IdFactory = (kind: "message" | "toolCall" | "toolResult") => string

const PREFIX: Record<"message" | "toolCall" | "toolResult", string> = {
  message: "msg",
  toolCall: "tc",
  toolResult: "tr",
}

/**
 * Deterministic, monotonically-increasing factory for tests: `msg-1`, `tc-1`,
 * `tr-1`, ... Each kind has an independent counter.
 */
export function createCounterIdFactory(): IdFactory {
  const counters = { message: 0, toolCall: 0, toolResult: 0 }
  return (kind) => {
    counters[kind] += 1
    return `${PREFIX[kind]}-${counters[kind]}`
  }
}

/**
 * Default production factory: collision-resistant, non-deterministic ids using
 * the platform crypto UUID.
 */
export function createDefaultIdFactory(): IdFactory {
  return (kind) => `${PREFIX[kind]}-${crypto.randomUUID()}`
}
