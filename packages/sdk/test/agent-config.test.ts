import { describe, expect, expectTypeOf, it } from "vitest"
import {
  agent,
  type DawnAgent,
  type DelegationConstraintPredicate,
  type DelegationContext,
  type DelegationRequest,
  type DelegationVerdict,
  type ReasoningConfig,
} from "../src/index.js"

describe("agent() descriptor — new fields", () => {
  it("preserves an exactly inferred keyed subagent registry and delegation policy", () => {
    const researcher = agent({
      model: "gpt-5-mini",
      systemPrompt: "Research.",
      description: "Does research work",
    })
    const coordinator = agent({
      model: "gpt-5-mini",
      systemPrompt: "Coordinate.",
      subagents: { researcher },
      delegation: {
        default: "deny",
        rules: {
          researcher: {
            action: "constrain",
            predicate: async (request, context) => {
              expectTypeOf(request).toEqualTypeOf<DelegationRequest>()
              expectTypeOf(request.input).toEqualTypeOf<string>()
              expectTypeOf(context).toEqualTypeOf<DelegationContext>()
              expectTypeOf(context.subagentName).toEqualTypeOf<string>()
              return context.signal.aborted ? "cancelled" : true
            },
          },
        },
      },
    })

    expectTypeOf(coordinator.subagents).toEqualTypeOf<
      Readonly<{ researcher: typeof researcher }> | undefined
    >()
    expectTypeOf<
      Awaited<ReturnType<DelegationConstraintPredicate>>
    >().toEqualTypeOf<DelegationVerdict>()
    expect(coordinator.subagents?.researcher).toBe(researcher)
    expect(coordinator.delegation).toEqual({
      default: "deny",
      rules: { researcher: { action: "constrain", predicate: expect.any(Function) } },
    })
    expect(researcher.description).toBe("Does research work")
  })

  it("rejects unknown rule keys and named rules without an explicit registry", () => {
    const researcher = agent({ model: "gpt-5-mini", systemPrompt: "Research." })

    agent({
      model: "gpt-5-mini",
      systemPrompt: "Invalid.",
      subagents: { researcher },
      delegation: {
        rules: {
          // @ts-expect-error writer is not a registered key
          writer: { action: "allow" },
        },
      },
    })

    agent({
      model: "gpt-5-mini",
      systemPrompt: "Invalid.",
      delegation: {
        rules: {
          // @ts-expect-error named rules require an explicit keyed registry
          researcher: { action: "allow" },
        },
      },
    })
  })

  it("rejects array registries and malformed or multi-action rules", () => {
    const researcher = agent({ model: "gpt-5-mini", systemPrompt: "Research." })

    agent({
      model: "gpt-5-mini",
      systemPrompt: "Invalid.",
      // @ts-expect-error arrays are not supported
      subagents: [researcher],
    })

    agent({
      model: "gpt-5-mini",
      systemPrompt: "Invalid.",
      subagents: { researcher },
      delegation: {
        rules: {
          // @ts-expect-error constrain rules require a predicate
          researcher: { action: "constrain" },
        },
      },
    })

    agent({
      model: "gpt-5-mini",
      systemPrompt: "Invalid.",
      subagents: { researcher },
      delegation: {
        rules: {
          // @ts-expect-error allow rules cannot also define a constraint predicate
          researcher: { action: "allow", predicate: () => true },
        },
      },
    })
  })

  it("keeps broad descriptor fields available", () => {
    expectTypeOf<DawnAgent["description"]>().toEqualTypeOf<string | undefined>()
  })

  it("exports reasoning config used by agent descriptors", () => {
    expectTypeOf<ReasoningConfig["effort"]>().toEqualTypeOf<
      "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | undefined
    >()
    expectTypeOf<DawnAgent["reasoning"]>().toEqualTypeOf<ReasoningConfig | undefined>()
  })

  it("omitting description, subagents, and delegation still works", () => {
    const a = agent({ model: "gpt-5", systemPrompt: "x" })
    expect(a.description).toBeUndefined()
    expect(a.subagents).toBeUndefined()
    expect(a.delegation).toBeUndefined()
  })
})
