import { z } from "zod"

export default {
  kind: "semantic",
  scope: ["route"],
  schema: z.object({ subject: z.string(), predicate: z.string(), value: z.string() }),
}
