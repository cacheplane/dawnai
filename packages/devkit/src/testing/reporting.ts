import type { HarnessRunResult } from "./result-types.js"

export function renderJsonSummary(result: HarnessRunResult): string {
  return JSON.stringify(result, null, 2)
}

export function renderTextSummary(result: HarnessRunResult): string {
  const lines = [
    `run: ${result.runId}`,
    `status: ${result.status}`,
    `started: ${result.startedAt}`,
    `finished: ${result.finishedAt}`,
    `requested lanes: ${result.requestedLanes.join(", ")}`,
    `executed lanes: ${result.executedLanes.join(", ")}`,
    formatCounts(result),
    `artifact root: ${result.artifactRoot}`,
  ]

  for (const laneResult of result.results) {
    lines.push(
      `[${laneResult.lane}] ${laneResult.name}: ${laneResult.status} (${laneResult.durationMs}ms)`,
    )

    if (laneResult.failureReason) {
      lines.push(`failure: ${laneResult.failureReason}`)
    }

    lines.push(`transcript: ${laneResult.transcriptPath}`)

    if (laneResult.artifacts.length > 0) {
      lines.push(`artifacts: ${laneResult.artifacts.join(", ")}`)
    }
  }

  return lines.join("\n")
}

function formatCounts(result: HarnessRunResult): string {
  const { counts } = result
  return `passed=${counts.passed} failed=${counts.failed} skipped=${counts.skipped} errored=${counts.errored}`
}
