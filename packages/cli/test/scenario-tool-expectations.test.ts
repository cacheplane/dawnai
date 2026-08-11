import type {
  ScenarioToolCallExpectationDescriptor,
  ScenarioToolCallRecord,
} from "@dawn-ai/sdk/testing"
import { describe, expect, it } from "vitest"
import { evaluateScenarioToolExpectations } from "../src/lib/runtime/scenario-tool-expectations.js"

describe("evaluateScenarioToolExpectations", () => {
  it("matches recursive object subsets without overflowing", () => {
    const expected: Record<string, unknown> = { tenant: "acme" }
    expected.self = expected
    const actual: Record<string, unknown> = { extra: true, tenant: "acme" }
    actual.self = actual

    expect(evaluate(expected, actual)).toBeNull()
  })

  it("matches cyclic arrays exactly without overflowing", () => {
    const expected: unknown[] = []
    expected.push(expected)
    const actual: unknown[] = []
    actual.push(actual)

    expect(evaluate(expected, actual)).toBeNull()
  })

  it("compares repeated values as pairs instead of treating either side as globally seen", () => {
    const expectedNode: Record<string, unknown> = {}
    expectedNode.self = expectedNode
    const expected = { left: expectedNode, right: expectedNode }

    const matchingActualNode: Record<string, unknown> = {}
    matchingActualNode.self = matchingActualNode
    const mismatchingActualNode = { self: null }
    const actual = { left: matchingActualNode, right: mismatchingActualNode }

    expect(evaluate(expected, actual)).toContain("arguments to match")
  })

  it("does not reuse subset pairs for exact object matching inside arrays", () => {
    const expectedNode = { tenant: "acme" }
    const actualNode = { extra: true, tenant: "acme" }

    expect(
      evaluate(
        { direct: expectedNode, values: [expectedNode] },
        { direct: actualNode, values: [actualNode] },
      ),
    ).toContain("arguments to match")
  })

  it("formats cyclic mismatches with a stable circular marker", () => {
    const expected: Record<string, unknown> = {}
    expected.self = expected
    expected.kind = "expected"
    const actual: Record<string, unknown> = {}
    actual.self = actual
    actual.kind = "actual"

    expect(evaluate(expected, actual)).toBe(
      'Expected tool "lookup" arguments to match {"kind":"expected","self":[Circular]} but observed [{"kind":"actual","self":[Circular]}]',
    )
  })
})

function evaluate(expected: unknown, actual: unknown): string | null {
  const expectations: readonly ScenarioToolCallExpectationDescriptor[] = [
    {
      argumentMatchers: [expected],
      name: "lookup",
    },
  ]
  const calls: readonly ScenarioToolCallRecord[] = [
    {
      args: actual,
      name: "lookup",
      sequence: 0,
    },
  ]

  return evaluateScenarioToolExpectations(expectations, calls)
}
