---
"@dawn-ai/cli": patch
"@dawn-ai/langchain": patch
---

**A Dawn app now serves more than one request per isolate on Cloudflare
workerd.** Three defects, each found only by running the whole thing inside real
workerd, and none of them fixed by reaching for `nodejs_compat`.

- **The bundle did not link**, from one specifier and it was Dawn's own.
  `@dawn-ai/langchain` imported `dispatchCustomEvent` from
  `@langchain/core/callbacks/dispatch`, whose entry statically imports
  `node:async_hooks` in order to infer the config off `AsyncLocalStorage` when a
  caller omits one. Both Dawn call sites already pass an explicit config, which
  is exactly what upstream's `.../dispatch/web` entry requires, so the swap
  changes no behavior — and on Node the same `AsyncLocalStorage` instance is
  still installed by `@langchain/langgraph`'s main entry.
- **Every request after the first threw** `Cannot perform I/O on behalf of a
  different request`. On workerd an `AbortController` is an I/O object owned by
  the request that constructed it, and the runtime handler is necessarily
  constructed inside request one because global scope refuses to construct one at
  all — so a handler-scoped shutdown controller limited an isolate to exactly one
  request. The shutdown signal is now minted per request, with `close()` aborting
  the live set and every "are we shutting down?" check reading a plain value.
  Node semantics are unchanged: the same abort, and the same drain across
  in-flight requests, the run registry, and pending store disposals.
- **The model had no credential.** A turn returned HTTP 200 carrying a
  well-formed stream whose only content was a missing-credentials run error:
  `OPENAI_BASE_URL` already went through the runtime-env seam, but each provider
  package reads its API key off `process.env`, and there is no `process` on
  workerd. `createChatModel` now resolves each provider's key through the same
  seam — a no-op on Node, where the seam prefers `process.env`.

Two tests come with them. The gated `edge-workerd` lane drives four sequential
AG-UI turns through the emitted artifacts under `wrangler dev --local` against
Postgres, asserting on the reply text rather than the status, because a dead
model wiring still answers 200. Its cheap ungated counterpart bundles the emitted
`app.mjs` the way `wrangler` does — Workers export conditions, nothing external
but `node:` itself — and requires zero `node:` specifiers; the existing purity
gate externalizes `@langchain/*`, which is precisely why the first defect above
reached the runtime unseen.
