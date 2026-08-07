---
"@dawn-ai/langchain": patch
---

The compiled-graph cache now honors a per-request checkpointer. `createReactAgent`
embeds the checkpointer in the graph it returns, and the cache was keyed on the
agent descriptor alone — so on a runtime that builds stores per request, every
request after the one that first materialized a route ran its graph against that
first request's checkpointer, which had since been disposed. On Cloudflare workerd
a connection is bound to the I/O context of the request that opened it, so this
would have hung for ~30s on alternating requests.

The key is now the pair (descriptor, checkpointer). Node behavior is unchanged: an
app with one boot-resolved checkpointer still compiles each agent's graph once per
process. Because a request's stores are built and disposed together, keying on the
checkpointer also rebinds the tools that close over that request's permissions and
memory stores.
