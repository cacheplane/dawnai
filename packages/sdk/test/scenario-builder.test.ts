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
})
