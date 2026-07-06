# Smarter recall — DX draft

> Draft developer-experience narrative for the smarter-recall feature
> (spec: `docs/superpowers/specs/2026-07-05-smarter-recall-design.md`).
> Written from the seat of a Dawn app developer. The acceptance bar at the
> bottom is the DX contract the implementation must meet.

## Where you start (nothing new to learn)

You already have a route with memory:

```ts
// src/app/support/memory.ts
import { defineMemory } from "@dawn-ai/sdk"
import { z } from "zod"
export default defineMemory({
  kind: "semantic",
  scope: ["workspace", "route"],
  schema: z.object({ subject: z.string(), predicate: z.string(), value: z.string() }),
})
```

Your agent has been running for weeks. It has remembered ~30 facts about
`acme`: billing thresholds, contacts, preferences, an escalation policy, a
note about invoice formatting.

## The sharp edge you'd hit today

A user asks: "what's acme's billing escalation threshold?" The agent calls:

```ts
recall({ query: "acme billing escalation threshold" })
```

Today the store finds every memory sharing any word with that query — then
returns the most recently written ones. If yesterday the agent stored "acme's
contact prefers Slack," that fact outranks the six-week-old billing threshold,
because recency is the only ranking signal. With `limit: 8` and 30 acme facts,
the right answer can fall off the page entirely. Nobody files this as a bug
against their own code — it reads as "my agent's memory is flaky."

## What changes: nothing — and that's the point

No changes to `memory.ts`, no config, no re-index. After upgrading, the same
`recall` call ranks by a blend:

| Signal | Weight | What it means for your facts |
|---|---|---|
| Relevance | 0.6 | Matching rare, specific words ("threshold", "escalation") counts far more than ubiquitous ones ("acme", present in all 30 facts, decides nothing) |
| Recency | 0.3 | Newer facts get a nudge; the boost halves every 14 days |
| Confidence | 0.1 | The `confidence` the agent stored finally matters |

The six-week-old billing threshold now wins because it matches the query's
informative words. The Slack-preference fact still surfaces instantly when
someone asks about contact preferences — that's when its words are the rare
ones.

## The one behavior shift worth knowing: confidence is live

`remember({ data, confidence: 0.6 })` used to be decorative. Now a hedged fact
ranks slightly below a certain one, all else equal. If the route's system
prompt tells the agent to store guesses with low confidence, "best answer
first" falls out for free. At 10% weight it breaks ties — it will not bury a
relevant fact.

## Tuning — only if you need it

```ts
// dawn.config.ts — every field optional, all defaulted
export default {
  memory: {
    recall: {
      weights: { relevance: 0.6, recency: 0.3, confidence: 0.1 },
      recencyHalfLifeMs: 14 * 24 * 60 * 60 * 1000,
      candidatePool: 256,
    },
  },
} satisfies import("@dawn-ai/core").DawnConfig
```

When to touch each knob:

- **Fast-moving domains** (facts stale in days): shorten `recencyHalfLifeMs`
  or bump `weights.recency`.
- **Archival domains** (old facts stay true): drop recency toward 0 — ranking
  becomes almost purely best-match.
- **Huge namespaces** (thousands of facts per route): raise `candidatePool` —
  only the 256 most recent token-matches are scored by default.

A custom `memory.store` bypasses all of this — it owns its own ranking.

## What you can rely on not changing

- The prompt index (`# Long-Term Memory` hint) — still the most recent 20.
  A table of contents, not a search result.
- `dawn memory` CLI — candidate review unchanged.
- Determinism — same store contents + same query → same order, every run.
  aimock fixtures and `dawn eval` replays do not churn. No clock in the
  library: recall uses the request timestamp; direct store calls fall back to
  data-derived time.
- Cross-route isolation, write governance, supersession — untouched.

## Testing recall quality in your app

Deterministic, no live model:

```ts
import { seedMemory } from "@dawn-ai/testing"

await seedMemory({ path: ".dawn/memory.sqlite" }, [
  { id: "m_thresh",  namespace: "workspace=app|route=/support",
    content: "acme escalates billing above 500 dollars", status: "active" },
  { id: "m_contact", namespace: "workspace=app|route=/support",
    content: "acme contact jordan prefers slack", status: "active" },
])
// eval: query the threshold, expect m_thresh ranked first
// scorer: memoryRecalled(["m_thresh"])
```

## Debugging: "why did recall return X above Y?"

Three questions, in order:

1. **Which query words are rare in this namespace?** They decide relevance.
   If every fact mentions "acme", the word "acme" decides nothing.
2. **How old is each fact?** A 14-day-old fact carries half the recency boost
   of one written today.
3. **What confidence was stored?** `dawn memory inspect <id>`.

If the wrong fact still wins, the usual root cause is the memory's *content* —
a vague `content` string ("note about acme billing stuff") gives the ranker
vague tokens. Better remembered summaries → better recall. That prompt-side
lever already existed; ranking makes it pay off.

## DX summary / acceptance bar

**Recall goes from "most recent match" to "best answer" with zero config,
zero migration, zero test churn — knobs exist only for the day you need
them.**

If a developer has to do anything to benefit, or any existing fixture breaks,
the implementation has missed the DX target.
