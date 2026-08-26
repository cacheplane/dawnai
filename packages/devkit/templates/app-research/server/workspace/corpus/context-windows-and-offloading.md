# Context windows and tool-output offloading

A model's context window is the finite budget of tokens it can attend to in a
single turn: the system prompt, the conversation history, retrieved documents,
and tool results all compete for the same space. When that budget is exceeded,
something must give — older turns get summarized, retrieved context gets
truncated, or tool outputs get displaced. Managing the window deliberately is
one of the highest-leverage things an agent framework can do.

Tool outputs are a common cause of context blowups. A single tool call that
returns a large file, a long search result, or a multi-thousand-row report can
consume a large fraction of the window in one shot, pushing out the very
history the model needs to stay coherent. Naively, you either cap tool outputs
(losing information) or let them flood the window (losing coherence).

Offloading is a middle path. When a tool result exceeds a size threshold, the
framework writes the full output to durable storage and replaces it in-context
with a short stub: a preview of the first few lines plus a handle the model can
use to read the full content back on demand. The model sees that the data
exists and where to find it, but only pays the token cost of the slice it
actually needs. Retrieval tools that read the offloaded content back are
exempted from offloading, so reading a stub does not immediately re-offload it.

Offloading composes well with summarization. Summarization compresses the
*conversation* — older turns are folded into a running summary once the thread
grows long — while offloading compresses individual *tool results* at the
moment they are produced. Together they keep the window focused on what the
model needs now while preserving the ability to recover detail later. A good
default: offload large tool outputs aggressively, summarize conversations only
once they cross a token threshold, and always keep the most recent turns
verbatim so the model never loses its immediate working context.

The practical guidance: measure where your tokens go, offload the outputs that
are large-but-rarely-needed-in-full, summarize long histories, and keep
retrieval cheap so the model can pull detail back when a stub is not enough.
