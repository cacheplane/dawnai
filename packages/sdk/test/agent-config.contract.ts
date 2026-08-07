import {
  agent,
  type DawnAgent,
  type DelegationConstraintPredicate,
  type DelegationContext,
  type DelegationRequest,
  type DelegationVerdict,
  type ReasoningConfig,
} from "@dawn-ai/sdk"

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? true
    : false

type Expect<Value extends true> = Value

const researcher = agent({ model: "gpt-5-mini", systemPrompt: "Research." })

const coordinator = agent({
  model: "gpt-5-mini",
  systemPrompt: "Coordinate.",
  subagents: { researcher },
  delegation: {
    default: "deny",
    rules: {
      researcher: {
        action: "constrain",
        predicate: async (request, context) =>
          context.signal.aborted || request.input.length === 0 ? "cancelled" : true,
      },
    },
  },
})

type _ExactRegistry = Expect<
  Equal<typeof coordinator.subagents, Readonly<{ researcher: typeof researcher }> | undefined>
>
type _ConstraintRequest = Expect<
  Equal<Parameters<DelegationConstraintPredicate>[0], DelegationRequest>
>
type _ConstraintContext = Expect<
  Equal<Parameters<DelegationConstraintPredicate>[1], DelegationContext>
>
type _RequestShape = Expect<Equal<DelegationRequest, { readonly input: string }>>
type _ContextShape = Expect<
  Equal<
    DelegationContext,
    {
      readonly parentRouteId: string
      readonly subagentName: string
      readonly subagentRouteId: string
      readonly threadId?: string
      readonly params?: Readonly<Record<string, string>>
      readonly signal: AbortSignal
    }
  >
>
type _ConstraintVerdict = Expect<
  Equal<Awaited<ReturnType<DelegationConstraintPredicate>>, DelegationVerdict>
>
type _VerdictShape = Expect<
  Equal<DelegationVerdict, true | string | { readonly approve: true; readonly reason?: string }>
>
type _Description = Expect<Equal<DawnAgent["description"], string | undefined>>
type _ReasoningEffort = Expect<
  Equal<
    ReasoningConfig["effort"],
    "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | undefined
  >
>
type _AgentReasoning = Expect<Equal<DawnAgent["reasoning"], ReasoningConfig | undefined>>

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

void coordinator
