---
"@dawn-ai/sandbox": patch
"@dawn-ai/workspace": patch
"@dawn-ai/core": patch
"@dawn-ai/cli": patch
"@dawn-ai/langchain": patch
---

Add an opt-in execution sandbox: a provider-agnostic `SandboxProvider` contract
with a Docker reference (`dockerSandbox`), giving each conversation thread a
hard-isolated workspace (filesystem + shell + network). Enable via
`dawn.config.ts` `sandbox: { provider: dockerSandbox({ image }) }`; without it,
behavior is unchanged. Adds a typed `config()` helper. When sandboxed, the
materialized agent cache is bypassed so tools bind per-thread. Honest scope:
Docker's boundary (not a microVM); `allow`-mode network denylist is best-effort
in the Docker reference. New package `@dawn-ai/sandbox` (+ `@dawn-ai/sandbox/testing`
`fakeSandbox` and a provider conformance kit).
