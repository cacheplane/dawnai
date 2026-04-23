import type { BackendAdapter } from "@dawnai.org/sdk"

export function createLangGraphAdapter(kind: "graph" | "workflow"): BackendAdapter {
  return {
    kind,

    async execute(
      entry: unknown,
      input: unknown,
      context: { readonly signal: AbortSignal },
    ): Promise<unknown> {
      if (kind === "workflow") {
        if (typeof entry !== "function") {
          throw new Error("Workflow entry must be a function")
        }
        return await entry(input, { signal: context.signal })
      }

      if (typeof entry === "function") {
        return await entry(input, { signal: context.signal })
      }

      if (
        typeof entry === "object" &&
        entry !== null &&
        "invoke" in entry &&
        typeof (entry as { invoke?: unknown }).invoke === "function"
      ) {
        return await (entry as { invoke: (input: unknown, context: unknown) => unknown }).invoke(
          input,
          { signal: context.signal },
        )
      }

      throw new Error("Graph entry must be a function or expose invoke(input)")
    },

    async *stream(
      entry: unknown,
      input: unknown,
      context: { readonly signal: AbortSignal },
    ): AsyncIterable<unknown> {
      const result = await this.execute(entry, input, context)
      yield result
    },
  }
}

export const graphAdapter = createLangGraphAdapter("graph")
export const workflowAdapter = createLangGraphAdapter("workflow")
