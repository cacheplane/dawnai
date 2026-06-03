# Tool-Output Offload Exemption for Retrieval Tools (Bugfix Design)

**Status:** Approved for planning
**Date:** 2026-06-03
**Type:** Bugfix on sub-project 6a (tool-output offloading, PR #186)

## Problem

Offloading (sub-project 6a) intercepts every tool's output via `offload(content, tool.name)` in `convertToolToLangChain` and, when over the threshold, replaces it with a pointer+preview stub. But the **retrieval path is itself a tool** — the workspace `readFile` — whose entire job is to return the (large) offloaded content. So when the agent reads back an offloaded file, `readFile`'s output exceeds the threshold and is **offloaded again** into a new stub. The agent can never actually see the retrieved content: every read produces another pointer. The feature defeats itself.

Confirmed by a live-API smoke (real model, chat example): `generateReport` offloaded correctly, the agent then called `readFile(path)` exactly as intended, and the result was a *second* offload stub (`tool-outputs/readFile-….txt`) instead of the report. The agent gave up without finding the embedded needle.

The 6a unit/integration tests missed this because the integration test called `readFile` directly rather than through the agent's tool-dispatch wrapper where offloading is applied.

## Goal

Exempt retrieval/inspection tools from offloading so the agent can read back offloaded content, while still offloading genuinely large outputs from other tools (`runBash`, user tools).

## Design

**Exemption set.** A set of tool names whose output is never offloaded. The effective set is:

```
{ "readFile", "listDir" }  ∪  (dawn.config.toolOutput.noOffloadTools ?? [])
```

- `readFile` and `listDir` are **always** exempt (built-in defaults), regardless of config — exempting `readFile` is mandatory for retrieval correctness; a user list can only *add* exemptions, never remove these.
- `listDir` is exempt as an inspection tool whose output is meant to be consumed directly (and re-offloading a listing is the same circular trap).
- `runBash`, `writeFile`, and user-authored tools remain subject to offloading. `runBash` in particular is a prime offload target.

**Where applied.** Inside the `OffloadFn` closure constructed in `packages/cli/src/lib/runtime/execute-route.ts` (where the offloader is already built with the workspace backend, threshold, and GC config). The closure gains a guard before delegating to `offloadToolOutput`:

```ts
const exempt = new Set<string>(["readFile", "listDir", ...(toolOutput.noOffloadTools ?? [])])
const offload: OffloadFn = async (content, toolName) => {
  if (exempt.has(toolName)) return content
  return offloadToolOutput(content, { toolName, thresholdChars, previewLines, store })
}
```

`packages/langchain/src/tool-converter.ts` is **unchanged** — it still calls `offload(content, tool.name)` for every tool. Mechanism stays in tool-converter; policy lives in the execute-route closure.

**Config.** Add to the `DawnConfig.toolOutput` object in `packages/core/src/types.ts`:

```ts
/** Tool names whose output is never offloaded. Merged with the built-in
 *  defaults (readFile, listDir), which are always exempt. */
readonly noOffloadTools?: readonly string[]
```

## Out of scope

- **Preview-shows-1-line cosmetic issue** (the preview is computed on the JSON-stringified content, so multi-line text previews as one line). It does not block retrieval — the agent gets the path and reads the file regardless. Tracked as a separate minor follow-up.
- Ranged/paginated `readFile`. Not needed; full-content retrieval works once exempt.
- Changing the offload threshold, GC, or storage behavior.

## Testing

**Unit** (`packages/cli` or `packages/langchain`, wherever the closure construction is unit-testable; if the closure is inline in execute-route, extract a small pure `buildOffloadFn({ exemptTools, ... })` helper so it can be tested directly):
- exempt tool name → content returned unchanged even when length > threshold.
- non-exempt tool name over threshold → offloaded (stub returned).
- `noOffloadTools` from config is honored; `readFile`/`listDir` always present even if config omits them or provides an unrelated list.

**Live re-smoke (the real proof, run manually with a real key):** in the chat example, a tool returns a >40k-char output → offloaded; the agent calls `readFile(path)` → receives the **full** content (not a second stub) → locates the `MARKER-DEEP-INSIDE-NEEDLE-42` token that lives at the end of the file (beyond any preview), proving full retrieval.
