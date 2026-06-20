import { agent } from "@dawn-ai/sdk"
export default agent({
  model: "gpt-4o-mini",
  systemPrompt:
    "You are a second test agent with its own long-term memory. Use remember/recall when asked.",
})
