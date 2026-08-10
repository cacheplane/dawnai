import { inspect } from "node:util"

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

  test("rejects Array and Error proxies before specialized dispatch", () => {
    const snapshot = createScenarioSnapshotter()

    for (const [label, value] of [
      ["Array", []],
      ["Error", new Error("invalid")],
    ] as const) {
      let protocolReads = 0
      let otherTrapCalls = 0
      const proxy = new Proxy(value, {
        get(target, property, receiver) {
          if (
            typeof property === "symbol" &&
            Symbol.keyFor(property) === "dawn.scenario-readonly-snapshot-data.v1"
          ) {
            protocolReads += 1
            return undefined
          }

          otherTrapCalls += 1
          return Reflect.get(target, property, receiver)
        },
        getOwnPropertyDescriptor(target, property) {
          otherTrapCalls += 1
          return Reflect.getOwnPropertyDescriptor(target, property)
        },
        getPrototypeOf(target) {
          otherTrapCalls += 1
          return Reflect.getPrototypeOf(target)
        },
        ownKeys(target) {
          otherTrapCalls += 1
          return Reflect.ownKeys(target)
        },
      })

      expect(() => snapshot(proxy), label).toThrow(/Proxy snapshot values are not supported/i)
      expect(protocolReads, label).toBe(1)
      expect(otherTrapCalls, label).toBe(0)
    }
  })

  test("rejects custom built-in subclasses before specialized dispatch", () => {
    class PrivateDate extends Date {
      #secret = "date"

      readSecret(): string {
        return this.#secret
      }
    }
    class PrivateMap extends Map<string, string> {
      #secret = "map"

      readSecret(): string {
        return this.#secret
      }
    }

    for (const value of [new PrivateDate(0), new PrivateMap()]) {
      expect(() => createScenarioSnapshotter()(value)).toThrow(
        new RegExp(`unsupported snapshot value: custom instance ${value.constructor.name}`, "i"),
      )
    }
  })

  test("preserves explicitly supported native Error subclasses", () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "SuppressedError")
    const constructorValue = descriptor && "value" in descriptor ? descriptor.value : undefined

    if (typeof constructorValue !== "function") {
      return
    }

    const authored = Reflect.construct(constructorValue, [
      new Error("primary"),
      new Error("suppressed"),
      "combined",
    ]) as Error
    const snapshot = createScenarioSnapshotter()(authored) as Error

    expect(Object.getPrototypeOf(snapshot)).toBe(Object.getPrototypeOf(authored))
    expect(snapshot.message).toBe("combined")
    expect(Object.isFrozen(snapshot)).toBe(true)
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

  test("rejects prototype-stripped internal-slot objects", () => {
    const snapshot = createScenarioSnapshotter()
    const values: { readonly label: string; readonly value: object }[] = []

    if (typeof WeakRef === "function") {
      const referent = {}
      const weakRef = new WeakRef(referent)
      Object.setPrototypeOf(weakRef, Object.prototype)
      values.push({ label: "WeakRef", value: weakRef })
    }

    if (typeof WebAssembly === "object" && typeof WebAssembly.Module === "function") {
      const module = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]))
      Object.setPrototypeOf(module, Object.prototype)
      values.push({ label: "WebAssembly.Module", value: module })
    }

    for (const { label, value } of values) {
      expect(Object.getOwnPropertyDescriptor(value, Symbol.toStringTag), label).toBeUndefined()
      expect(() => snapshot(value), label).toThrow(
        new RegExp(`${label.replace(".", "\\.")} snapshot values are not supported`, "i"),
      )
    }
  })

  test("rejects centrally classified prototype-stripped intrinsic families", () => {
    const snapshot = createScenarioSnapshotter()
    const values: { readonly label: string; readonly value: object }[] = [
      {
        label: "FinalizationRegistry",
        value: new FinalizationRegistry(() => undefined),
      },
      { label: "Intl.Collator", value: new Intl.Collator("en") },
      { label: "Intl.DateTimeFormat", value: new Intl.DateTimeFormat("en") },
      { label: "URL", value: new URL("https://dawnai.org/research") },
      { label: "URLSearchParams", value: new URLSearchParams("query=Dawn") },
    ]

    if (typeof WebAssembly === "object") {
      values.push(
        {
          label: "WebAssembly.Memory",
          value: new WebAssembly.Memory({ initial: 1 }),
        },
        {
          label: "WebAssembly.Table",
          value: new WebAssembly.Table({ element: "anyfunc", initial: 1 }),
        },
        {
          label: "WebAssembly.Global",
          value: new WebAssembly.Global({ mutable: true, value: "i32" }, 1),
        },
      )
    }

    for (const { label, value } of values) {
      Object.setPrototypeOf(value, Object.prototype)
      expect(Object.getOwnPropertyDescriptor(value, Symbol.toStringTag), label).toBeUndefined()
      expect(() => snapshot(value), label).toThrow(
        new RegExp(`${label.replace(".", "\\.")} snapshot values are not supported`, "i"),
      )
    }
  })

  test("rejects custom instances with private or inherited state", () => {
    class PrivateBox {
      #value = "secret"

      read(): string {
        return this.#value
      }
    }
    class InheritedBox {}
    Object.defineProperty(InheritedBox.prototype, "state", {
      value: { count: 1 },
    })

    for (const value of [new PrivateBox(), new InheritedBox()]) {
      expect(() => createScenarioSnapshotter()(value)).toThrow(
        new RegExp(`unsupported snapshot value: custom instance ${value.constructor.name}`, "i"),
      )
    }
  })

  test("detaches plain and null-prototype records", () => {
    const nullRecord = Object.assign(Object.create(null) as Record<string, unknown>, {
      label: "null",
      nested: { count: 1 },
    })
    const authored = {
      nullRecord,
      plain: { label: "plain", nested: { count: 1 } },
    }
    const snapshot = createScenarioSnapshotter()(authored) as typeof authored

    authored.plain.nested.count = 2
    ;(nullRecord.nested as { count: number }).count = 2

    expect(Object.getPrototypeOf(snapshot.plain)).toBe(Object.prototype)
    expect(snapshot.plain).toEqual({ label: "plain", nested: { count: 1 } })
    expect(Object.getPrototypeOf(snapshot.nullRecord)).toBeNull()
    expect(snapshot.nullRecord).toEqual({ label: "null", nested: { count: 1 } })
    expect(Object.isFrozen(snapshot.plain)).toBe(true)
    expect(Object.isFrozen(snapshot.plain.nested)).toBe(true)
    expect(Object.isFrozen(snapshot.nullRecord)).toBe(true)
    expect(Object.isFrozen(snapshot.nullRecord.nested)).toBe(true)
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
    expect(Object.getOwnPropertySymbols(snapshot.file)).toEqual([inspect.custom])
    expect(Object.getOwnPropertyDescriptor(snapshot.file, inspect.custom)).toMatchObject({
      configurable: false,
      enumerable: false,
      writable: false,
    })
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
    expect(inspect(snapshot.file)).toBe(
      "File { size: 4, type: 'text/plain', name: 'dawn.txt', lastModified: 123 }",
    )
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
    expect(Object.getPrototypeOf(first.file)).toBe(File.prototype)
    expect(Object.getPrototypeOf(second.file)).toBe(File.prototype)
    expect(inspect(second.file)).toContain("name: 'dawn.txt'")

    vi.resetModules()
    const secondModule = await import("../src/testing/scenario-snapshot.js")
    const crossCopy = secondModule.createScenarioSnapshotter()(first) as typeof first
    await expect(crossCopy.blob.slice(0, 2).text()).resolves.toBe("Da")
    await expect(crossCopy.file.slice(2).text()).resolves.toBe("wn")
    expect(crossCopy.file.name).toBe("dawn.txt")
    expect(crossCopy.file.lastModified).toBe(123)
    expect(Object.getPrototypeOf(crossCopy.file)).toBe(File.prototype)
    expect(inspect(crossCopy.file)).toContain("name: 'dawn.txt'")
  })

  test("uses a fixed intrinsic predicate set for plain records", async () => {
    vi.resetModules()
    const actual = await vi.importActual<typeof import("node:util/types")>("node:util/types")
    const weakRefDeref = vi.spyOn(WeakRef.prototype, "deref")
    const webAssemblyModuleExports = vi.spyOn(WebAssembly.Module, "exports")
    const calls = new Map<string, number>()
    const mockedTypeChecks: Record<string, unknown> = {}

    for (const [name, value] of Object.entries(actual)) {
      mockedTypeChecks[name] =
        typeof value === "function"
          ? (candidate: unknown) => {
              calls.set(name, (calls.get(name) ?? 0) + 1)
              return (value as (input: unknown) => boolean)(candidate)
            }
          : value
    }

    mockedTypeChecks.futureIntrinsicPredicate = () => {
      calls.set("futureIntrinsicPredicate", (calls.get("futureIntrinsicPredicate") ?? 0) + 1)
      return true
    }
    vi.doMock("node:util/types", () => mockedTypeChecks)

    try {
      const isolated = await import("../src/testing/scenario-snapshot.js")
      expect(isolated.createScenarioSnapshotter()({ stable: true })).toEqual({ stable: true })
      expect(calls.get("futureIntrinsicPredicate") ?? 0).toBe(0)
      expect([...calls.values()].reduce((total, count) => total + count, 0)).toBeLessThanOrEqual(20)
      expect(weakRefDeref).not.toHaveBeenCalled()
      expect(webAssemblyModuleExports).not.toHaveBeenCalled()
    } finally {
      weakRefDeref.mockRestore()
      webAssemblyModuleExports.mockRestore()
      vi.doUnmock("node:util/types")
      vi.resetModules()
    }
  })
})
