import { defineMemory } from "@dawn-ai/sdk"
import { z } from "zod"

// Long-term, cross-session memory for the note-taking assistant. Durable facts
// are stored via the generated `remember` tool and pulled back with `recall`.
export default defineMemory({
  kind: "semantic",
  scope: ["route"],
  schema: z.object({
    subject: z.string().describe("What the fact is about, e.g. a person, project, or preference"),
    predicate: z.string().describe("The relation, e.g. 'prefers', 'lives_in', 'deadline'"),
    value: z.string().describe("The value of the fact"),
  }),
})
