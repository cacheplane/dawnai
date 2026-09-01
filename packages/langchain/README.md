# @dawn-ai/langchain

LangChain adapters for materializing Dawn agents and chains, converting tools, streaming, embeddings, and retry.

**Use this when:** You are materializing or extending Dawn's LangChain agent and chain bridge. Application routes normally declare agents through [`@dawn-ai/sdk`](https://www.npmjs.com/package/@dawn-ai/sdk) and let the runtime use this layer.

## Install

```bash
pnpm add @dawn-ai/langchain @langchain/core @langchain/langgraph-checkpoint
```

Install the optional LangChain provider package selected by your agents. `@langchain/openai` is included; Anthropic, Google, Mistral, Groq, Ollama, xAI, and OpenRouter integrations are optional peers.

## Example

```ts
import { chainAdapter, openaiEmbedder } from "@dawn-ai/langchain"

export const adapter = chainAdapter
export const embedder = openaiEmbedder({ model: "text-embedding-3-small" })
```

`chainAdapter` adapts a LangChain runnable to Dawn's chain backend contract. `openaiEmbedder` supplies the memory embedding seam and reads provider configuration when first used.

## Runtime and stability

- `@dawn-ai/langchain` is an edge-safe, supported integration surface.
- Edge-safe describes Dawn's emitted edge target; it is not a promise that every provider integration, application tool, or dynamically loaded package is browser-portable.
- `@dawn-ai/langchain/package.json` exposes package metadata for tooling, not runtime code.

## Related

- [`@dawn-ai/sdk`](https://www.npmjs.com/package/@dawn-ai/sdk) — author-facing agent and chain declarations.
- [`@dawn-ai/langgraph`](https://www.npmjs.com/package/@dawn-ai/langgraph) — raw graph and workflow route adapters.
- [LangChain API reference](https://dawnai.org/docs/api/langchain) — full exports, peers, and runtime contracts.
- [Agents guide](https://dawnai.org/docs/agents) — define application agents through the author-facing API.

## Maturity and support

This package is pre-1.0 and releases in Dawn's fixed package group. Review the [changelog](https://github.com/cacheplane/dawnai/blob/main/packages/langchain/CHANGELOG.md) before upgrading. For support, [open an issue](https://github.com/cacheplane/dawnai/issues).

## License

MIT. See the [repository license](https://github.com/cacheplane/dawnai/blob/main/LICENSE).
