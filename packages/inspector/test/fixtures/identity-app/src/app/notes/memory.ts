import { z } from "zod"

// identity: ["subject"] (NOT the [subject, predicate] default) — a candidate
// sharing only the subject with an active row must still supersede it.
export default {
  kind: "semantic",
  scope: ["route"],
  schema: z.object({ subject: z.string(), predicate: z.string(), value: z.string() }),
  identity: ["subject"],
}
