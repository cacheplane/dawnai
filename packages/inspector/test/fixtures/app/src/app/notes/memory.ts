// Unused by the Task 1 spike; exercised from Task 6 onward (identity
// resolution loads route memory.ts files through this fixture).
import { z } from "zod"

export default {
  kind: "semantic",
  scope: ["route"],
  schema: z.object({ subject: z.string(), predicate: z.string(), value: z.string() }),
}
