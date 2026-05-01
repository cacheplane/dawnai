import { Annotation, MessagesAnnotation } from "@langchain/langgraph"

export interface ResolvedStateField {
  readonly name: string
  readonly reducer: "append" | "replace" | ((current: unknown, incoming: unknown) => unknown)
  readonly default: unknown
}

export function materializeStateSchema(
  fields: readonly ResolvedStateField[],
) {
  const spec: Record<string, unknown> = {
    ...MessagesAnnotation.spec,
  }

  for (const field of fields) {
    if (typeof field.reducer === "function") {
      spec[field.name] = Annotation({
        reducer: field.reducer as (left: unknown, right: unknown) => unknown,
        default: () => field.default,
      })
    } else if (field.reducer === "append") {
      spec[field.name] = Annotation({
        reducer: (prev: unknown[], next: unknown) => [
          ...(prev ?? []),
          ...(Array.isArray(next) ? next : [next]),
        ],
        default: () => (field.default ?? []) as unknown[],
      })
    } else {
      spec[field.name] = Annotation({
        reducer: (_: unknown, next: unknown) => next,
        default: () => field.default,
      })
    }
  }

  return Annotation.Root(spec as any)
}
