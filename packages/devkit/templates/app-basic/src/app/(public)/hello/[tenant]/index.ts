import type { Runnable } from "@langchain/core/runnables"
import { createAgent } from "langchain"

export const agent: Runnable = createAgent({
  model: "gpt-4o-mini",
  systemPrompt:
    "You are a helpful assistant for the {tenant} organization. Answer questions about the tenant.",
  tools: [],
})
