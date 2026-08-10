import type {
  ScenarioToolCallExpectationDescriptor,
  ScenarioToolCallRecord,
} from "@dawn-ai/sdk/testing"

type ComparisonMode = "exact" | "subset"
type ComparedPairs = WeakMap<object, WeakSet<object>>

interface ComparisonState {
  readonly exact: ComparedPairs
  readonly subset: ComparedPairs
}

export function evaluateScenarioToolExpectations(
  expectations: readonly ScenarioToolCallExpectationDescriptor[],
  calls: readonly ScenarioToolCallRecord[],
): string | null {
  for (const expectation of expectations) {
    const matchingCalls = calls.filter((call) => call.name === expectation.name)
    const countMismatch = evaluateCount(expectation, matchingCalls.length)

    if (countMismatch) {
      return countMismatch
    }

    for (const expectedArgs of expectation.argumentMatchers) {
      if (matchingCalls.some((call) => matchesSubset(expectedArgs, call.args))) {
        continue
      }

      return `Expected tool ${formatValue(expectation.name)} arguments to match ${formatValue(expectedArgs)} but observed ${formatValue(matchingCalls.map((call) => call.args))}`
    }
  }

  return null
}

function evaluateCount(
  expectation: ScenarioToolCallExpectationDescriptor,
  actualCount: number,
): string | null {
  if (!expectation.count) {
    return null
  }

  if (expectation.count.kind === "exact" && actualCount !== expectation.count.value) {
    return `Expected tool ${formatValue(expectation.name)} call count to equal ${expectation.count.value} but received ${actualCount}`
  }

  if (expectation.count.kind === "at-least" && actualCount < expectation.count.value) {
    return `Expected tool ${formatValue(expectation.name)} call count to be at least ${expectation.count.value} but received ${actualCount}`
  }

  return null
}

function matchesSubset(expected: unknown, actual: unknown): boolean {
  return valuesMatch(expected, actual, "subset", {
    exact: new WeakMap(),
    subset: new WeakMap(),
  })
}

function valuesMatch(
  expected: unknown,
  actual: unknown,
  mode: ComparisonMode,
  state: ComparisonState,
): boolean {
  if (Array.isArray(expected)) {
    return arraysEqual(expected, actual, state)
  }

  if (isObject(expected)) {
    return objectsMatch(expected, actual, mode, state)
  }

  return Object.is(expected, actual)
}

function arraysEqual(
  expected: readonly unknown[],
  actual: unknown,
  state: ComparisonState,
): boolean {
  if (!Array.isArray(actual) || actual.length !== expected.length) {
    return false
  }

  if (markComparedPair(state.exact, expected, actual)) {
    return true
  }

  for (let index = 0; index < expected.length; index += 1) {
    if (Object.hasOwn(expected, index) !== Object.hasOwn(actual, index)) {
      return false
    }

    if (
      Object.hasOwn(expected, index) &&
      !valuesMatch(expected[index], actual[index], "exact", state)
    ) {
      return false
    }
  }

  return true
}

function objectsMatch(
  expected: Record<string, unknown>,
  actual: unknown,
  mode: ComparisonMode,
  state: ComparisonState,
): boolean {
  if (!isObject(actual)) {
    return false
  }

  const expectedKeys = Object.keys(expected)

  if (mode === "exact" && expectedKeys.length !== Object.keys(actual).length) {
    return false
  }

  for (const key of expectedKeys) {
    if (!Object.hasOwn(actual, key)) {
      return false
    }
  }

  if (markComparedPair(state[mode], expected, actual)) {
    return true
  }

  return expectedKeys.every((key) => valuesMatch(expected[key], actual[key], mode, state))
}

function markComparedPair(pairs: ComparedPairs, expected: object, actual: object): boolean {
  const actualValues = pairs.get(expected)

  if (actualValues?.has(actual)) {
    return true
  }

  if (actualValues) {
    actualValues.add(actual)
  } else {
    pairs.set(expected, new WeakSet([actual]))
  }

  return false
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function formatValue(value: unknown, ancestors: WeakSet<object> = new WeakSet()): string {
  if (value === null) {
    return "null"
  }

  if (typeof value === "string") {
    return JSON.stringify(value)
  }

  if (typeof value === "number") {
    if (Number.isNaN(value)) return "NaN"
    if (Object.is(value, -0)) return "-0"
    return String(value)
  }

  if (typeof value === "bigint") {
    return `${value}n`
  }

  if (typeof value === "boolean" || typeof value === "undefined") {
    return String(value)
  }

  if (typeof value === "symbol") {
    return String(value)
  }

  if (typeof value === "function") {
    return `[Function ${value.name || "anonymous"}]`
  }

  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      return "[Circular]"
    }

    ancestors.add(value)
    const entries: string[] = []

    try {
      for (let index = 0; index < value.length; index += 1) {
        entries.push(Object.hasOwn(value, index) ? formatValue(value[index], ancestors) : "<empty>")
      }
    } finally {
      ancestors.delete(value)
    }

    return `[${entries.join(",")}]`
  }

  const objectValue = value as Record<string, unknown>

  if (ancestors.has(objectValue)) {
    return "[Circular]"
  }

  ancestors.add(objectValue)

  try {
    return `{${Object.keys(objectValue)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${formatValue(objectValue[key], ancestors)}`)
      .join(",")}}`
  } finally {
    ancestors.delete(objectValue)
  }
}
