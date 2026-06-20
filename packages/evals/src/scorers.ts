import type { AgentRunResult } from "@dawn-ai/testing"
import type { EvalCase, Score, Scorer } from "./types.js"

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** finalMessage === case.expected (string compare). */
export function exactMatch(opts?: { threshold?: number }): Scorer {
  return {
    name: "exactMatch",
    ...(opts?.threshold !== undefined ? { threshold: opts.threshold } : {}),
    score: (run, c) => (run.finalMessage === String(c.expected ?? "") ? 1 : 0),
  }
}

export function contains(substring: string, opts?: { threshold?: number }): Scorer {
  return {
    name: `contains(${substring})`,
    ...(opts?.threshold !== undefined ? { threshold: opts.threshold } : {}),
    score: (run) => (run.finalMessage.includes(substring) ? 1 : 0),
  }
}

export function regex(re: RegExp, opts?: { threshold?: number }): Scorer {
  return {
    name: `regex(${re.source})`,
    ...(opts?.threshold !== undefined ? { threshold: opts.threshold } : {}),
    score: (run) => (re.test(run.finalMessage) ? 1 : 0),
  }
}

/** Deep-equals case.expected against parsed finalMessage (default) or a selector. */
export function jsonEquals(opts?: {
  threshold?: number
  select?: (run: AgentRunResult) => unknown
}): Scorer {
  return {
    name: "jsonEquals",
    ...(opts?.threshold !== undefined ? { threshold: opts.threshold } : {}),
    score: (run, c) => {
      let actual: unknown
      if (opts?.select) {
        actual = opts.select(run)
      } else {
        try {
          actual = JSON.parse(run.finalMessage)
        } catch {
          return 0
        }
      }
      return deepEqual(actual, c.expected) ? 1 : 0
    },
  }
}

export function toolCalled(
  name: string,
  opts?: { withArgs?: Record<string, unknown>; threshold?: number },
): Scorer {
  return {
    name: `toolCalled(${name})`,
    ...(opts?.threshold !== undefined ? { threshold: opts.threshold } : {}),
    score: (run) => {
      const calls = run.toolCalls.filter((t) => t.name === name)
      if (calls.length === 0) return 0
      if (!opts?.withArgs) return 1
      const want = opts.withArgs
      const hit = calls.some((call) => {
        const args = (call.args ?? {}) as Record<string, unknown>
        return Object.entries(want).every(([k, v]) => deepEqual(args[k], v))
      })
      return hit ? 1 : 0
    },
  }
}

export function tokensUnder(budget: number, opts?: { threshold?: number }): Scorer {
  return {
    name: `tokensUnder(${budget})`,
    ...(opts?.threshold !== undefined ? { threshold: opts.threshold } : {}),
    score: (run) => (run.tokens.length < budget ? 1 : 0),
  }
}

export function custom(
  fn: (run: AgentRunResult, testCase: EvalCase) => Score | Promise<Score>,
  opts?: { name?: string; threshold?: number },
): Scorer {
  return {
    name: opts?.name ?? "custom",
    ...(opts?.threshold !== undefined ? { threshold: opts.threshold } : {}),
    score: fn,
  }
}

// ---------------------------------------------------------------------------
// Memory scorers
// ---------------------------------------------------------------------------

/** Returns the string content of all tool results whose name matches `toolName`. */
function recallOutputs(run: AgentRunResult, toolName: string): string[] {
  return run.toolResults
    .filter((r) => r.name === toolName)
    .map((r) => (typeof r.content === "string" ? r.content : JSON.stringify(r.content)))
}

/**
 * Score 1 if every id in `expectedIds` appears in at least one `recall` tool
 * result string; score 0 with a reason listing missing ids.
 */
export function memoryRecalled(expectedIds: string[], opts?: { threshold?: number }): Scorer {
  return {
    name: `memoryRecalled(${expectedIds.join(",")})`,
    ...(opts?.threshold !== undefined ? { threshold: opts.threshold } : {}),
    score: (run) => {
      const outputs = recallOutputs(run, "recall")
      const combined = outputs.join("\n")
      const missing = expectedIds.filter((id) => !combined.includes(id))
      if (missing.length === 0) return 1
      return { score: 0, reason: `Missing memory ids: ${missing.join(", ")}` }
    },
  }
}

/**
 * Score 1 if `run.finalMessage` contains `expectedValue` (freshness check —
 * the newer value surfaced in the response); else 0.
 */
export function memoryFresh(expectedValue: string, opts?: { threshold?: number }): Scorer {
  return {
    name: `memoryFresh(${expectedValue})`,
    ...(opts?.threshold !== undefined ? { threshold: opts.threshold } : {}),
    score: (run) =>
      run.finalMessage.includes(expectedValue)
        ? 1
        : { score: 0, reason: `Expected "${expectedValue}" in finalMessage` },
  }
}

/**
 * Score 1 if `forbidden` does NOT appear in any recall tool output or
 * finalMessage (no cross-namespace leak); score 0 if it leaks.
 */
export function memoryIsolated(forbidden: string, opts?: { threshold?: number }): Scorer {
  return {
    name: `memoryIsolated(${forbidden})`,
    ...(opts?.threshold !== undefined ? { threshold: opts.threshold } : {}),
    score: (run) => {
      const outputs = recallOutputs(run, "recall")
      const leaksInRecall = outputs.some((o) => o.includes(forbidden))
      const leaksInMessage = run.finalMessage.includes(forbidden)
      if (leaksInRecall || leaksInMessage) {
        return { score: 0, reason: `Cross-namespace leak: "${forbidden}" found in output` }
      }
      return 1
    },
  }
}
