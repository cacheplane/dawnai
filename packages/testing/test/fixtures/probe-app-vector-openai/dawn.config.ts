// Vector-enabled sibling of probe-app-vector that wires the REAL openaiEmbedder
// (from @dawn-ai/langchain, a normal workspace dep) instead of the inline fake.
// This exists purely for the gated live smoke: it proves real embeddings
// surface a cross-vocabulary semantic match that the fake token-hash embedder
// cannot. In live mode the harness sets OPENAI_BASE_URL to aimock's proxy, so
// openaiEmbedder's calls flow through to the real OpenAI embeddings endpoint.
import { openaiEmbedder } from "@dawn-ai/langchain"

export default {
  memory: { writes: "auto", vector: { embedder: openaiEmbedder() } },
}
