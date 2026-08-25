import { z } from "zod"

export default z.object({
  /** Accumulated research context from tool and subagent results. */
  context: z.string().default(""),
})
