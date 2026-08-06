---
"@dawn-ai/sdk": patch
"@dawn-ai/core": patch
"@dawn-ai/permissions": patch
"@dawn-ai/langchain": patch
"@dawn-ai/cli": patch
"@dawn-ai/ag-ui": patch
"@dawn-ai/testing": patch
---

Add keyed, parent-owned subagent delegation policies with fail-closed
constraints and approval. Subagents now run as native resumable LangGraph
subgraphs, and interrupt resume uses one complete multi-entry request envelope.

This intentionally removes array-form subagent registration, tool policy on
the internal `task` mechanism, and scalar interrupt resume. Confirm the fixed
0.x patch release intent with Brian before release.
