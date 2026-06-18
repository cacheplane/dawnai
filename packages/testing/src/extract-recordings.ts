import type { AimockResponse, AimockToolCall } from "./fixture-builder.js"
import type { Recording } from "./record-fixtures.js"

/** The slice of an aimock `JournalEntry` we read. Structural to avoid importing aimock types. */
export interface JournalEntryLike {
  readonly body: {
    readonly messages?: ReadonlyArray<{ readonly role: string; readonly content: unknown }>
  } | null
  readonly response?: {
    readonly source?: string
    readonly fixture?: {
      readonly response?: unknown
    } | null
  }
}

/** aimock's baked fixture response → our AimockResponse. Returns null when unmappable. */
function toAimockResponse(fixtureResponse: unknown): AimockResponse | null {
  if (fixtureResponse === null || typeof fixtureResponse !== "object") return null
  const r = fixtureResponse as Record<string, unknown>
  if (Array.isArray(r.toolCalls)) {
    return { toolCalls: r.toolCalls as AimockToolCall[] }
  }
  if (typeof r.content === "string") return { content: r.content }
  return null
}

/**
 * Pull ordered recordings from aimock journal entries, keeping only proxied
 * (real-model) calls whose recorded fixture is present. The output order is the
 * journal order = the call order within the thread.
 */
export function extractRecordings(entries: readonly JournalEntryLike[]): Recording[] {
  const out: Recording[] = []
  for (const entry of entries) {
    if (entry.response?.source !== "proxy") continue
    const fixture = entry.response.fixture
    if (!fixture) continue
    const response = toAimockResponse(fixture.response)
    if (!response) continue
    const messages = entry.body?.messages
    out.push({ request: messages !== undefined ? { messages } : {}, response })
  }
  return out
}
