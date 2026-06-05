import { expect, it } from "vitest"
import { script } from "../src/fixture-builder.js"

it("compiles a single-turn tool round to aimock fixtures with auto turnIndex + fixed ids", () => {
  const fixtures = script()
    .user("Filter open items")
    .callsTool("applyFilter", { status: "open" })
    .replies("Found 2.")
    .build()
  expect(fixtures).toEqual([
    {
      match: { userMessage: "Filter open items", turnIndex: 0, hasToolResult: false },
      response: {
        toolCalls: [
          { id: "call_applyFilter_0_0", name: "applyFilter", arguments: { status: "open" } },
        ],
      },
    },
    {
      match: { userMessage: "Filter open items", turnIndex: 1, hasToolResult: true },
      response: { content: "Found 2." },
    },
  ])
})

it("supports a plain reply with no tools", () => {
  expect(script().user("hi").replies("hello").build()).toEqual([
    {
      match: { userMessage: "hi", turnIndex: 0, hasToolResult: false },
      response: { content: "hello" },
    },
  ])
})

it("supports multiple user-turn groups", () => {
  const fixtures = script().user("a").replies("ra").user("b").replies("rb").build()
  expect(fixtures.map((f) => f.match.userMessage)).toEqual(["a", "b"])
  expect(fixtures.every((f) => f.match.turnIndex === 0)).toBe(true)
})

it("honors an explicit tool_call id override", () => {
  const fixtures = script().user("x").callsTool("t", {}, { id: "call_custom" }).build()
  const tc = (fixtures[0].response as { toolCalls: { id: string }[] }).toolCalls[0]
  expect(tc.id).toBe("call_custom")
})

it("throws if a response is added before .user()", () => {
  expect(() => script().replies("oops").build()).toThrow()
})
