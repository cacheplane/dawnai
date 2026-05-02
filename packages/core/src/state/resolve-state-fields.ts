import type { ResolvedStateField } from "../types.js"

export interface ResolveStateFieldsOptions {
  readonly defaults: ReadonlyMap<string, unknown>
  readonly reducerOverrides: ReadonlyMap<string, (current: unknown, incoming: unknown) => unknown>
}

export function resolveStateFields(
  options: ResolveStateFieldsOptions,
): readonly ResolvedStateField[] {
  const results: ResolvedStateField[] = []

  for (const [name, defaultValue] of options.defaults) {
    const override = options.reducerOverrides.get(name)

    if (override) {
      results.push({ name, reducer: override, default: defaultValue })
    } else {
      const reducer = Array.isArray(defaultValue) ? "append" : "replace"
      results.push({ name, reducer, default: defaultValue })
    }
  }

  results.sort((a, b) => a.name.localeCompare(b.name))
  return results
}
