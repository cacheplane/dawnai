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

  test("rejects spoofed internal-slot objects without invoking toStringTag accessors", () => {
    const snapshot = createScenarioSnapshotter()
    const promise = Promise.resolve("value")
    const weakMap = new WeakMap<object, unknown>()
    let tagGetterCalls = 0
    const tagged = {}

    Object.defineProperty(promise, Symbol.toStringTag, {
      configurable: true,
      value: "Object",
    })
    Object.defineProperty(weakMap, Symbol.toStringTag, {
      configurable: true,
      value: "Object",
    })
    Object.setPrototypeOf(promise, Object.prototype)
    Object.setPrototypeOf(weakMap, Object.prototype)
    Object.defineProperty(tagged, Symbol.toStringTag, {
      get() {
        tagGetterCalls += 1
        return "Object"
      },
    })

    expect(() => snapshot(promise)).toThrow(/Promise snapshot values are not supported/i)
    expect(() => snapshot(weakMap)).toThrow(/WeakMap snapshot values are not supported/i)
    expect(() => snapshot(tagged)).toThrow(/accessor property.*toStringTag.*not supported/i)
    expect(tagGetterCalls).toBe(0)
  })

  test("materializes detached read-only Error and DOMException stacks", () => {
    const authoredError = new TypeError("authored error")
    const authoredDomException = new DOMException("authored DOM exception", "AbortError")
    const errorStack = authoredError.stack
    const domExceptionStack = authoredDomException.stack
    const snapshot = createScenarioSnapshotter()({
      domException: authoredDomException,
      error: authoredError,
    }) as { domException: DOMException; error: TypeError }

    authoredError.stack = "changed source error stack"
    Object.defineProperty(authoredDomException, "stack", {
      configurable: true,
      value: "changed source DOM exception stack",
      writable: true,
    })

    expect(snapshot.error.stack).toBe(errorStack)
    expect(snapshot.domException.stack).toBe(domExceptionStack)
    expect(snapshot.error.stack).not.toContain("createScenarioSnapshotter")
    expect(snapshot.domException.stack).not.toContain("createScenarioSnapshotter")

    for (const value of [snapshot.error, snapshot.domException]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, "stack")
      expect(descriptor).toMatchObject({ configurable: false, writable: false })
      expect(descriptor).toHaveProperty("value")
      expect(descriptor).not.toHaveProperty("get")
      expect(() => {
        ;(value as unknown as { stack: string }).stack = "changed snapshot stack"
      }).toThrow()
    }

    expect(snapshot.error.stack).toBe(errorStack)
    expect(snapshot.domException.stack).toBe(domExceptionStack)
  })

  test("secures and detaches File and Blob intrinsic symbol state", async () => {
    const authoredBlob = new Blob(["Dawn"], { type: "text/plain" })
    const authoredFile = new File(["Dawn"], "dawn.txt", {
      lastModified: 123,
      type: "text/plain",
    })
    const snapshot = createScenarioSnapshotter()({
      blob: authoredBlob,
      file: authoredFile,
    }) as { blob: Blob; file: File }

    const findFileState = (file: File): Record<PropertyKey, unknown> => {
      for (const symbol of Object.getOwnPropertySymbols(file)) {
        const descriptor = Object.getOwnPropertyDescriptor(file, symbol)
        const value = descriptor && "value" in descriptor ? descriptor.value : undefined

        if (
          typeof value === "object" &&
          value !== null &&
          Object.hasOwn(value, "name") &&
          Object.hasOwn(value, "lastModified")
        ) {
          return value as Record<PropertyKey, unknown>
        }
      }

      throw new Error("Expected File intrinsic state")
    }

    const authoredState = findFileState(authoredFile)
    const snapshotState = findFileState(snapshot.file)
    authoredState.name = "changed-source.txt"
    authoredState.lastModified = 999

    expect(snapshot.file.name).toBe("dawn.txt")
    expect(snapshot.file.lastModified).toBe(123)
    expect(snapshotState).not.toBe(authoredState)
    expect(Object.isFrozen(snapshotState)).toBe(true)
    expect(() => {
      snapshotState.name = "changed-snapshot.txt"
    }).toThrow()
    expect(() => {
      snapshotState.lastModified = 456
    }).toThrow()
    expect(snapshot.file.name).toBe("dawn.txt")
    expect(snapshot.file.lastModified).toBe(123)

    for (const value of [snapshot.blob, snapshot.file]) {
      const symbols = Object.getOwnPropertySymbols(value)
      expect(symbols.length).toBeGreaterThan(0)

      for (const symbol of symbols) {
        const descriptor = Object.getOwnPropertyDescriptor(value, symbol)
        expect(descriptor).toBeDefined()

        if (descriptor && "value" in descriptor && typeof descriptor.value === "object") {
          expect(Object.isFrozen(descriptor.value)).toBe(true)
        }
      }
    }

    await expect(snapshot.blob.text()).resolves.toBe("Dawn")
    await expect(snapshot.file.text()).resolves.toBe("Dawn")
  })
})
