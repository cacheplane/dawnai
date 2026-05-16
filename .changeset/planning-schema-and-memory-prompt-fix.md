---
"@dawn-ai/core": patch
---

Two fixes surfaced by live LLM smoke testing the chat example end-to-end:

- **Planning `write_todos` now declares a real zod schema.** Previously the tool's `schema` field was undefined; the LangChain bridge fell back to `z.record(z.string(), z.unknown())`, which produced JSON Schema without `properties`. OpenAI strict-mode tool calling rejected the tool with `400 Invalid schema for function 'write_todos': object schema missing properties`. Now the planning marker exports an explicit zod schema for `{ todos: Array<{ content, status }> }`. Adds `zod` as a runtime dependency of `@dawn-ai/core`.
- **`# Memory` block now includes orientation text.** The agents-md prompt fragment used to inject `# Memory\n\n<content>` only. With both planning and memory loaded, the model often called `listDir` and `readFile` to look at AGENTS.md even though Dawn had already injected its contents. The fragment now opens with a short paragraph telling the agent the block IS the memory file, re-rendered each turn, and that the way to update it is `writeFile`. Existing unit tests still pass — the `# Memory` heading and content substrings are unchanged.
