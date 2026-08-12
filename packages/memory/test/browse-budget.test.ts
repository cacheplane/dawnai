import { describe, expect, it } from "vitest"
import {
  checkBrowseBudgets,
  POSTGRES_BROWSE_BUDGETS_MS,
  percentileMs,
  SQLITE_BROWSE_BUDGETS_MS,
} from "../src/browse-budget.js"

describe("browse budget checker", () => {
  it("takes the p95 by nearest-rank, so a 20-sample run reports the 19th", () => {
    const samples = Array.from({ length: 20 }, (_, index) => index + 1)
    expect(percentileMs(samples, 0.95)).toBe(19)
    expect(percentileMs([], 0.95)).toBe(Number.NaN)
    expect(percentileMs([5], 0.95)).toBe(5)
  })

  it("passes when every measured p95 is under its ceiling", () => {
    const report = checkBrowseBudgets(
      {
        "windowed-fetch": [1, 1, 2],
        "filtered-count": [4, 5, 6],
        "head-refresh": [10, 11, 12],
        "non-default-sort": [12, 13, 14],
        "content-contains": [40, 44, 46],
      },
      SQLITE_BROWSE_BUDGETS_MS,
    )
    expect(report.ok).toBe(true)
    expect(report.rows.every((row) => row.status === "pass")).toBe(true)
  })

  it("fails the whole report when one shape is over", () => {
    const report = checkBrowseBudgets({ "windowed-fetch": [50, 60, 70] }, SQLITE_BROWSE_BUDGETS_MS)
    expect(report.ok).toBe(false)
    expect(report.rows[0]?.status).toBe("fail")
    expect(report.rows[0]?.budgetMs).toBe(10)
  })

  it("marks a shape with no approved ceiling UNBUDGETED rather than passing it", () => {
    // Design §11 approves only two Postgres numbers. Reporting the other three as
    // "pass" would manufacture approval nobody gave.
    const report = checkBrowseBudgets({ "content-contains": [900] }, POSTGRES_BROWSE_BUDGETS_MS)
    expect(report.rows[0]?.status).toBe("unbudgeted")
    expect(report.ok).toBe(true)
  })
})
