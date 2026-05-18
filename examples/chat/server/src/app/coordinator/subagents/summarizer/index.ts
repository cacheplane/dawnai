import { agent } from "@dawn-ai/sdk"

export default agent({
  model: "gpt-5-mini",
  description:
    "Summarizes the input text into 2-3 bullet points. Use when the user asks for a TL;DR.",
  systemPrompt: `You are a summarization subagent. Given input text, output 2-3 short bullets that capture the most important content.

- Bullet points only.
- No preamble.
- Keep each bullet under 25 words.`,
})
