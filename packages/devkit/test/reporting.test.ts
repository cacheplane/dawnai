import { describe, expect, it } from "vitest"

import {
  type HarnessLaneResult,
  type HarnessRunResult,
  renderJsonSummary,
  renderTextSummary,
} from "../src/index.ts"

describe("harness reporting", () => {
  it("renders text and JSON summaries from the normalized run contract", () => {
    const runResult: HarnessRunResult = {
      artifactRoot: "/tmp/dawn-testing/run-001",
      counts: {
        errored: 0,
        failed: 1,
        passed: 1,
        skipped: 0,
      },
      executedLanes: ["contract", "generated"],
      finishedAt: "2026-04-11T12:00:03.000Z",
      requestedLanes: ["contract", "generated"],
      results: [
        {
          artifacts: ["/tmp/dawn-testing/run-001/contract/manifest.json"],
          durationMs: 125,
          failureReason: null,
          lane: "contract",
          name: "valid-basic",
          phases: [
            {
              durationMs: 125,
              name: "manifest",
              status: "passed",
            },
          ],
          status: "passed",
          transcriptPath: "/tmp/dawn-testing/run-001/contract/transcript.log",
        },
        {
          artifacts: ["/tmp/dawn-testing/run-001/generated/build.log"],
          durationMs: 275,
          failureReason: "typecheck failed",
          lane: "generated",
          name: "basic",
          phases: [
            {
              durationMs: 100,
              name: "scaffold",
              status: "passed",
            },
            {
              durationMs: 175,
              name: "typecheck",
              status: "failed",
            },
          ],
          status: "failed",
          transcriptPath: "/tmp/dawn-testing/run-001/generated/transcript.log",
        },
      ] satisfies HarnessLaneResult[],
      runId: "run-001",
      startedAt: "2026-04-11T12:00:00.000Z",
      status: "failed",
    }

    const jsonSummary = renderJsonSummary(runResult)
    const textSummary = renderTextSummary(runResult)

    expect(JSON.parse(jsonSummary)).toEqual(runResult)
    expect(textSummary).toContain("run-001")
    expect(textSummary).toContain("status: failed")
    expect(textSummary).toContain("passed=1 failed=1 skipped=0 errored=0")
    expect(textSummary).toContain("[contract] valid-basic: passed (125ms)")
    expect(textSummary).toContain("[generated] basic: failed (275ms)")
    expect(textSummary).toContain("failure: typecheck failed")
    expect(textSummary).toContain("transcript: /tmp/dawn-testing/run-001/generated/transcript.log")
  })
})
