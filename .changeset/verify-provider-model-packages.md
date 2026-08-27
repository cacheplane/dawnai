---
"@dawn-ai/cli": patch
---

Check the model package each app actually needs in `dawn verify`.

The dependency probe hardcoded `@langchain/openai` and looked for it in the
app's own `node_modules`, which was wrong in both directions.

An app whose routes use Anthropic was told to install `@langchain/openai`, which
it never imports, and was told nothing about `@langchain/anthropic`, which it
does — an optional peer no install step provides, so the app passed verify and
then failed at its first model call. The required package now comes from the
providers the routes use, read from the same provider map `dawn build` uses to
decide which specifiers to bake into an edge bundle.

In the other direction, the probe reported packages that were installed and
working. `@langchain/core`, `@langchain/langgraph` and the provider packages are
imported by `@dawn-ai/langchain`, not by the app, so the walk now starts at that
package — resolving its symlink first — and falls back to the app root. Under
pnpm a package's dependencies sit in the store beside it, reachable from the
importer and deliberately not from the app, so every pnpm-based Dawn app saw
three warnings telling it to install packages it already had.
