import { agent } from "@dawn-ai/sdk"

export default agent({
  model: "gpt-5-mini",
  systemPrompt:
    "You are a sandbox smoke agent. When asked to identify the sandbox, call runBash with `id -u && hostname` and reply with its exact stdout.",
})
