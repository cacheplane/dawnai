<p>
  <img src="https://raw.githubusercontent.com/cacheplane/dawnai/main/docs/brand/dawn-logo-horizontal-black-on-white.png" alt="Dawn" width="180" />
</p>

# @dawn-ai/langchain

LangChain backend adapter for Dawn `chain` route kind.

Public surface:
- `ChainAdapter` — `BackendAdapter` implementation for LCEL runnables
- `convertTools()` — converts Dawn tools to LangChain `DynamicStructuredTool`
- `toolLoop()` — Dawn-owned ReAct tool execution loop (no AgentExecutor dependency)

This package enables Dawn routes to use LangChain LCEL chains with filesystem-driven tool discovery and Dawn-owned execution semantics.
