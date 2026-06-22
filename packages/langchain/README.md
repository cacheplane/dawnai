<p align="center">
  <img src="https://raw.githubusercontent.com/cacheplane/dawnai/main/docs/brand/dawn-logo-horizontal-black-on-white.png" alt="Dawn" width="180" />
</p>

# @dawn-ai/langchain

LangChain backend adapters for Dawn, the TypeScript meta-framework for LangGraph that lets you build LangGraph agents like Next.js apps. Dawn uses this package to materialize `chain` routes and provider-aware `agent` routes — handling tool conversion, streaming, and retry.

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

- [Routes](https://dawnai.org/docs/routes)
- [Getting started](https://dawnai.org/docs/getting-started)

---

⭐ [Star Dawn on GitHub](https://github.com/cacheplane/dawnai) · 📚 [Read the docs](https://dawnai.org/docs/getting-started) · 💬 [Ask in GitHub Discussions](https://github.com/cacheplane/dawnai/discussions)

## License

MIT
