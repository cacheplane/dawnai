import { agent } from "@dawn-ai/sdk"
export default agent({
  model: "gpt-4o-mini",
  systemPrompt: "You are a test agent. Use deployProd when asked to deploy.",
  tools: { approve: ["deployProd"] },
})
