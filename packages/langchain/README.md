<p align="center">
  <img src="https://raw.githubusercontent.com/cacheplane/dawnai/main/docs/brand/dawn-logo-horizontal-black-on-white.png" alt="Dawn" width="180" />
</p>

# @dawn-ai/langchain

LangChain backend adapters Dawn uses to materialize `chain` routes and provider-aware `agent` routes (tool conversion, streaming, retry).

`agent()` materialization resolves a LangChain chat model from the route descriptor. Dawn includes `@langchain/openai` for the default/backcompat path and lazy-loads optional provider packages when an agent selects or infers another provider.

Install optional provider integrations in applications as needed:

```bash
pnpm add @langchain/anthropic
pnpm add @langchain/google-genai
pnpm add @langchain/openrouter
```

This is an internal Dawn workspace package. For Dawn documentation, see <https://github.com/cacheplane/dawnai/tree/main/apps/web/content/docs>.

## License

MIT
