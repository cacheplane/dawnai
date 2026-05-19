---
"@dawn-ai/sdk": minor
"@dawn-ai/langchain": minor
---

Add provider-aware agent materialization. Agent configs can now carry an optional `provider`, and the LangChain runtime infers providers for known model families or lazy-loads the explicit provider integration package for built-in provider IDs.
