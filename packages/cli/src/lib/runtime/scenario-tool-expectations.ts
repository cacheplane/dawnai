import type {
  ScenarioToolCallExpectationDescriptor,
  ScenarioToolCallRecord,
} from "@dawn-ai/sdk/testing"

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
  if (Array.isArray(expected)) {
    return arraysEqual(expected, actual)
  }

  if (isObject(expected)) {
    if (!isObject(actual)) {
      return false
    }

    return Object.entries(expected).every(
      ([key, value]) => Object.hasOwn(actual, key) && matchesSubset(value, actual[key]),
    )
  }

  return Object.is(expected, actual)
}

function arraysEqual(expected: readonly unknown[], actual: unknown): boolean {
  if (!Array.isArray(actual) || actual.length !== expected.length) {
    return false
  }

  for (let index = 0; index < expected.length; index += 1) {
    if (Object.hasOwn(expected, index) !== Object.hasOwn(actual, index)) {
      return false
    }

    if (Object.hasOwn(expected, index) && !valuesEqual(expected[index], actual[index])) {
      return false
    }
  }

  return true
}

function valuesEqual(expected: unknown, actual: unknown): boolean {
  if (Array.isArray(expected)) {
    return arraysEqual(expected, actual)
  }

  if (isObject(expected)) {
    if (!isObject(actual)) {
      return false
    }

    const expectedKeys = Object.keys(expected)

    if (expectedKeys.length !== Object.keys(actual).length) {
      return false
    }

    return expectedKeys.every(
      (key) => Object.hasOwn(actual, key) && valuesEqual(expected[key], actual[key]),
    )
  }

  return Object.is(expected, actual)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function formatValue(value: unknown): string {
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
    const entries: string[] = []

    for (let index = 0; index < value.length; index += 1) {
      entries.push(Object.hasOwn(value, index) ? formatValue(value[index]) : "<empty>")
    }

    return `[${entries.join(",")}]`
  }

  const objectValue = value as Record<string, unknown>

  return `{${Object.keys(objectValue)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${formatValue(objectValue[key])}`)
    .join(",")}}`
}
