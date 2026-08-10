import { scenarios } from "../src/testing/index.js"

declare module "../src/testing/index.js" {
  interface RouteScenarioMap {
    "/research": {
      readonly tools: {
        readonly ping: () => Promise<string>
        readonly searchWeb: (input: { readonly query: string; readonly limit: number }) => Promise<{
          readonly results: readonly string[]
        }>
      }
    }
    "/without-tools": { readonly tools: Record<never, never> }
  }
}

scenarios("/research").scenario("typed", (s) =>
  s
    .input({ any: "shape remains unknown" })
    .mockTool("searchWeb", async ({ query, limit }) => ({
      results: [`${query}:${limit}`],
    }))
    .mockTool("ping", () => "pong")
    .expectPassed()
    .expectOutput({ any: "shape remains unknown" })
    .expectTool("searchWeb", (call) => call.calledOnce().withArgs({ query: "Dawn" }))
    .expectTool("ping", (call) => call.called()),
)

// @ts-expect-error generated route paths are closed.
scenarios("/missing")

// @ts-expect-error a scenario callback must return a builder with input and status set.
scenarios("/research").scenario("missing status", (s) => s.input({}))

// @ts-expect-error a scenario callback must return a builder with input and status set.
scenarios("/research").scenario("missing input", (s) => s.expectPassed())

scenarios("/research").scenario("unknown tool", (s) =>
  s
    .input({})
    // @ts-expect-error only generated application tools are mockable.
    .mockTool("missing", async () => undefined)
    .expectPassed(),
)

scenarios("/research").scenario("wrong input", (s) =>
  s
    .input({})
    // @ts-expect-error mock parameters come from generated tool types.
    .mockTool("searchWeb", async ({ missing }: { missing: boolean }) => {
      void missing
      return { results: [] }
    })
    .expectPassed(),
)

scenarios("/research").scenario("wrong return", (s) =>
  s
    .input({})
    // @ts-expect-error mock returns the awaited generated tool result.
    .mockTool("searchWeb", async () => ({ wrong: true }))
    .expectPassed(),
)

scenarios("/research").scenario("server", (s) => {
  const server = s.input({}).server("http://localhost:3000")
  // @ts-expect-error server scenarios cannot add tool mocks.
  return server.mockTool("searchWeb", async () => ({ results: [] })).expectPassed()
})

scenarios("/research").scenario("mock then server", (s) => {
  const mocked = s.input({}).mockTool("ping", () => "pong")
  // @ts-expect-error mocked scenarios cannot switch to server execution.
  return mocked.server("http://localhost:3000").expectPassed()
})

scenarios("/research").scenario("status-specific expectations", (s) => {
  const passed = s.input({}).expectPassed()
  // @ts-expect-error passing scenarios cannot declare an error expectation.
  passed.expectError({ message: "no" })
  const failed = s.input({}).expectFailed()
  // @ts-expect-error failing scenarios cannot declare an output expectation.
  failed.expectOutput({ no: true })
  return failed.expectError({ message: "expected" })
})

scenarios("/research").scenario("zero args", (s) =>
  s
    .input({})
    .mockTool("ping", () => "pong")
    .expectPassed()
    .expectTool("ping", (call) => {
      // @ts-expect-error zero-argument tools do not expose argument matching.
      call.withArgs(undefined)
      return call.calledOnce()
    }),
)

scenarios("/research").scenario("unmocked expectation", (s) =>
  s
    .input({})
    .mockTool("ping", () => "pong")
    .expectPassed()
    // @ts-expect-error only tools mocked earlier in this scenario are assertable.
    .expectTool("searchWeb", (call) => call.called()),
)

scenarios("/research").scenario("incomplete call expectation", (s) =>
  s
    .input({})
    .mockTool("ping", () => "pong")
    .expectPassed()
    // @ts-expect-error the nested builder must add a count or argument assertion.
    .expectTool("ping", (call) => call),
)

scenarios("/research").scenario("conflicting counts", (s) =>
  s
    .input({})
    .mockTool("ping", () => "pong")
    .expectPassed()
    .expectTool("ping", (call) => {
      const counted = call.calledOnce()
      // @ts-expect-error a tool expectation accepts only one count constraint.
      return counted.calledTimes(2)
    }),
)

scenarios("/research").scenario("duplicate input", (s) => {
  const input = s.input({})
  // @ts-expect-error input is required exactly once.
  return input.input({ again: true }).expectPassed()
})

scenarios("/research").scenario("duplicate status", (s) => {
  const passed = s.input({}).expectPassed()
  // @ts-expect-error expected status is required exactly once.
  return passed.expectFailed()
})

scenarios("/research").scenario("not called with args", (s) =>
  s
    .input({})
    .mockTool("searchWeb", async () => ({ results: [] }))
    .expectPassed()
    .expectTool("searchWeb", (call) => {
      const absent = call.notCalled()
      // @ts-expect-error notCalled cannot be combined with argument matching.
      return absent.withArgs({ query: "Dawn" })
    }),
)

scenarios("/research").scenario("args then not called", (s) =>
  s
    .input({})
    .mockTool("searchWeb", async () => ({ results: [] }))
    .expectPassed()
    .expectTool("searchWeb", (call) => {
      const matched = call.withArgs({ query: "Dawn" })
      // @ts-expect-error argument matching cannot be followed by notCalled.
      return matched.notCalled()
    }),
)

scenarios("/without-tools").scenario("none", (s) => {
  const local = s.input({})
  // @ts-expect-error a route with no application tools has no mockable names.
  return local.mockTool("anything", async () => undefined).expectPassed()
})
