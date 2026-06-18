import type { AimockFixture, AimockResponse, FixtureSet } from "./fixture-builder.js"

/** One captured real-model exchange: the request the agent sent + the response to bake. */
export interface Recording {
  readonly request: {
    readonly messages?: ReadonlyArray<{ readonly role: string; readonly content: unknown }>
  }
  readonly response: AimockResponse
}

function firstUserMessage(req: Recording["request"]): string | undefined {
  for (const m of req.messages ?? []) {
    if (m.role === "user" && typeof m.content === "string") return m.content
  }
  return undefined
}

function hasToolResult(req: Recording["request"]): boolean {
  return (req.messages ?? []).some((m) => m.role === "tool")
}

/**
 * Convert ordered recordings (one per LLM call within a single case/thread) into
 * a replay FixtureSet, keyed with the SAME `{userMessage,turnIndex,hasToolResult}`
 * convention `script()` produces — so the recorded file replays through the same
 * aimock matcher with no drift. `turnIndex` is the 0-based ordinal of the call
 * within the thread; `userMessage` is the first user message (stable across the
 * thread); `hasToolResult` is whether a tool-role message is already present.
 */
export function recordingsToFixtures(recordings: readonly Recording[]): FixtureSet {
  return recordings.map((rec, turnIndex): AimockFixture => {
    const userMessage = firstUserMessage(rec.request)
    return {
      match: {
        ...(userMessage !== undefined ? { userMessage } : {}),
        turnIndex,
        hasToolResult: hasToolResult(rec.request),
      },
      response: rec.response,
    }
  })
}
