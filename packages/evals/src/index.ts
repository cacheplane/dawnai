export { defineEval } from "./define-eval.js"
export { gate, resolveGate } from "./gate.js"
export { type LlmJudgeOptions, llmJudge } from "./llm-judge.js"
export { resolveDataset } from "./resolve-dataset.js"
export { type RunEvalOptions, runEval } from "./run-eval.js"
export { type NormalizedScore, normalizeScore } from "./score.js"
export {
  contains,
  custom,
  exactMatch,
  jsonEquals,
  memoryFresh,
  memoryIsolated,
  memoryRecalled,
  regex,
  tokensUnder,
  toolCalled,
} from "./scorers.js"
export type {
  CaseResult,
  CaseScore,
  Dataset,
  EvalCase,
  EvalDefinition,
  EvalReport,
  GatePolicy,
  GateResult,
  Score,
  ScoredReport,
  Scorer,
  ScorerAggregate,
} from "./types.js"
