---
"@dawn-ai/sdk": patch
"@dawn-ai/cli": patch
---

Wire `DAWN_E` error codes into `dawn verify`'s runtime preflight. Add
`DAWN_E5101` ("Node version below the supported floor") to the error-code
registry, and surface it (or `DAWN_E2002` for an unreachable sandbox daemon)
on a failed `dawn verify` runtime check — in both the CLI's `[CODE] See <docs>`
line and the `--json` output's `runtime.node.code` / `runtime.docker.code`
fields.
