import type { RuntimeExecutionResult } from "./result.js"

export interface RuntimeMetaExpectation {
  readonly executionSource?: "in-process" | "server"
  readonly mode?: "graph" | "workflow" | null
  readonly routeId?: string | null
  readonly routePath?: string | null
}

export interface RuntimeErrorExpectation {
  readonly kind?: string
  readonly message?: string | { readonly includes: string }
}

export function expectOutput(result: RuntimeExecutionResult, expected: unknown): void {
  if (result.status !== "passed") {
    throw new Error(
      `Expected status passed before asserting output but received failed: ${result.error.message}`,
    )
  }

  const mismatch = findValueMismatch(expected, result.output, "output")

  if (mismatch) {
    throw new Error(mismatch)
  }
}

export function expectError(
  result: RuntimeExecutionResult,
  expected: RuntimeErrorExpectation,
): void {
  if (result.status !== "failed") {
    throw new Error("Expected status failed before asserting error but received passed")
  }

  if (expected.kind && result.error.kind !== expected.kind) {
    throw new Error(`Expected error.kind ${expected.kind} but received ${result.error.kind}`)
  }

  if (typeof expected.message === "string" && result.error.message !== expected.message) {
    throw new Error(
      `Expected error.message ${formatValue(expected.message)} but received ${formatValue(result.error.message)}`,
    )
  }

  if (
    isIncludesMatcher(expected.message) &&
    !result.error.message.includes(expected.message.includes)
  ) {
    throw new Error(
      `Expected error.message to include ${formatValue(expected.message.includes)} but received ${formatValue(result.error.message)}`,
    )
  }
}

export function expectMeta(result: RuntimeExecutionResult, expected: RuntimeMetaExpectation): void {
  const mismatch = findValueMismatch(
    expected,
    {
      executionSource: result.executionSource,
      mode: result.mode,
      routeId: result.routeId,
      routePath: result.routePath,
    },
    "meta",
  )

  if (mismatch) {
    throw new Error(mismatch)
  }
}

function findValueMismatch(expected: unknown, actual: unknown, path: string): string | null {
  if (Array.isArray(expected)) {
    return arraysEqual(expected, actual)
      ? null
      : `Expected ${path} to equal ${formatValue(expected)} but received ${formatValue(actual)}`
  }

  if (isPlainObject(expected)) {
    if (!isPlainObject(actual)) {
      return `Expected ${path} to equal ${formatValue(expected)} but received ${formatValue(actual)}`
    }

    for (const [key, expectedValue] of Object.entries(expected)) {
      const nextPath = `${path}.${key}`

      if (!Object.hasOwn(actual, key)) {
        return `Expected ${nextPath} to equal ${formatValue(expectedValue)} but received undefined`
      }

      const mismatch = findValueMismatch(expectedValue, actual[key], nextPath)

      if (mismatch) {
        return mismatch
      }
    }

    return null
  }

  return Object.is(actual, expected)
    ? null
    : `Expected ${path} to equal ${formatValue(expected)} but received ${formatValue(actual)}`
}

function arraysEqual(expected: readonly unknown[], actual: unknown): boolean {
  if (!Array.isArray(actual) || actual.length !== expected.length) {
    return false
  }

  return expected.every((value, index) => deepEqual(value, actual[index]))
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Array.isArray(left)) {
    return arraysEqual(left, right)
  }

  if (isPlainObject(left)) {
    if (!isPlainObject(right)) {
      return false
    }

    const leftEntries = Object.entries(left)

    if (leftEntries.length !== Object.keys(right).length) {
      return false
    }

    return leftEntries.every(
      ([key, value]) => Object.hasOwn(right, key) && deepEqual(value, right[key]),
    )
  }

  return Object.is(left, right)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isIncludesMatcher(value: unknown): value is { readonly includes: string } {
  return isPlainObject(value) && typeof value.includes === "string"
}

function formatValue(value: unknown): string {
  if (typeof value === "undefined") {
    return "undefined"
  }

  return JSON.stringify(value)
}
