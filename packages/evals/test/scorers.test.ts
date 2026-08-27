import { spawnSync } from "node:child_process"
import type { AgentRunResult } from "@dawn-ai/testing"
import { describe, expect, it } from "vitest"
import { createSafeRegexTester } from "../src/regex-safety.js"
import { normalizeScore } from "../src/score.js"
import {
  contains,
  custom,
  exactMatch,
  jsonEquals,
  regex,
  tokensUnder,
  toolCalled,
} from "../src/scorers.js"

const REGEX_TIMEOUT_PROBE = `
const { createSafeRegexTester } = await import(process.argv[1])

try {
  createSafeRegexTester(/(a|aa)+$/u)("a".repeat(40) + "!")
  process.stdout.write(JSON.stringify({ result: "completed" }))
} catch (error) {
  process.stdout.write(
    JSON.stringify({
      name: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message : String(error),
    }),
  )
}
`

function run(partial: Partial<AgentRunResult>): AgentRunResult {
  return {
    finalMessage: "",
    messages: [],
    toolCalls: [],
    toolResults: [],
    tokens: [],
    state: {},
    threadId: "t",
    interrupts: [],
    planUpdates: [],
    todos: [],
    subagents: [],
    subagentEvents: [],
    systemPrompt: "",
    ...partial,
  }
}

const noCase = { input: "" }

describe("built-in scorers", () => {
  it("contains scores 1 when finalMessage includes the substring, else 0", async () => {
    expect(
      normalizeScore(await contains("Found").score(run({ finalMessage: "Found 2" }), noCase)).score,
    ).toBe(1)
    expect(
      normalizeScore(await contains("Found").score(run({ finalMessage: "none" }), noCase)).score,
    ).toBe(0)
  })
  it("regex matches finalMessage", async () => {
    expect(
      normalizeScore(await regex(/\d+ items/).score(run({ finalMessage: "3 items" }), noCase))
        .score,
    ).toBe(1)
  })
  it("exactMatch compares finalMessage to case.expected", async () => {
    expect(
      normalizeScore(
        await exactMatch().score(run({ finalMessage: "ok" }), { input: "", expected: "ok" }),
      ).score,
    ).toBe(1)
    expect(
      normalizeScore(
        await exactMatch().score(run({ finalMessage: "ok" }), { input: "", expected: "no" }),
      ).score,
    ).toBe(0)
  })
  it("jsonEquals deep-compares parsed finalMessage to case.expected", async () => {
    const r = run({ finalMessage: '{"a":1,"b":[2,3]}' })
    expect(
      normalizeScore(await jsonEquals().score(r, { input: "", expected: { a: 1, b: [2, 3] } }))
        .score,
    ).toBe(1)
  })
  it("toolCalled scores 1 when the named tool was called", async () => {
    const r = run({ toolCalls: [{ name: "applyFilter", args: { status: "open" } }] })
    expect(normalizeScore(await toolCalled("applyFilter").score(r, noCase)).score).toBe(1)
    expect(
      normalizeScore(
        await toolCalled("applyFilter", { withArgs: { status: "open" } }).score(r, noCase),
      ).score,
    ).toBe(1)
    expect(
      normalizeScore(
        await toolCalled("applyFilter", { withArgs: { status: "closed" } }).score(r, noCase),
      ).score,
    ).toBe(0)
    expect(normalizeScore(await toolCalled("missing").score(r, noCase)).score).toBe(0)
  })
  it("tokensUnder scores 1 when streamed token count is under the budget", async () => {
    expect(
      normalizeScore(await tokensUnder(5).score(run({ tokens: ["a", "b"] }), noCase)).score,
    ).toBe(1)
    expect(
      normalizeScore(await tokensUnder(1).score(run({ tokens: ["a", "b"] }), noCase)).score,
    ).toBe(0)
  })
  it("custom wraps an async function and carries name + threshold", async () => {
    const s = custom(async (r) => (r.toolCalls.length <= 2 ? 1 : 0), {
      name: "few-tools",
      threshold: 1,
    })
    expect(s.name).toBe("few-tools")
    expect(s.threshold).toBe(1)
    expect(normalizeScore(await s.score(run({}), noCase)).score).toBe(1)
  })
})

