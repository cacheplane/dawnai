import { z } from "zod"

export default z.object({
  /** Accumulated context from tool call results */
  context: z.string().default(""),
})
