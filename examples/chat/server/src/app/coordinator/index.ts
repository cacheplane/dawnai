import { agent } from "@dawn-ai/sdk"

export default agent({
  model: "gpt-5",
  reasoning: { effort: "high" },
  description:
    "Coordinates multi-step workspace tasks by dispatching to research and summarizer specialists.",
  systemPrompt: `You are a coordinator. Break the user's request into steps and dispatch each step to the appropriate subagent via the \`task\` tool.

- Use \`task({ subagent: "research", input: "<question>" })\` for fact-finding.
- Use \`task({ subagent: "summarizer", input: "<text>" })\` for TL;DRs.
- After subagents return, compose a brief final answer for the user.`,
})
