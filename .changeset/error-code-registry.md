---
"@dawn-ai/sdk": patch
"@dawn-ai/cli": patch
"@dawn-ai/core": patch
"@dawn-ai/sandbox": patch
"@dawn-ai/langchain": patch
---

Add a central `DAWN_Exxxx` error-code registry in `@dawn-ai/sdk` and surface
codes on the failure channels. `CliError` now carries an optional `code` and the
CLI prints `[CODE] See <docs>`; HTTP/SSE error bodies gain optional `code`/`docsUrl`;
permission denials returned as tool results are prefixed with `[DAWN_E3001]`.
The high-value families are wired (`dawn check` config errors, sandbox
unavailable, permission denied, missing model provider / unknown model id, and
tool-file shape errors), and a generated `/docs/errors` reference page is guarded
against drift. Additive and backward-compatible.
