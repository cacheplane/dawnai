import { describe, expect, test, vi } from "vitest"

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

  test("rejects unrecognized intrinsic objects from generic cloning", () => {
    const snapshot = createScenarioSnapshotter()
    const messageChannel = typeof MessageChannel === "function" ? new MessageChannel() : undefined
    const values: { readonly label: string; readonly value: object }[] = [
      { label: "boxed Symbol", value: Object(Symbol("value")) as object },
      { label: "Map iterator", value: new Map().entries() },
      { label: "array iterator", value: [][Symbol.iterator]() },
    ]

    if (messageChannel) {
      messageChannel.port1.close()
      messageChannel.port2.close()
      values.push({ label: "MessageChannel", value: messageChannel })
    }

    if (typeof WebAssembly === "object" && typeof WebAssembly.Module === "function") {
      values.push({
        label: "WebAssembly.Module",
        value: new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])),
      })
    }

    for (const { label, value } of values) {
      expect(() => snapshot(value), label).toThrow(/snapshot.*not supported/i)
      Object.defineProperty(value, Symbol.toStringTag, {
        configurable: true,
        value: "Object",
      })
      expect(() => snapshot(value), label).toThrow(/snapshot.*not supported/i)
    }

    const ownTag = { [Symbol.toStringTag]: "Object" }
    const inheritedTag = Object.create({ [Symbol.toStringTag]: "Object" }) as object
    expect(() => snapshot(ownTag)).toThrow(/snapshot.*not supported/i)
    expect(() => snapshot(inheritedTag)).toThrow(/snapshot.*not supported/i)
  })

  test("keeps ordinary user-defined data classes cloneable", () => {
    class DataBox {
      constructor(
        readonly label: string,
        readonly nested: { count: number },
      ) {}

      describe(): string {
        return `${this.label}:${this.nested.count}`
      }
    }

    const authored = new DataBox("Dawn", { count: 1 })
    const snapshot = createScenarioSnapshotter()(authored) as DataBox
    authored.nested.count = 2

    expect(snapshot).toBeInstanceOf(DataBox)
    expect(snapshot).not.toBe(authored)
    expect(snapshot.describe()).toBe("Dawn:1")
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.nested)).toBe(true)
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

  test("hides mutable File state while preserving detached metadata", async () => {
    const authoredBlob = new Blob(["Dawn"], { type: "text/plain" })
    const authoredFile = new File(["Dawn"], "dawn.txt", {
      lastModified: 123,
      type: "text/plain",
    })
    const snapshot = createScenarioSnapshotter()({
      blob: authoredBlob,
      file: authoredFile,
    }) as { blob: Blob; file: File }

    const findFileState = (file: File): Record<PropertyKey, unknown> | undefined => {
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

      return undefined
    }

    const authoredState = findFileState(authoredFile)
    if (!authoredState) throw new Error("Expected authored File intrinsic state")
    authoredState.name = "changed-source.txt"
    authoredState.lastModified = 999

    expect(snapshot.file.name).toBe("dawn.txt")
    expect(snapshot.file.lastModified).toBe(123)
    expect(findFileState(snapshot.file)).toBeUndefined()
    expect(Object.getOwnPropertySymbols(snapshot.blob)).toEqual([])
    expect(Object.getOwnPropertySymbols(snapshot.file)).toEqual([])
    expect(Object.isFrozen(snapshot.blob)).toBe(true)
    expect(Object.isFrozen(snapshot.file)).toBe(true)
    expect(() => {
      ;(snapshot.file as unknown as { name: string }).name = "changed-snapshot.txt"
    }).toThrow(/read-only snapshot/i)
    expect(() => {
      ;(snapshot.file as unknown as { lastModified: number }).lastModified = 456
    }).toThrow(/read-only snapshot/i)

    await expect(snapshot.blob.text()).resolves.toBe("Dawn")
    await expect(snapshot.file.text()).resolves.toBe("Dawn")
  })

  test("preserves Blob and File reads across slices, snapshots, and module copies", async () => {
    const first = createScenarioSnapshotter()({
      blob: new Blob(["Dawn"], { type: "text/plain" }),
      file: new File(["Dawn"], "dawn.txt", {
        lastModified: 123,
        type: "text/plain",
      }),
    }) as { blob: Blob; file: File }

    await expect(first.blob.slice(1, 3).text()).resolves.toBe("aw")
    await expect(first.file.slice(0, 2).text()).resolves.toBe("Da")

    const second = createScenarioSnapshotter()(first) as typeof first
    await expect(second.blob.text()).resolves.toBe("Dawn")
    await expect(second.file.text()).resolves.toBe("Dawn")
    expect(second.file.name).toBe("dawn.txt")
    expect(second.file.lastModified).toBe(123)

    vi.resetModules()
    const secondModule = await import("../src/testing/scenario-snapshot.js")
    const crossCopy = secondModule.createScenarioSnapshotter()(first) as typeof first
    await expect(crossCopy.blob.slice(0, 2).text()).resolves.toBe("Da")
    await expect(crossCopy.file.slice(2).text()).resolves.toBe("wn")
    expect(crossCopy.file.name).toBe("dawn.txt")
    expect(crossCopy.file.lastModified).toBe(123)
  })
})
