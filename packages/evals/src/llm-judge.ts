import type { AgentRunResult } from "@dawn-ai/testing"
import type { EvalCase, Scorer } from "./types.js"

type FetchImpl = (input: string, init: RequestInit) => Promise<Response>

export interface LlmJudgeOptions {
  /** Criteria template; supports {{input}}, {{expected}}, {{output}} interpolation. */
  readonly criteria: string
  readonly model?: string
  readonly threshold?: number
  readonly name?: string
  /** Overrides for testing; default to env + global fetch. */
  readonly baseUrl?: string
  readonly apiKey?: string
  readonly fetchImpl?: FetchImpl
}

function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_m, key: string) => vars[key] ?? "")
}

export function llmJudge(opts: LlmJudgeOptions): Scorer {
  const model = opts.model ?? "gpt-5-mini"
  return {
    name: opts.name ?? "llmJudge",
    ...(opts.threshold !== undefined ? { threshold: opts.threshold } : {}),
    score: async (run: AgentRunResult, testCase: EvalCase) => {
      const baseUrl = opts.baseUrl ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1"
      const apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY ?? ""
      const fetchImpl: FetchImpl = opts.fetchImpl ?? ((i, init) => fetch(i, init))
      const criteria = interpolate(opts.criteria, {
        input: String(testCase.input ?? ""),
        expected: JSON.stringify(testCase.expected ?? ""),
        output: run.finalMessage,
      })
      const user = [
        `Criteria: ${criteria}`,
        `Agent output: ${run.finalMessage}`,
        `Respond ONLY with JSON: {"score": <0..1>, "reason": "<short>"}.`,
      ].join("\n")
      let content: string
      try {
        const res = await fetchImpl(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model,
            messages: [
              {
                role: "system",
                content: "You are a strict grader. Output only the requested JSON.",
              },
              { role: "user", content: user },
            ],
          }),
        })
        const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
        content = json.choices?.[0]?.message?.content ?? ""
      } catch (err) {
        return {
          score: 0,
          reason: `judge request failed: ${err instanceof Error ? err.message : String(err)}`,
        }
      }
      try {
        const parsed = JSON.parse(content) as { score: number; reason?: string }
        return { score: parsed.score, reason: parsed.reason ?? "" }
      } catch {
        return { score: 0, reason: `could not parse judge verdict: ${content.slice(0, 120)}` }
      }
    },
  }
}
