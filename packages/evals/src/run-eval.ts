import type { AgentRunResult } from "@dawn-ai/testing"
import { resolveGate } from "./gate.js"
import { resolveDataset } from "./resolve-dataset.js"
import { type NormalizedScore, normalizeScore } from "./score.js"
import {
  type CaseResult,
  type CaseScore,
  DEFAULT_CASE_BAR,
  type EvalCase,
  type EvalDefinition,
  type EvalReport,
  type ScorerAggregate,
} from "./types.js"

export interface RunEvalOptions {
  /** Executes one case and returns its run result (replay or live; injected by the CLI). */
  readonly runCase: (testCase: EvalCase) => Promise<AgentRunResult>
  /** Base dir for resolving a string dataset path (the eval file's directory). */
  readonly baseDir?: string
}

function mean(nums: readonly number[]): number {
  return nums.length === 0 ? 0 : nums.reduce((a, b) => a + b, 0) / nums.length
}

export async function runEval(def: EvalDefinition, options: RunEvalOptions): Promise<EvalReport> {
  const cases = await resolveDataset(def.dataset, options.baseDir ?? process.cwd())
  const thresholdOf = new Map(def.scorers.map((s) => [s.name, s.threshold]))

  const caseResults: CaseResult[] = []
  for (const [index, testCase] of cases.entries()) {
    const run = await options.runCase(testCase)
    const scores: CaseScore[] = []
    for (const scorer of def.scorers) {
      let normalized: NormalizedScore
      try {
        normalized = normalizeScore(await scorer.score(run, testCase))
      } catch (err) {
        normalized = { score: 0, reason: err instanceof Error ? err.message : String(err) }
      }
      scores.push({
        scorer: scorer.name,
        score: normalized.score,
        ...(normalized.label !== undefined ? { label: normalized.label } : {}),
        ...(normalized.reason !== undefined ? { reason: normalized.reason } : {}),
      })
    }
    const passed = scores.every((s) => s.score >= (thresholdOf.get(s.scorer) ?? DEFAULT_CASE_BAR))
    caseResults.push({
      name: testCase.name ?? `case ${index + 1}`,
      scores,
      mean: mean(scores.map((s) => s.score)),
      passed,
    })
  }

  const byScorer: ScorerAggregate[] = def.scorers.map((scorer) => {
    const scorerScores = caseResults.flatMap((c) =>
      c.scores.filter((s) => s.scorer === scorer.name).map((s) => s.score),
    )
    return {
      scorer: scorer.name,
      mean: mean(scorerScores),
      ...(scorer.threshold !== undefined ? { threshold: scorer.threshold } : {}),
    }
  })

  const overallMean = mean(caseResults.flatMap((c) => c.scores.map((s) => s.score)))
  const scored = { name: def.name, cases: caseResults, byScorer, mean: overallMean }
  const gated = def.gate !== undefined || def.threshold !== undefined
  const result = resolveGate(def)(scored)

  return {
    ...scored,
    gated,
    passed: result.passed,
    ...(result.reason !== undefined ? { reason: result.reason } : {}),
  }
}
