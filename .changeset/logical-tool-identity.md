---
"@dawn-ai/langchain": patch
---

Key root AG-UI/Agent-Protocol tool events by the model's tool-call ID
(logical identity) whenever the model provides one, instead of the internal
execution run ID. Interrupted-and-resumed tool calls now re-emit under the
same ID, so standard AG-UI clients converge them into a single tool card
instead of showing a duplicate. Streams without model tool-call IDs keep the
previous behavior.
