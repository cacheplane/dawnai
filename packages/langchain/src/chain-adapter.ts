import type { BackendAdapter } from "@dawnai.org/sdk"

interface RunnableLike {
  readonly invoke: (input: unknown, options?: { signal?: AbortSignal }) => Promise<unknown>
  readonly stream: (
    input: unknown,
    options?: { signal?: AbortSignal },
  ) => Promise<AsyncIterable<unknown>> | AsyncIterable<unknown>
}

function assertRunnableLike(entry: unknown): asserts entry is RunnableLike {
  if (
    typeof entry !== "object" ||
    entry === null ||
    !("invoke" in entry) ||
    typeof (entry as { invoke?: unknown }).invoke !== "function"
  ) {
    throw new Error("Chain entry must expose invoke(input) — expected a LangChain Runnable")
  }
}

export const chainAdapter: BackendAdapter = {
  kind: "chain",

  async execute(
    entry: unknown,
    input: unknown,
    context: { readonly signal: AbortSignal },
  ): Promise<unknown> {
    assertRunnableLike(entry)
    return await entry.invoke(input, { signal: context.signal })
  },

  async *stream(
    entry: unknown,
    input: unknown,
    context: { readonly signal: AbortSignal },
  ): AsyncIterable<unknown> {
    assertRunnableLike(entry)

    if (typeof entry.stream !== "function") {
      yield await entry.invoke(input, { signal: context.signal })
      return
    }

    const streamResult = entry.stream(input, { signal: context.signal })
    const iterable = streamResult instanceof Promise ? await streamResult : streamResult

    for await (const chunk of iterable) {
      yield chunk
    }
  },
}
