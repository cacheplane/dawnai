---
"@dawn-ai/cli": patch
"@dawn-ai/devkit": patch
"@dawn-ai/testing": patch
"create-dawn-ai-app": patch
---

Improve the default scaffold and packaged external verification.

The research scaffold now dogfoods reviewable memory and the Docker sandbox,
shared scaffold tools can run through sandbox-aware workspace APIs, generated
apps use pnpm 11 build policy in `pnpm-workspace.yaml`, and packaged scaffold
tests install the current packed devkit templates instead of stale registry
contents.
