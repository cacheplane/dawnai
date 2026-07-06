import { agent } from "@dawn-ai/sdk"
export default agent({
  model: "gpt-4o-mini",
  systemPrompt: "You are a worker. Use sendReport when asked.",
  tools: { approve: ["sendReport"] },
})
