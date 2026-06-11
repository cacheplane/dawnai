import { AssertionError } from "node:assert"
import type {
  AgentRunResult,
  InterruptInfo,
  SubagentEvent,
  SubagentRun,
  Todo,
} from "./run-result.js"

export type { InterruptInfo, SubagentEvent, SubagentRun, Todo }

function fail(message: string): never {
  throw new AssertionError({ message })
}

function isSubsequence(actual: readonly string[], wanted: readonly string[]): boolean {
  let i = 0
  for (const a of actual) if (i < wanted.length && a === wanted[i]) i++
  return i === wanted.length
}

function containsContiguous(actual: readonly string[], wanted: readonly string[]): boolean {
  if (wanted.length === 0) return true
  for (let s = 0; s + wanted.length <= actual.length; s++) {
    let ok = true
    for (let j = 0; j < wanted.length; j++) {
      if (actual[s + j] !== wanted[j]) {
        ok = false
        break
      }
    }
    if (ok) return true
  }
  return false
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

/**
 * Assert the named tools were called IN ORDER. By default a subsequence (other
 * tool calls may appear between them); `{ strict: true }` requires them to be
 * contiguous.
 */
export function expectToolSequence(
  run: AgentRunResult,
  names: readonly string[],
  opts?: { readonly strict?: boolean },
): void {
  const actual = run.toolCalls.map((c) => c.name)
  const ok = opts?.strict ? containsContiguous(actual, names) : isSubsequence(actual, names)
  if (!ok) {
    const missing = names.filter((n) => !actual.includes(n))
    fail(
      `expected tool sequence ${names.join(" → ")}${opts?.strict ? " (contiguous)" : ""}; ` +
        `got ${actual.join(" → ") || "(none)"}` +
        (missing.length ? ` (missing: ${missing.join(", ")})` : ""),
    )
  }
}

export function expectFinalMessage(run: AgentRunResult) {
  return {
    toContain(s: string) {
      if (!run.finalMessage.includes(s))
        fail(
          `final message ${JSON.stringify(run.finalMessage)} does not contain ${JSON.stringify(s)}`,
        )
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

/**
 * Resolve a message object to the `content` string, handling both the
 * JSON-serialized AP shape (`{ id: [...], kwargs: { content } }`) and the
 * raw LangChain BaseMessage instance shape (`{ lc_id: [...], content }`).
 */
function resolveMessageContent(m: Record<string, unknown>): string | undefined {
  // JSON-serialized AP shape: { id: ["langchain_core","messages","ToolMessage"], kwargs: { content } }
  const kwContent = (m as { kwargs?: { content?: string } }).kwargs?.content
  if (typeof kwContent === "string") return kwContent
  // Raw BaseMessage instance shape: { lc_id: [...], content }
  const rawContent = (m as { content?: unknown }).content
  if (typeof rawContent === "string") return rawContent
  return undefined
}

/**
 * Return true if `m` is a ToolMessage for the given tool name, regardless
 * of whether the message is a raw LangChain BaseMessage instance or its
 * JSON-serialized form (as produced by the AP endpoint).
 */
function isToolMessage(m: Record<string, unknown>, toolName: string): boolean {
  // JSON-serialized AP shape
  const id = (m as { id?: string[] }).id
  const kw = (m as { kwargs?: { name?: string } }).kwargs
  if (Array.isArray(id) && id[2] === "ToolMessage" && kw?.name === toolName) return true
  // Raw BaseMessage instance shape (in-process Layer A harness)
  const lcId = (m as { lc_id?: string[] }).lc_id
  const msgName = (m as { name?: string }).name
  if (Array.isArray(lcId) && lcId[2] === "ToolMessage" && msgName === toolName) return true
  return false
}

export function expectOffloaded(run: AgentRunResult, toolName: string): void {
  const msg = run.messages.find((m) => isToolMessage(m, toolName))
  const content = (msg ? resolveMessageContent(msg) : undefined) ?? ""
  if (!content.includes("Tool output offloaded")) {
    fail(
      `expected "${toolName}" output to be offloaded (stub marker), got: ${content.slice(0, 120)}`,
    )
  }
}

export function expectInterrupt(run: AgentRunResult) {
  if (run.interrupts.length === 0) {
    fail("expected at least one interrupt, but none were captured")
  }
  const chain = {
    ofKind(kind: string) {
      if (!run.interrupts.some((i) => i.kind === kind)) {
        fail(
          `expected an interrupt of kind "${kind}"; got: ${run.interrupts.map((i) => i.kind).join(", ") || "(none)"}`,
        )
      }
      return chain
    },
    withDetail(partial: Record<string, unknown>) {
      const found = run.interrupts.some(
        (i) => i.detail !== undefined && isSubset(partial, i.detail),
      )
      if (!found) {
        fail(
          `expected an interrupt with detail >= ${JSON.stringify(partial)}; got: ${JSON.stringify(run.interrupts.map((i) => i.detail))}`,
        )
      }
      return chain
    },
  }
  return chain
}

export function expectNoInterrupt(run: AgentRunResult): void {
  if (run.interrupts.length > 0) {
    fail(
      `expected no interrupts, but got ${run.interrupts.length}: ${run.interrupts.map((i) => i.kind).join(", ")}`,
    )
  }
}

export function expectSubagent(run: AgentRunResult, name: string) {
  const sub = run.subagents.find((s) => s.name === name)
  const chain = {
    called() {
      if (!sub) {
        fail(
          `expected subagent "${name}" to be dispatched; subagents: ${run.subagents.map((s) => s.name).join(", ") || "(none)"}`,
        )
      }
      return chain
    },
    calledTool(toolName: string) {
      if (!sub) {
        fail(`expected subagent "${name}" to be dispatched (it was not)`)
      } else if (!sub.toolCalls.some((t) => t.name === toolName)) {
        fail(
          `expected subagent "${name}" to call tool "${toolName}"; called: ${sub.toolCalls.map((t) => t.name).join(", ") || "(none)"}`,
        )
      }
      return chain
    },
    finalMessageContains(text: string) {
      if (!sub) {
        fail(`expected subagent "${name}" to be dispatched (it was not)`)
      } else if (!(sub.finalMessage ?? "").includes(text)) {
        fail(
          `expected subagent "${name}" finalMessage to contain "${text}"; got: ${JSON.stringify(sub?.finalMessage)}`,
        )
      }
      return chain
    },
  }
  return chain
}

export function expectPlan(run: AgentRunResult) {
  return {
    toHaveLength(n: number) {
      if (run.todos.length !== n) fail(`expected ${n} todos, got ${run.todos.length}`)
    },
    toHaveTodo(content: string) {
      if (!run.todos.some((t) => t.content === content)) {
        fail(
          `expected a todo with content "${content}"; todos: ${run.todos.map((t) => t.content).join(", ") || "(none)"}`,
        )
      }
    },
    toHaveStatus(content: string, status: string) {
      const todo = run.todos.find((t) => t.content === content)
      if (!todo) {
        fail(
          `expected a todo with content "${content}"; todos: ${run.todos.map((t) => t.content).join(", ") || "(none)"}`,
        )
      }
      if (todo.status !== status) {
        fail(`expected todo "${content}" to have status "${status}", but got "${todo.status}"`)
      }
    },
  }
}

export function expectSystemPrompt(run: AgentRunResult) {
  return {
    toContain(text: string) {
      if (!run.systemPrompt.includes(text)) {
        fail(
          `expected systemPrompt to contain "${text}"; got: ${JSON.stringify(run.systemPrompt.slice(0, 120))}`,
        )
      }
    },
    toMatch(re: RegExp) {
      if (!re.test(run.systemPrompt))
        fail(
          `expected systemPrompt to match ${re}; got: ${JSON.stringify(run.systemPrompt.slice(0, 120))}`,
        )
    },
  }
}

/**
 * Assert no tool returned an error result. A HITL permission interrupt is NOT a
 * tool error — it produces no ToolMessage, so it never appears in toolResults.
 */
export function expectNoToolErrors(run: AgentRunResult): void {
  const errored = run.toolResults.filter((r) => r.isError)
  if (errored.length > 0) {
    const detail = errored
      .map((r) => {
        const first = typeof r.content === "string" ? (r.content.split("\n")[0] ?? "").slice(0, 140) : ""
        return `"${r.name}" returned an error: ${first}`
      })
      .join("; ")
    fail(`expected no tool errors; ${detail}`)
  }
}

export function expectState(run: AgentRunResult) {
  const messages = Array.isArray(run.state.messages) ? (run.state.messages as unknown[]) : []
  return {
    messages: {
      toHaveLength(n: number) {
        if (messages.length !== n)
          fail(`expected state.messages length ${n}, got ${messages.length}`)
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
            fail(
              `expected state.${name} = ${JSON.stringify(expected)}, got ${JSON.stringify(value)}`,
            )
          }
        },
      }
    },
  }
}
