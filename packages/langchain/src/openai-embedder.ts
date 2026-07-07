import type { Embedder } from "@dawn-ai/core"

const DIMS: Record<string, number> = {
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
}

/** OpenAI embedder over the shared OPENAI_BASE_URL seam (aimock-mockable). */
export function openaiEmbedder(opts?: {
  readonly model?: string
  readonly importer?: (s: string) => Promise<Record<string, unknown>>
}): Embedder {
  const model = opts?.model ?? "text-embedding-3-small"
  const importer = opts?.importer ?? ((s: string) => import(s) as Promise<Record<string, unknown>>)
  let clientP: Promise<{ embedDocuments(t: string[]): Promise<number[][]> }> | undefined
  async function client() {
    if (!clientP) {
      clientP = importer("@langchain/openai").then((m) => {
        const Ctor = m.OpenAIEmbeddings as new (
          o: Record<string, unknown>,
        ) => {
          embedDocuments(t: string[]): Promise<number[][]>
        }
        const baseURL = process.env.OPENAI_BASE_URL
        return new Ctor({
          model,
          // Request float arrays explicitly. The OpenAI SDK defaults to base64
          // encoding for embeddings; pinning "float" avoids base64 decode
          // interop quirks (some mocks/proxies return a byte length that decodes
          // to the wrong dimension) and yields the model's true dimensionality.
          encodingFormat: "float",
          ...(baseURL ? { configuration: { baseURL } } : {}),
        })
      })
    }
    return clientP
  }
  return {
    id: `openai:${model}`,
    dims: DIMS[model] ?? 1536,
    async embed(texts) {
      if (texts.length === 0) return []
      const c = await client()
      const raw = await c.embedDocuments([...texts])
      return raw.map((v) => Float32Array.from(v))
    },
  }
}
