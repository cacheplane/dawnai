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
