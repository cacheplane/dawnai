<p align="center">
  <img src="https://raw.githubusercontent.com/cacheplane/dawnai/main/docs/brand/dawn-logo-horizontal-black-on-white.png" alt="Dawn" width="180" />
</p>

# @dawn-ai/langchain

LangChain backend adapters for Dawn, the TypeScript meta-framework for LangGraph. Dawn uses this package to materialize `chain` routes and provider-aware `agent` routes — handling tool conversion, streaming, and retry.

`agent()` materialization resolves a LangChain chat model from the route descriptor. Dawn includes `@langchain/openai` for the default/backcompat path and lazy-loads optional provider packages when an agent selects or infers another provider.

## Optional provider integrations

Install the provider packages your agents use, as needed:

```bash
pnpm add @langchain/anthropic     # anthropic
pnpm add @langchain/google-genai  # google
pnpm add @langchain/mistralai     # mistral
pnpm add @langchain/groq          # groq
pnpm add @langchain/ollama        # ollama
pnpm add @langchain/xai           # xai
pnpm add @langchain/openrouter    # openrouter
```

## Documentation

- [Routes](https://dawn-ai.org/docs/routes)
- [Getting started](https://dawn-ai.org/docs/getting-started)

---

⭐ [Star Dawn on GitHub](https://github.com/cacheplane/dawnai) · 📚 [Read the docs](https://dawn-ai.org/docs/getting-started) · 💬 [Ask in GitHub Discussions](https://github.com/cacheplane/dawnai/discussions)

## License

MIT
