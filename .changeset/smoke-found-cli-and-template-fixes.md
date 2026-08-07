---
"@dawn-ai/cli": patch
"@dawn-ai/devkit": patch
---

Fix two defects found smoke-testing the published 0.8.17 artifacts.

**`dawn memory` subcommand flags were rejected by the CLI.** `memory` is registered as
`memory [subcommand] [args...]`, and commander claimed every `--flag` after the
subcommand for itself — so each one failed with `error: unknown option` before the
handler that parses it ever ran. This made every documented subcommand flag unusable
from the real CLI: `prune --cap`, `prune --namespace`, and all five distillation flags
(`--dry-run`, `--namespace`, `--model`, `--provider`, `--max-batches`), including the
`--dry-run` the cron recipe recommends for a zero-cost plan. The `prune` flags have been
broken since they were introduced; the distillation flags since 0.8.17.

The command now uses `passThroughOptions()` (with `enablePositionalOptions()` on the
program, which commander requires for it). The flags reached the handler correctly all
along — the repo's tests called `runMemoryCommand([...])` directly and so never crossed
commander's parsing layer. Added tests that drive the real program.

**A fresh `create-dawn-ai-app` research app failed `npm test` out of the box.** The
research template's `test/research.test.ts.template` is kept byte-identical to the
dogfooded `examples/research/server/test/research.test.ts`, but the Memory Inspector
change that reworded CLI approve output to `approved <id> (activated)` updated only the
example. The template kept asserting `Approved: <id>`, so the default template — the one
whose generated README tells users to run `npm test` — shipped a failing suite from
0.8.14 through 0.8.17. Fixed the assertion and added a parity test asserting the shared
test files stay identical, so the example can no longer be fixed without the template.
