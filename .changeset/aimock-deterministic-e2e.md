---
"@dawn-ai/langchain": patch
---

Offloaded tool-output filenames are now deterministic — keyed on the originating `tool_call_id` (with a content-hash fallback when absent) instead of `timestamp+random`. This makes offloaded paths stable and traceable and enables deterministic agent e2e tests. The openai chat model now also honors `OPENAI_BASE_URL`, allowing a local mock provider (used by the new CI-safe aimock-based agent e2e regression tests for the discriminated-union tool-input and tool-output-offload-retrieval paths).
