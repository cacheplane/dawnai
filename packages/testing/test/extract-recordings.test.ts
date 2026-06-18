import { describe, expect, it } from "vitest"
import { extractRecordings, type JournalEntryLike } from "../src/extract-recordings.js"

const proxyText: JournalEntryLike = {
  body: { messages: [{ role: "user", content: "hello" }] },
  response: { source: "proxy", fixture: { match: {}, response: { content: "Hi" } } },
}
const proxyToolCall: JournalEntryLike = {
  body: { messages: [{ role: "user", content: "greet" }] },
  response: {
    source: "proxy",
    fixture: {
      match: {},
      response: { toolCalls: [{ id: "call_x", name: "greet", arguments: { a: 1 } }] },
    },
  },
}
const matchedFixture: JournalEntryLike = {
  body: { messages: [{ role: "user", content: "hello" }] },
  response: {
    source: "fixture",
    fixture: { match: { userMessage: "hello" }, response: { content: "served" } },
  },
}

describe("extractRecordings", () => {
  it("keeps only proxied entries (drops fixture-served calls)", () => {
    const out = extractRecordings([proxyText, matchedFixture])
    expect(out).toHaveLength(1)
    expect(out[0]?.response).toEqual({ content: "Hi" })
  })

  it("maps a toolCalls fixture response to our AimockResponse", () => {
    const [rec] = extractRecordings([proxyToolCall])
    expect(rec?.response).toEqual({
      toolCalls: [{ id: "call_x", name: "greet", arguments: { a: 1 } }],
    })
    expect(rec?.request.messages?.[0]).toEqual({ role: "user", content: "greet" })
  })

  it("drops proxied entries with a null fixture (nothing to bake)", () => {
    const out = extractRecordings([
      { body: { messages: [] }, response: { source: "proxy", fixture: null } },
    ])
    expect(out).toEqual([])
  })
})
