import { defineMemory } from "@dawn-ai/sdk"
import { z } from "zod"

// Long-term, cross-session memory for the research assistant. The agent stores
// durable facts (sources vetted, user preferences, domain findings) via the
// generated `remember` tool and pulls them back with `recall`.
export default defineMemory({
  kind: "semantic",
  scope: ["workspace", "route"],
  schema: z.object({
    subject: z.string().describe("What the fact is about, e.g. a source, topic, or preference"),
    predicate: z.string().describe("The relation, e.g. 'is_credible', 'prefers', 'concluded'"),
    value: z.string().describe("The value of the fact"),
  }),
})