describe("regex scorer safety policy", () => {
  it("preserves ordinary alternation semantics", async () => {
    const scorer = regex(/^(a|b)+$/u)

    expect(normalizeScore(await scorer.score(run({ finalMessage: "abba" }), noCase)).score).toBe(1)
    expect(normalizeScore(await scorer.score(run({ finalMessage: "abca" }), noCase)).score).toBe(0)
  })

  it("rejects oversized final messages before evaluation", () => {
    const scorer = regex(/^a+$/u)
    const scoreOversizedMessage = () =>
      scorer.score(run({ finalMessage: "a".repeat(65_537) }), noCase)

    expect(scoreOversizedMessage).toThrow(RangeError)
    expect(scoreOversizedMessage).toThrow(
      "Regular expression input exceeds 65536 UTF-16 code units",
    )
  })

  it.each([
    { expected: 1, input: "12 ITEMS", name: "matching input" },
    { expected: 0, input: "none", name: "non-matching input" },
  ])("preserves ordinary flags and scoring semantics for $name", async ({ expected, input }) => {
    const scorer = regex(/\d+ items/iu)

    expect(normalizeScore(await scorer.score(run({ finalMessage: input }), noCase)).score).toBe(
      expected,
    )
  })

  it("retains the validated pattern after caller-owned expression mutation", async () => {
    const expression = /^safe$/iu
    const scorer = regex(expression)

    RegExp.prototype.compile.call(expression, "^(a+)+$", "u")

    expect(normalizeScore(await scorer.score(run({ finalMessage: "SAFE" }), noCase)).score).toBe(1)
  })

  it.each([
    { createExpression: () => /items/gu, name: "global" },
    { createExpression: () => /items/uy, name: "sticky" },
  ])(
    "keeps $name expressions deterministic without changing caller state",
    async ({ createExpression }) => {
      const expression = createExpression()
      expression.lastIndex = 2
      const scorer = regex(expression)
      const score = async () =>
        normalizeScore(await scorer.score(run({ finalMessage: "items" }), noCase)).score

      expect(await score()).toBe(1)
      expect(await score()).toBe(1)
      expect(expression.lastIndex).toBe(2)
    },
  )
})

describe("private regex safety adapter", () => {
  it("interrupts catastrophic matching with the exact bounded error", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        REGEX_TIMEOUT_PROBE,
        new URL("../src/regex-safety.ts", import.meta.url).href,
      ],
      {
        encoding: "utf8",
        killSignal: "SIGKILL",
        timeout: 2_000,
      },
    )

    expect(result.error).toBeUndefined()
    expect(result.signal).toBeNull()
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      message: "Regular expression evaluation exceeded 100ms execution limit",
      name: "RangeError",
    })
  })

  it("rejects sources over 4,096 UTF-16 code units with the exact error", () => {
    const createTester = () => createSafeRegexTester(new RegExp("a".repeat(4_097), "u"))

    expect(createTester).toThrow(RangeError)
    expect(createTester).toThrow("Regular expression source exceeds 4096 UTF-16 code units")
  })

  it("accepts sources at the 4,096-code-unit boundary", () => {
    expect(() => createSafeRegexTester(new RegExp("a".repeat(4_096), "u"))).not.toThrow()
  })

  it("snapshots source and flags through intrinsic RegExp accessors", () => {
    class RegExpWithThrowingAccessors extends RegExp {
      override get source(): string {
        throw new Error("caller source getter must not run")
      }

      override get flags(): string {
        throw new Error("caller flags getter must not run")
      }
    }

    const expression = new RegExpWithThrowingAccessors("^safe$", "iu")
    const test = createSafeRegexTester(expression)

    expect(test("SAFE")).toBe(true)
  })

  it("rejects RegExp proxies without invoking their property traps", () => {
    let propertyReads = 0
    const expression = new Proxy(/^safe$/u, {
      get(target, property) {
        propertyReads += 1
        return Reflect.get(target, property, target)
      },
    })

    expect(() => createSafeRegexTester(expression)).toThrow(TypeError)
    expect(propertyReads).toBe(0)
  })

  it.each([
    { expected: true, input: "12 ITEMS", name: "matching input" },
    { expected: false, input: "none", name: "non-matching input" },
  ])("preserves ordinary flags for $name", ({ expected, input }) => {
    const test = createSafeRegexTester(/\d+ items/iu)

    expect(test(input)).toBe(expected)
  })

  it("accepts 65,536 UTF-16 code units", () => {
    const test = createSafeRegexTester(/^a+$/u)

    expect(test("a".repeat(65_536))).toBe(true)
  })

  it("rejects 65,537 UTF-16 code units with the exact error", () => {
    const test = createSafeRegexTester(/^a+$/u)
    const testOversizedInput = () => test("a".repeat(65_537))

    expect(testOversizedInput).toThrow(RangeError)
    expect(testOversizedInput).toThrow("Regular expression input exceeds 65536 UTF-16 code units")
  })

  it("retains the validated source and flags after caller-owned expression mutation", () => {
    const expression = /^safe$/iu
    const test = createSafeRegexTester(expression)

    RegExp.prototype.compile.call(expression, "^(a+)+$", "u")
    expression.lastIndex = 2

    expect(test("SAFE")).toBe(true)
    expect(test("SAFE")).toBe(true)
    expect(expression.lastIndex).toBe(2)
  })

  it.each([
    { expression: /items/gu, name: "global" },
    { expression: /items/uy, name: "sticky" },
  ])("keeps $name expressions deterministic without changing caller state", ({ expression }) => {
    expression.lastIndex = 2
    const test = createSafeRegexTester(expression)

    expect(test("items")).toBe(true)
    expect(test("items")).toBe(true)
    expect(expression.lastIndex).toBe(2)
  })
})
