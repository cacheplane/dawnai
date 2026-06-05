import { AssertionError } from "node:assert"
import type { AgentRunResult } from "./run-result.js"

function fail(message: string): never {
  throw new AssertionError({ message })
}

function isSubset(subset: Record<string, unknown>, actual: unknown): boolean {
  if (typeof actual !== "object" || actual === null) return false
  const a = actual as Record<string, unknown>
  return Object.entries(subset).every(([k, v]) =>
    typeof v === "object" && v !== null ? isSubset(v as Record<string, unknown>, a[k]) : a[k] === v,
  )
}

export function expectToolCalled(run: AgentRunResult, name: string) {
  const calls = run.toolCalls.filter((c) => c.name === name)
  if (calls.length === 0) {
    fail(
      `expected tool "${name}" to be called; tools called: ${run.toolCalls.map((c) => c.name).join(", ") || "(none)"}`,
    )
  }
  return {
    withArgs(partial: Record<string, unknown>) {
      if (!calls.some((c) => isSubset(partial, c.args))) {
        fail(
          `expected "${name}" called withArgs >= ${JSON.stringify(partial)}; got ${JSON.stringify(calls.map((c) => c.args))}`,
        )
      }
    },
    times(n: number) {
      if (calls.length !== n) fail(`expected "${name}" called ${n}x but was ${calls.length}x`)
    },
    never() {
      fail(`expected "${name}" to NOT be called, but it was ${calls.length}x`)
    },
  }
}

export function expectFinalMessage(run: AgentRunResult) {
  return {
    toContain(s: string) {
      if (!run.finalMessage.includes(s))
        fail(`final message ${JSON.stringify(run.finalMessage)} does not contain ${JSON.stringify(s)}`)
    },
    toMatch(re: RegExp) {
      if (!re.test(run.finalMessage))
        fail(`final message ${JSON.stringify(run.finalMessage)} does not match ${re}`)
    },
    toEqual(s: string) {
      if (run.finalMessage !== s)
        fail(`final message ${JSON.stringify(run.finalMessage)} !== ${JSON.stringify(s)}`)
    },
  }
}

export function expectStreamedTokens(run: AgentRunResult): void {
  if (run.tokens.length === 0) fail("expected >=1 streamed token, got none")
}

export function expectOffloaded(run: AgentRunResult, toolName: string): void {
  const msg = run.messages.find((m) => {
    const id = (m as { id?: string[] }).id
    const kw = (m as { kwargs?: { name?: string } }).kwargs
    return Array.isArray(id) && id[2] === "ToolMessage" && kw?.name === toolName
  }) as { kwargs?: { content?: string } } | undefined
  const content = msg?.kwargs?.content ?? ""
  if (!content.includes("Tool output offloaded")) {
    fail(`expected "${toolName}" output to be offloaded (stub marker), got: ${content.slice(0, 120)}`)
  }
}

export function expectState(run: AgentRunResult) {
  const messages = Array.isArray(run.state.messages) ? (run.state.messages as unknown[]) : []
  return {
    messages: {
      toHaveLength(n: number) {
        if (messages.length !== n) fail(`expected state.messages length ${n}, got ${messages.length}`)
      },
    },
    field(name: string) {
      const value = run.state[name]
      return {
        toBeTruthy() {
          if (!value) fail(`expected state.${name} to be truthy, got ${JSON.stringify(value)}`)
        },
        toEqual(expected: unknown) {
          if (JSON.stringify(value) !== JSON.stringify(expected)) {
            fail(`expected state.${name} = ${JSON.stringify(expected)}, got ${JSON.stringify(value)}`)
          }
        },
      }
    },
  }
}
