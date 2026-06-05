export interface AimockToolCall {
  readonly id: string
  readonly name: string
  readonly arguments: Record<string, unknown>
}

export type AimockResponse = { content: string } | { toolCalls: AimockToolCall[] }

export interface AimockFixture {
  readonly match: {
    readonly userMessage?: string
    readonly turnIndex?: number
    readonly hasToolResult?: boolean
  }
  readonly response: AimockResponse
}

export type FixtureSet = AimockFixture[]

export interface ScriptBuilder {
  user(text: string): ScriptBuilder
  callsTool(name: string, args: Record<string, unknown>, opts?: { id?: string }): ScriptBuilder
  replies(content: string): ScriptBuilder
  build(): FixtureSet
}

export function script(): ScriptBuilder {
  const fixtures: AimockFixture[] = []
  let groupIndex = -1
  let currentUser: string | undefined
  let stepInGroup = 0 // kept for tool call id generation only

  function pushResponse(response: AimockResponse): void {
    if (currentUser === undefined) {
      throw new Error("script(): call .user(text) before .callsTool()/.replies()")
    }
    // turnIndex = number of assistant messages already in the thread before this
    // LLM call (0 for the first call, 1 for the reply-after-tool, etc.).
    // hasToolResult = true only when there is already a tool-role message in the
    // thread, which is the case for the post-tool reply but not the initial call.
    // Both values are stable when the harness creates a fresh thread per test
    // (via h.reset()), so they unambiguously select the right fixture.
    fixtures.push({
      match: { userMessage: currentUser, turnIndex: stepInGroup, hasToolResult: stepInGroup > 0 },
      response,
    })
    stepInGroup += 1
  }

  const builder: ScriptBuilder = {
    user(text) {
      groupIndex += 1
      currentUser = text
      stepInGroup = 0
      return builder
    },
    callsTool(name, args, opts) {
      const id = opts?.id ?? `call_${name}_${groupIndex}_${stepInGroup}`
      pushResponse({ toolCalls: [{ id, name, arguments: args }] })
      return builder
    },
    replies(content) {
      pushResponse({ content })
      return builder
    },
    build() {
      return fixtures.slice()
    },
  }
  return builder
}
