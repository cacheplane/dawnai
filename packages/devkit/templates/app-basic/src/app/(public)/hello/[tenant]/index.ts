import { agent } from "@dawn-ai/sdk"

export default agent({
  model: "gpt-5-mini",
  systemPrompt:
    "You are a helpful assistant for the {tenant} organization. Answer questions about the tenant.",
})
