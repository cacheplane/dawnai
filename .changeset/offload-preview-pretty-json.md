---
"@dawn-ai/langchain": patch
---

Tool-output offload stubs now show a readable multi-line preview when the offloaded content is a single-line JSON blob (e.g. a tool that returned an object, whose newlines were escaped). `buildStub` pretty-prints JSON for the preview slice only — the stored file, its content hash, the size threshold, and the tool message content are all unchanged. Plain-text outputs are unaffected.
