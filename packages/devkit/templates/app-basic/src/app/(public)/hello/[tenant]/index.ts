import { createAgent } from "langchain"

export const agent = createAgent({
  model: "gpt-4o-mini",
  systemPrompt: "You are a helpful assistant for the {tenant} organization ({plan} plan). Answer questions about the tenant.",
})
