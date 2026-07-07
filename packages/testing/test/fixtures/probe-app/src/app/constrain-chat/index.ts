import { agent } from "@dawn-ai/sdk"
export default agent({
  model: "gpt-4o-mini",
  systemPrompt: "You are a test agent. Use deployProd when asked to deploy.",
  tools: {
    constrain: {
      deployProd: (args) => {
        const env = (args as { env?: string }).env
        if (env === "staging") return true
        if (env === "prod") return { approve: true }
        return "Only staging or prod are valid environments."
      },
    },
  },
})
