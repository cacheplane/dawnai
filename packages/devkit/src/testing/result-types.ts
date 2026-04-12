export type HarnessStatus = "passed" | "failed" | "skipped" | "errored"

export interface HarnessCounts {
  readonly errored: number
  readonly failed: number
  readonly passed: number
  readonly skipped: number
}

export interface HarnessPhaseResult {
  readonly durationMs: number
  readonly name: string
  readonly status: HarnessStatus
}

export interface HarnessLaneResult {
  readonly artifacts: readonly string[]
  readonly durationMs: number
  readonly failureReason: string | null
  readonly lane: string
  readonly name: string
  readonly phases: readonly HarnessPhaseResult[]
  readonly status: HarnessStatus
  readonly transcriptPath: string
}

export interface HarnessRunResult {
  readonly artifactRoot: string
  readonly counts: HarnessCounts
  readonly executedLanes: readonly string[]
  readonly finishedAt: string
  readonly requestedLanes: readonly string[]
  readonly results: readonly HarnessLaneResult[]
  readonly runId: string
  readonly startedAt: string
  readonly status: HarnessStatus
}
