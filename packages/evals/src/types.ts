import type { AgentRunResult, FixtureSet, ScriptBuilder } from "@dawn-ai/testing"

/** One dataset row. `input` is the user message for agent routes (v1). */
export interface EvalCase {
  readonly name?: string
  readonly input: unknown
  readonly expected?: unknown
  /** Per-case aimock fixtures for replay mode; ignored under --live. */
  readonly fixtures?: FixtureSet | ScriptBuilder
  readonly metadata?: Record<string, unknown>
}

/** Inline cases, a path to a committed .json/.jsonl, or a (sync/async) factory. */
export type Dataset =
  | readonly EvalCase[]
  | string
  | (() => EvalCase[] | Promise<EvalCase[]>)

/** A scorer may return a 0..1 number, a boolean, or a rich verdict. */
export type Score = number | boolean | { readonly score: number; readonly label?: string; readonly reason?: string }

export interface Scorer {
  readonly name: string
  /** This scorer's own pass bar (used by gate.perScorer and case-pass). */
  readonly threshold?: number
  readonly score: (run: AgentRunResult, testCase: EvalCase) => Score | Promise<Score>
}

export interface EvalDefinition {
  readonly name: string
  /** Route key like "/chat#agent"; defaults to the co-located route at load time. */
  readonly route?: string
  readonly dataset: Dataset
  readonly scorers: readonly Scorer[]
  /** Sugar for gate.mean(threshold). Ignored if `gate` is set. */
  readonly threshold?: number
  readonly gate?: GatePolicy
}

/** Normalized score for one (case, scorer) pair. */
export interface CaseScore {
  readonly scorer: string
  readonly score: number
  readonly label?: string
  readonly reason?: string
}

export interface CaseResult {
  readonly name: string
  readonly scores: readonly CaseScore[]
  readonly mean: number
  /** Every scorer met its bar (scorer.threshold ?? DEFAULT_CASE_BAR). */
  readonly passed: boolean
}

export interface ScorerAggregate {
  readonly scorer: string
  readonly mean: number
  readonly threshold?: number
}

/** Pre-gate report fed to gate policies. */
export interface ScoredReport {
  readonly name: string
  readonly cases: readonly CaseResult[]
  readonly byScorer: readonly ScorerAggregate[]
  readonly mean: number
}

export interface EvalReport extends ScoredReport {
  /** Whether a gate/threshold was configured (informational evals are false). */
  readonly gated: boolean
  readonly passed: boolean
  readonly reason?: string
}

export type GateResult = { readonly passed: boolean; readonly reason?: string }
export type GatePolicy = (report: ScoredReport) => GateResult

/** A case "passes" when every scorer ≥ its threshold, defaulting to this bar. */
export const DEFAULT_CASE_BAR = 0.5
