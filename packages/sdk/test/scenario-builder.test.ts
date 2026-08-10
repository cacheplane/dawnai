import { describe, expect, test } from "vitest"

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
      const forged = { [brand]: payload }
      expect(isScenarioSuite(forged), label).toBe(false)
      expect(() => readScenarioSuite(forged), label).toThrow(
        new RegExp(`malformed scenario suite: .*${label}.*index 0`, "i"),
      )
    }
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
})
