import { describe, expect, test, vi } from "vitest"

import { isScenarioSuite, readScenarioSuite, scenarios } from "../src/testing/index.js"

declare module "../src/testing/index.js" {
  interface RouteScenarioMap {
    "/research": {
      readonly tools: {
        readonly ping: () => Promise<string>
        readonly searchWeb: (input: { readonly query: string }) => Promise<{
          readonly results: readonly string[]
        }>
      }
    }
  }
}

describe("scenarios", () => {
  test("builds a branded immutable suite descriptor", () => {
    const suite = scenarios("/research").scenario("searches", (s) =>
      s
        .input({ messages: [] })
        .mockTool("searchWeb", async ({ query }) => ({ results: [query] }))
        .expectPassed()
        .expectOutput({ answer: "Dawn" })
        .expectTool("searchWeb", (call) => call.calledOnce().withArgs({ query: "Dawn" })),
    )

    expect(isScenarioSuite(suite)).toBe(true)
    expect(readScenarioSuite(suite)).toMatchObject({
      route: "/research",
      scenarios: [
        {
          execution: "in-process",
          expectedStatus: "passed",
          name: "searches",
          toolCallExpectations: [{ count: { kind: "exact", value: 1 }, name: "searchWeb" }],
          toolMocks: [{ name: "searchWeb" }],
        },
      ],
    })
  })

  test("reuses parsed descriptors when appending scenarios", () => {
    const firstSuite = scenarios("/research").scenario("first", (s) =>
      s.input({ value: "first" }).expectPassed(),
    )
    const firstDescriptor = readScenarioSuite(firstSuite)
    const firstScenario = firstDescriptor.scenarios[0]
    if (!firstScenario) throw new Error("Expected the first scenario descriptor")

    const secondSuite = firstSuite.scenario("second", (s) =>
      s.input({ value: "second" }).expectPassed(),
    )
    const secondDescriptor = readScenarioSuite(secondSuite)

    expect(secondDescriptor.scenarios[0]).toBe(firstScenario)
    expect(readScenarioSuite(firstSuite)).toBe(firstDescriptor)
    expect(readScenarioSuite(secondSuite)).toBe(secondDescriptor)
  })

  test("caches a successful forged suite parse between guard and read", () => {
    const suite = scenarios("/research").scenario("valid", (s) => s.input({}).expectPassed())
    const descriptor = readScenarioSuite(suite)
    const [brand] = Object.getOwnPropertySymbols(suite)
    if (!brand) throw new Error("Expected a scenario suite brand")

    let routeReads = 0
    const payload = new Proxy(descriptor, {
      get(target, property, receiver) {
        if (property === "route") routeReads += 1
        return Reflect.get(target, property, receiver)
      },
    })
    const forged = {
      scenario: () => undefined,
      [brand]: payload,
    }

    expect(isScenarioSuite(forged)).toBe(true)
    const readsAfterGuard = routeReads
    const firstRead = readScenarioSuite(forged)
    const secondRead = readScenarioSuite(forged)

    expect(routeReads).toBe(readsAfterGuard)
    expect(secondRead).toBe(firstRead)
  })

  test("rejects duplicate scenario names", () => {
    const suite = scenarios("/research").scenario("duplicate", (s) => s.input({}).expectPassed())
    expect(() => suite.scenario("duplicate", (s) => s.input({}).expectPassed())).toThrow(
      /duplicate scenario name/i,
    )
  })

  test("rejects incomplete and conflicting states at runtime", () => {
    // biome-ignore lint/suspicious/noExplicitAny: this test deliberately bypasses the public type states.
    type UnsafeBuilder = Record<string, (...args: any[]) => any>

    const suite = scenarios("/research") as unknown as {
      scenario(name: string, configure: (builder: UnsafeBuilder) => UnsafeBuilder): unknown
    }
    expect(() => suite.scenario("missing status", (s) => s.input({}))).toThrow(/expected status/i)
    expect(() =>
      suite.scenario("server mock", (s) =>
        s
          .input({})
          .server("http://localhost:3000")
          .mockTool("searchWeb", async () => ({ results: [] }))
          .expectPassed(),
      ),
    ).toThrow(/server.*tool mock/i)
    expect(() =>
      suite.scenario("passed error", (s) =>
        s.input({}).expectPassed().expectError({ message: "invalid" }),
      ),
    ).toThrow(/passing.*error expectation/i)
    expect(() =>
      suite.scenario("failed output", (s) =>
        s.input({}).expectFailed().expectOutput({ invalid: true }),
      ),
    ).toThrow(/failing.*output expectation/i)
    expect(() =>
      suite.scenario("duplicate input", (s) => s.input({}).input({ again: true }).expectPassed()),
    ).toThrow(/input.*once/i)
    expect(() =>
      suite.scenario("duplicate status", (s) => s.input({}).expectPassed().expectFailed()),
    ).toThrow(/status.*once/i)
    expect(() =>
      suite.scenario("unmocked expectation", (s) =>
        s
          .input({})
          .expectPassed()
          .expectTool("searchWeb", (call) => call.called()),
      ),
    ).toThrow(/mock.*before.*expect/i)
    expect(() =>
      suite.scenario("contradictory call", (s) =>
        s
          .input({})
          .mockTool("searchWeb", async () => ({ results: [] }))
          .expectPassed()
          .expectTool("searchWeb", (call) => call.notCalled().withArgs({ query: "Dawn" })),
      ),
    ).toThrow(/notCalled.*arguments/i)
    expect(() =>
      suite.scenario("reverse contradictory call", (s) =>
        s
          .input({})
          .mockTool("searchWeb", async () => ({ results: [] }))
          .expectPassed()
          .expectTool("searchWeb", (call) => call.withArgs({ query: "Dawn" }).notCalled()),
      ),
    ).toThrow(/notCalled.*arguments/i)
  })

  test("rejects a forged brand carrying a malformed descriptor", () => {
    const suite = scenarios("/research").scenario("valid", (s) => s.input({}).expectPassed())
    const [brand] = Object.getOwnPropertySymbols(suite)
    if (!brand) throw new Error("Expected a scenario suite brand")

    const forged = {
      scenario: () => undefined,
      [brand]: {
        route: "/research",
        scenarios: [{ input: {}, name: "missing required fields" }],
      },
    }

    expect(isScenarioSuite(forged)).toBe(false)
    expect(() => readScenarioSuite(forged)).toThrow(/malformed scenario suite/i)
  })

  test("rejects sparse arrays throughout forged descriptors", () => {
    const suite = scenarios("/research").scenario("valid", (s) => s.input({}).expectPassed())
    const [brand] = Object.getOwnPropertySymbols(suite)
    if (!brand) throw new Error("Expected a scenario suite brand")

    const sparseArray = (): unknown[] => {
      const values: unknown[] = []
      values.length = 1
      return values
    }
    const toolMock = {
      implementation: async () => ({ results: [] }),
      name: "searchWeb",
    }
    const validScenario = {
      execution: "in-process",
      expectedStatus: "passed",
      input: {},
      name: "valid",
      toolCallExpectations: [],
      toolMocks: [],
    }
    const cases = [
      {
        label: "scenarios",
        payload: { route: "/research", scenarios: sparseArray() },
      },
      {
        label: "tool mocks",
        payload: {
          route: "/research",
          scenarios: [{ ...validScenario, toolMocks: sparseArray() }],
        },
      },
      {
        label: "tool call expectations",
        payload: {
          route: "/research",
          scenarios: [
            {
              ...validScenario,
              toolCallExpectations: sparseArray(),
              toolMocks: [toolMock],
            },
          ],
        },
      },
      {
        label: "argument matchers",
        payload: {
          route: "/research",
          scenarios: [
            {
              ...validScenario,
              toolCallExpectations: [
                {
                  argumentMatchers: sparseArray(),
                  count: { kind: "exact", value: 1 },
                  name: "searchWeb",
                },
              ],
              toolMocks: [toolMock],
            },
          ],
        },
      },
    ]

    for (const { label, payload } of cases) {
      const forged = { scenario: () => undefined, [brand]: payload }
      expect(isScenarioSuite(forged), label).toBe(false)
      expect(() => readScenarioSuite(forged), label).toThrow(
        new RegExp(`malformed scenario suite: .*${label}.*index 0`, "i"),
      )
    }
  })

  test("does not call overridden map methods on forged descriptor arrays", () => {
    const suite = scenarios("/research").scenario("valid", (s) => s.input({}).expectPassed())
    const [brand] = Object.getOwnPropertySymbols(suite)
    if (!brand) throw new Error("Expected a scenario suite brand")

    const overrideMap = <T>(values: T[]): T[] => {
      Object.defineProperty(values, "map", {
        value: () => {
          throw new Error("Called an untrusted map method")
        },
      })
      return values
    }
    const toolMock = {
      implementation: async () => ({ results: [] }),
      name: "searchWeb",
    }
    const toolExpectation = {
      argumentMatchers: [{ query: "Dawn" }],
      count: { kind: "exact", value: 1 },
      name: "searchWeb",
    }
    const validScenario = {
      execution: "in-process",
      expectedStatus: "passed",
      input: {},
      name: "valid",
      toolCallExpectations: [toolExpectation],
      toolMocks: [toolMock],
    }
    const cases = [
      {
        label: "scenarios",
        payload: { route: "/research", scenarios: overrideMap([validScenario]) },
      },
      {
        label: "tool mocks",
        payload: {
          route: "/research",
          scenarios: [{ ...validScenario, toolMocks: overrideMap([toolMock]) }],
        },
      },
      {
        label: "tool call expectations",
        payload: {
          route: "/research",
          scenarios: [
            {
              ...validScenario,
              toolCallExpectations: overrideMap([toolExpectation]),
            },
          ],
        },
      },
      {
        label: "argument matchers",
        payload: {
          route: "/research",
          scenarios: [
            {
              ...validScenario,
              toolCallExpectations: [
                {
                  ...toolExpectation,
                  argumentMatchers: overrideMap([{ query: "Dawn" }]),
                },
              ],
            },
          ],
        },
      },
    ]

    for (const { label, payload } of cases) {
      const forged = { scenario: () => undefined, [brand]: payload }
      expect(isScenarioSuite(forged), label).toBe(true)
      expect(readScenarioSuite(forged).scenarios, label).toHaveLength(1)
    }
  })

  test("rejects functions in opaque scenario values", () => {
    expect(() =>
      scenarios("/research").scenario("function input", (s) =>
        s.input({ nested: () => "invalid" }).expectPassed(),
      ),
    ).toThrow(/function snapshot values are not supported/i)

    expect(() =>
      scenarios("/research").scenario("function output", (s) =>
        s
          .input({})
          .expectPassed()
          .expectOutput({ nested: () => "invalid" }),
      ),
    ).toThrow(/function snapshot values are not supported/i)

    expect(() =>
      scenarios("/research").scenario("function matcher", (s) =>
        s
          .input({})
          .mockTool("searchWeb", async () => ({ results: [] }))
          .expectPassed()
          .expectTool("searchWeb", (call) =>
            call.withArgs({ query: (() => "invalid") as unknown as string }),
          ),
      ),
    ).toThrow(/function snapshot values are not supported/i)
  })

  test("preserves array own data properties and cycles", () => {
    const marker = Symbol("marker")
    type RichArray = unknown[] & {
      hidden?: { count: number }
      self?: RichArray
      [marker]?: { label: string }
    }

    const hidden = { count: 1 }
    const symbolValue = { label: "stable" }
    const authored = ["first"] as RichArray
    Object.defineProperty(authored, "hidden", {
      configurable: true,
      enumerable: false,
      value: hidden,
      writable: true,
    })
    authored[marker] = symbolValue
    authored.self = authored

    const suite = scenarios("/research").scenario("array shape", (s) =>
      s.input(authored).expectPassed(),
    )
    authored[0] = "changed"
    hidden.count = 2
    symbolValue.label = "changed"

    const scenario = readScenarioSuite(suite).scenarios[0]
    if (!scenario) throw new Error("Expected a scenario descriptor")
    const snapshot = scenario.input as RichArray

    expect(snapshot[0]).toBe("first")
    expect(snapshot.self).toBe(snapshot)
    expect(snapshot.hidden).toEqual({ count: 1 })
    expect(Object.getOwnPropertyDescriptor(snapshot, "hidden")?.enumerable).toBe(false)
    expect(snapshot[marker]).toEqual({ label: "stable" })
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.hidden)).toBe(true)
    expect(Object.isFrozen(snapshot[marker])).toBe(true)
  })

  test("rejects accessor properties without invoking them", () => {
    let getterCalls = 0
    const authored = {}
    Object.defineProperty(authored, "danger", {
      get() {
        getterCalls += 1
        return "invalid"
      },
    })

    expect(() =>
      scenarios("/research").scenario("accessor", (s) => s.input(authored).expectPassed()),
    ).toThrow(/accessor property.*danger.*not supported/i)
    expect(getterCalls).toBe(0)
  })

  test("rejects a valid branded payload without a scenario method", () => {
    const suite = scenarios("/research").scenario("valid", (s) => s.input({}).expectPassed())
    const descriptor = readScenarioSuite(suite)
    const [brand] = Object.getOwnPropertySymbols(suite)
    if (!brand) throw new Error("Expected a scenario suite brand")
    const forged = { [brand]: descriptor }

    expect(isScenarioSuite(forged)).toBe(false)
    expect(() => readScenarioSuite(forged)).toThrow(/malformed scenario suite: .*scenario.*method/i)
  })

  test("recursively snapshots mutable opaque values", async () => {
    class MutableBox {
      label: string
      nested: { count: number }

      constructor(label: string, count: number) {
        this.label = label
        this.nested = { count }
      }

      rename(label: string): void {
        this.label = label
      }
    }

    const authoredDate = new Date("2026-08-09T12:00:00.000Z")
    const authoredMap = new Map([["entry", { count: 1 }]])
    const authoredBox = new MutableBox("original", 1)
    const authoredCycle = new Map<string, unknown>()
    authoredCycle.set("self", authoredCycle)
    const mock = async ({ query }: { readonly query: string }) => ({ results: [query] })
    const assertion = () => "asserted"
    const suite = scenarios("/research").scenario("snapshots", (s) =>
      s
        .input({
          box: authoredBox,
          cycle: authoredCycle,
          date: authoredDate,
          map: authoredMap,
        })
        .mockTool("searchWeb", mock)
        .expectPassed()
        .assert(assertion),
    )
    const descriptor = readScenarioSuite(suite)
    const scenario = descriptor.scenarios[0]
    if (!scenario) throw new Error("Expected a scenario descriptor")
    const snapshot = scenario.input as {
      box: MutableBox
      cycle: Map<string, unknown>
      date: Date
      map: Map<string, { count: number }>
    }

    authoredDate.setUTCFullYear(2030)
    const authoredEntry = authoredMap.get("entry")
    if (!authoredEntry) throw new Error("Expected the authored map entry")
    authoredEntry.count = 2
    authoredMap.set("later", { count: 3 })
    authoredBox.rename("changed")
    authoredBox.nested.count = 2

    expect(snapshot.date).toBeInstanceOf(Date)
    expect(snapshot.date.toISOString()).toBe("2026-08-09T12:00:00.000Z")
    expect(snapshot.map).toBeInstanceOf(Map)
    expect(snapshot.map.get("entry")).toEqual({ count: 1 })
    expect(snapshot.map.has("later")).toBe(false)
    expect(snapshot.box).toBeInstanceOf(MutableBox)
    expect(snapshot.box).toMatchObject({ label: "original", nested: { count: 1 } })
    expect(snapshot.cycle.get("self")).toBe(snapshot.cycle)

    expect(Object.isFrozen(snapshot.date)).toBe(true)
    expect(Object.isFrozen(snapshot.map)).toBe(true)
    expect(Object.isFrozen(snapshot.map.get("entry"))).toBe(true)
    expect(Object.isFrozen(snapshot.box)).toBe(true)
    expect(Object.isFrozen(snapshot.box.nested)).toBe(true)
    expect(() => snapshot.date.setTime(0)).toThrow(/read-only snapshot/i)
    expect(() => snapshot.map.set("mutated", { count: 4 })).toThrow(/read-only snapshot/i)
    expect(() => snapshot.box.rename("mutated")).toThrow()

    const toolMock = scenario.toolMocks[0]
    if (!toolMock) throw new Error("Expected a tool mock")
    await expect(toolMock.implementation({ query: "Dawn" })).resolves.toEqual({
      results: ["Dawn"],
    })
    expect(await scenario.assert?.({} as never)).toBe("asserted")
  })

  test("faithfully snapshots structured-clone objects with internal slots", async () => {
    const setEntry = { count: 1 }
    const authoredSet = new Set<unknown>([setEntry])
    authoredSet.add(authoredSet)
    const authoredPattern = /dawn/gi
    authoredPattern.lastIndex = 2
    const authoredNumber = Object.assign(new Number(42), { metadata: { stable: true } })
    const authoredError = new TypeError("invalid", { cause: { code: "authored" } })
    const authoredDomException = Object.assign(new DOMException("cancelled", "AbortError"), {
      metadata: { stable: true },
    })
    const authoredBlob = Object.assign(new Blob(["Dawn"], { type: "text/plain" }), {
      metadata: { stable: true },
    })
    const authoredFile = Object.assign(
      new File(["Dawn"], "dawn.txt", { lastModified: 1, type: "text/plain" }),
      { metadata: { stable: true } },
    )
    const suite = scenarios("/research").scenario("internal slots", (s) =>
      s
        .input({
          blob: authoredBlob,
          domException: authoredDomException,
          error: authoredError,
          file: authoredFile,
          number: authoredNumber,
          pattern: authoredPattern,
          set: authoredSet,
        })
        .expectPassed(),
    )

    setEntry.count = 2
    authoredSet.add("later")
    authoredPattern.lastIndex = 0
    authoredNumber.metadata.stable = false
    authoredDomException.metadata.stable = false
    authoredBlob.metadata.stable = false
    authoredFile.metadata.stable = false
    ;(authoredError.cause as { code: string }).code = "changed"

    const scenario = readScenarioSuite(suite).scenarios[0]
    if (!scenario) throw new Error("Expected a scenario descriptor")
    const snapshot = scenario.input as {
      blob: Blob & { metadata: { stable: boolean } }
      domException: DOMException & { metadata: { stable: boolean } }
      error: TypeError & { cause: { code: string } }
      file: File & { metadata: { stable: boolean } }
      number: { metadata: { stable: boolean }; valueOf(): number }
      pattern: RegExp
      set: Set<unknown>
    }

    expect(snapshot.set).toBeInstanceOf(Set)
    expect([...snapshot.set]).toEqual([{ count: 1 }, snapshot.set])
    expect(snapshot.set.has("later")).toBe(false)
    expect(() => snapshot.set.add("mutated")).toThrow(/read-only snapshot/i)
    expect(() => Set.prototype.add.call(snapshot.set, "mutated")).toThrow()
    expect(() =>
      snapshot.set.forEach((_value, _key, collection) => {
        collection.add("mutated")
      }),
    ).toThrow(/read-only snapshot/i)

    expect(snapshot.pattern).toBeInstanceOf(RegExp)
    expect(snapshot.pattern.source).toBe("dawn")
    expect(snapshot.pattern.flags).toBe("gi")
    expect(snapshot.pattern.lastIndex).toBe(2)
    expect(snapshot.pattern.test("xxDawn")).toBe(true)
    expect(snapshot.pattern.lastIndex).toBe(2)
    expect(() => snapshot.pattern.compile("changed")).toThrow(/read-only snapshot/i)
    expect(() => RegExp.prototype.compile.call(snapshot.pattern, "changed")).toThrow()
    expect(() => {
      snapshot.pattern.lastIndex = 0
    }).toThrow()

    expect(snapshot.number).toBeInstanceOf(Number)
    expect(snapshot.number.valueOf()).toBe(42)
    expect(snapshot.number.metadata).toEqual({ stable: true })
    expect(Object.isFrozen(snapshot.number)).toBe(true)
    expect(Object.isFrozen(snapshot.number.metadata)).toBe(true)

    expect(snapshot.blob).toBeInstanceOf(Blob)
    expect(snapshot.blob.type).toBe("text/plain")
    expect(await snapshot.blob.text()).toBe("Dawn")
    expect(snapshot.blob.metadata).toEqual({ stable: true })
    expect(Object.isFrozen(snapshot.blob)).toBe(true)

    expect(snapshot.file).toBeInstanceOf(File)
    expect(snapshot.file.name).toBe("dawn.txt")
    expect(snapshot.file.lastModified).toBe(1)
    expect(await snapshot.file.text()).toBe("Dawn")
    expect(snapshot.file.metadata).toEqual({ stable: true })
    expect(Object.isFrozen(snapshot.file)).toBe(true)

    expect(snapshot.domException).toBeInstanceOf(DOMException)
    expect(snapshot.domException.name).toBe("AbortError")
    expect(snapshot.domException.message).toBe("cancelled")
    expect(snapshot.domException.toString()).toBe("AbortError: cancelled")
    expect(snapshot.domException.metadata).toEqual({ stable: true })
    expect(Object.isFrozen(snapshot.domException)).toBe(true)

    expect(snapshot.error).toBeInstanceOf(TypeError)
    expect(snapshot.error.toString()).toBe("TypeError: invalid")
    expect(snapshot.error.cause).toEqual({ code: "authored" })
    expect(Object.isFrozen(snapshot.error)).toBe(true)
    expect(Object.isFrozen(snapshot.error.cause)).toBe(true)
  })

  test("faithfully snapshots binary buffers and views", () => {
    type LinkedBuffer = ArrayBuffer & {
      readonly maxByteLength: number
      readonly resizable: boolean
      resize(byteLength: number): void
      view?: LinkedView
    }
    type LinkedView = DataView & { owner?: LinkedBuffer }
    type GrowableSharedBuffer = SharedArrayBuffer & {
      grow(byteLength: number): void
      readonly growable: boolean
      readonly maxByteLength: number
    }

    const authoredBuffer = Reflect.construct(ArrayBuffer, [
      6,
      { maxByteLength: 10 },
    ]) as LinkedBuffer
    new Uint8Array(authoredBuffer).set([1, 2, 3, 4, 5, 6])
    const authoredView = new DataView(authoredBuffer, 1, 4) as LinkedView
    authoredBuffer.view = authoredView
    authoredView.owner = authoredBuffer
    const authoredTyped = new Uint16Array([10, 20])
    const authoredBigInts = new BigInt64Array([30n, 40n])
    const authoredShared = Reflect.construct(SharedArrayBuffer, [
      4,
      { maxByteLength: 8 },
    ]) as GrowableSharedBuffer
    new Uint8Array(authoredShared).set([7, 8, 9, 10])
    const suite = scenarios("/research").scenario("binary", (s) =>
      s
        .input({
          bigInts: authoredBigInts,
          shared: authoredShared,
          typed: authoredTyped,
          view: authoredView,
          buffer: authoredBuffer,
        })
        .expectPassed(),
    )

    authoredBuffer.resize(8)
    new Uint8Array(authoredBuffer).fill(99)
    authoredTyped.fill(99)
    authoredBigInts.fill(99n)
    authoredShared.grow(8)
    new Uint8Array(authoredShared).fill(99)

    const scenario = readScenarioSuite(suite).scenarios[0]
    if (!scenario) throw new Error("Expected a scenario descriptor")
    const snapshot = scenario.input as {
      bigInts: BigInt64Array
      buffer: LinkedBuffer
      shared: GrowableSharedBuffer
      typed: Uint16Array
      view: LinkedView
    }

    expect(snapshot.buffer).toBeInstanceOf(ArrayBuffer)
    expect(snapshot.buffer.byteLength).toBe(6)
    expect(snapshot.buffer.maxByteLength).toBe(10)
    expect(snapshot.buffer.resizable).toBe(true)
    expect([...new Uint8Array(snapshot.buffer.slice(0))]).toEqual([1, 2, 3, 4, 5, 6])
    expect(() => snapshot.buffer.resize(8)).toThrow(/read-only snapshot/i)
    expect(() =>
      Reflect.apply(Reflect.get(ArrayBuffer.prototype, "resize"), snapshot.buffer, [8]),
    ).toThrow()
    const attemptedBufferView = new Uint8Array(snapshot.buffer)
    attemptedBufferView[0] = 0
    expect([...new Uint8Array(snapshot.buffer.slice(0))]).toEqual([1, 2, 3, 4, 5, 6])

    expect(snapshot.shared).toBeInstanceOf(SharedArrayBuffer)
    expect(snapshot.shared.byteLength).toBe(4)
    expect(snapshot.shared.maxByteLength).toBe(8)
    expect(snapshot.shared.growable).toBe(true)
    expect([...new Uint8Array(snapshot.shared.slice(0))]).toEqual([7, 8, 9, 10])
    expect(() => snapshot.shared.grow(8)).toThrow(/read-only snapshot/i)
    expect(() =>
      Reflect.apply(Reflect.get(SharedArrayBuffer.prototype, "grow"), snapshot.shared, [8]),
    ).toThrow()
    const attemptedSharedView = new Uint8Array(snapshot.shared)
    attemptedSharedView[0] = 0
    expect([...new Uint8Array(snapshot.shared.slice(0))]).toEqual([7, 8, 9, 10])

    expect(snapshot.view).toBeInstanceOf(DataView)
    expect(snapshot.view.byteOffset).toBe(1)
    expect(snapshot.view.byteLength).toBe(4)
    expect(snapshot.view.getUint16(0)).toBe(0x0203)
    expect(snapshot.view.buffer).toBe(snapshot.buffer)
    expect(snapshot.view.owner).toBe(snapshot.buffer)
    expect(snapshot.buffer.view).toBe(snapshot.view)
    expect(() => snapshot.view.setUint8(0, 0)).toThrow(/read-only snapshot/i)
    expect(() => DataView.prototype.setUint8.call(snapshot.view, 0, 0)).toThrow()
    expect([...new Uint8Array(snapshot.view.buffer.slice(0))]).toEqual([1, 2, 3, 4, 5, 6])

    expect(snapshot.typed).toBeInstanceOf(Uint16Array)
    expect(Array.from(snapshot.typed)).toEqual([10, 20])
    expect(snapshot.typed.join(":")).toBe("10:20")
    expect(() => {
      snapshot.typed[0] = 0
    }).toThrow(/read-only snapshot/i)
    expect(() => snapshot.typed.fill(0)).toThrow(/read-only snapshot/i)
    expect(() => Uint16Array.prototype.set.call(snapshot.typed, [0])).toThrow()
    const detachedSubarray = snapshot.typed.subarray(0, 1)
    detachedSubarray[0] = 0
    expect(Array.from(snapshot.typed)).toEqual([10, 20])

    expect(snapshot.bigInts).toBeInstanceOf(BigInt64Array)
    expect(Array.from(snapshot.bigInts)).toEqual([30n, 40n])
    expect(() => snapshot.bigInts.reverse()).toThrow(/read-only snapshot/i)
  })

  test("rejects unsupported internal-slot objects instead of forging instances", () => {
    const suite = scenarios("/research").scenario("valid", (s) => s.input({}).expectPassed())
    const [brand] = Object.getOwnPropertySymbols(suite)
    if (!brand) throw new Error("Expected a scenario suite brand")

    const values = [
      { label: "Promise", value: Promise.resolve("value") },
      { label: "WeakMap", value: new WeakMap<object, unknown>() },
      { label: "URL", value: new URL("https://example.com") },
    ]

    for (const { label, value } of values) {
      const forged = {
        scenario: () => undefined,
        [brand]: {
          route: "/research",
          scenarios: [
            {
              execution: "in-process",
              expectedStatus: "passed",
              input: value,
              name: label,
              toolCallExpectations: [],
              toolMocks: [],
            },
          ],
        },
      }

      expect(isScenarioSuite(forged), label).toBe(false)
      expect(() => readScenarioSuite(forged), label).toThrow(
        new RegExp(`malformed scenario suite: .*${label}.*not supported`, "i"),
      )
    }
  })

  test("reads immutable snapshots across SDK module instances", async () => {
    const authoredDate = new Date("2026-08-09T12:00:00.000Z")
    const authoredMap = new Map([["entry", { count: 1 }]])
    const authoredSet = new Set(["entry"])
    const authoredPattern = /dawn/gi
    const authoredTyped = new Uint8Array([1, 2, 3])
    const mock = async ({ query }: { readonly query: string }) => ({ results: [query] })
    const assertion = () => "asserted"
    const suite = scenarios("/research").scenario("cross-copy", (s) =>
      s
        .input({
          date: authoredDate,
          map: authoredMap,
          pattern: authoredPattern,
          set: authoredSet,
          typed: authoredTyped,
        })
        .mockTool("searchWeb", mock)
        .expectPassed()
        .assert(assertion),
    )

    authoredDate.setUTCFullYear(2030)
    authoredMap.set("later", { count: 2 })
    authoredSet.add("later")
    authoredPattern.compile("changed")
    authoredTyped.fill(9)

    expect(
      Reflect.get(globalThis, Symbol.for("dawn.scenario-snapshot-proxy-targets")),
    ).toBeUndefined()

    vi.resetModules()
    const secondSdk = await import("../src/testing/index.js")

    expect(secondSdk.isScenarioSuite(suite)).toBe(true)
    const scenario = secondSdk.readScenarioSuite(suite).scenarios[0]
    if (!scenario) throw new Error("Expected a scenario descriptor")
    const snapshot = scenario.input as {
      date: Date
      map: Map<string, { count: number }>
      pattern: RegExp
      set: Set<string>
      typed: Uint8Array
    }

    expect(snapshot.date.toISOString()).toBe("2026-08-09T12:00:00.000Z")
    expect(snapshot.map.get("entry")).toEqual({ count: 1 })
    expect(snapshot.map.has("later")).toBe(false)
    expect([...snapshot.set]).toEqual(["entry"])
    expect(snapshot.pattern.source).toBe("dawn")
    expect(Array.from(snapshot.typed)).toEqual([1, 2, 3])
    expect(() => snapshot.date.setTime(0)).toThrow(/read-only snapshot/i)
    expect(() => Date.prototype.setTime.call(snapshot.date, 0)).toThrow()
    expect(() => snapshot.map.set("mutated", { count: 3 })).toThrow(/read-only snapshot/i)
    expect(() => Map.prototype.set.call(snapshot.map, "mutated", { count: 3 })).toThrow()
    expect(() => snapshot.set.add("mutated")).toThrow(/read-only snapshot/i)
    expect(() => snapshot.typed.fill(0)).toThrow(/read-only snapshot/i)

    const toolMock = scenario.toolMocks[0]
    if (!toolMock) throw new Error("Expected a tool mock")
    await expect(toolMock.implementation({ query: "Dawn" })).resolves.toEqual({
      results: ["Dawn"],
    })
    expect(await scenario.assert?.({} as never)).toBe("asserted")
  })
})
