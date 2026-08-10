import { describe, expect, test } from "vitest"

import { createScenarioSnapshotter } from "../src/testing/scenario-snapshot.js"

describe("createScenarioSnapshotter", () => {
  test("preserves all array data properties and cycles", () => {
    const marker = Symbol("marker")
    const authored: unknown[] & {
      hidden?: { stable: boolean }
      self?: unknown
      [marker]?: { label: string }
    } = ["value"]
    Object.defineProperty(authored, "hidden", {
      enumerable: false,
      value: { stable: true },
    })
    authored[marker] = { label: "symbol" }
    authored.self = authored

    const snapshot = createScenarioSnapshotter()(authored) as typeof authored

    expect(snapshot).not.toBe(authored)
    expect(snapshot.self).toBe(snapshot)
    expect(snapshot.hidden).toEqual({ stable: true })
    expect(Object.getOwnPropertyDescriptor(snapshot, "hidden")?.enumerable).toBe(false)
    expect(snapshot[marker]).toEqual({ label: "symbol" })
    expect(Object.isFrozen(snapshot)).toBe(true)
  })

  test("rejects executable and accessor data without invoking it", () => {
    const snapshot = createScenarioSnapshotter()
    let getterCalls = 0
    let stackGetterCalls = 0
    const accessor = {}
    Object.defineProperty(accessor, "danger", {
      get() {
        getterCalls += 1
        return "invalid"
      },
    })
    const error = new Error("invalid")
    Object.defineProperty(error, "stack", {
      configurable: true,
      get() {
        stackGetterCalls += 1
        return "invalid"
      },
    })

    expect(() => snapshot({ nested: () => undefined })).toThrow(
      /function snapshot values are not supported/i,
    )
    expect(() => snapshot(accessor)).toThrow(/accessor property.*danger.*not supported/i)
    expect(() => snapshot(error)).toThrow(/accessor property.*stack.*not supported/i)
    expect(getterCalls).toBe(0)
    expect(stackGetterCalls).toBe(0)
  })
})
