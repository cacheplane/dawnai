export interface ToolNameCheckInput {
  readonly userTools: ReadonlyArray<{ readonly name: string }>
  readonly capabilityTools: ReadonlyArray<{ readonly name: string }>
  readonly reservedNames: ReadonlySet<string>
}

export type ToolNameCheckResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string }

export function checkToolNameUniqueness(input: ToolNameCheckInput): ToolNameCheckResult {
  const capNames = new Set(input.capabilityTools.map((t) => t.name))
  for (const t of input.userTools) {
    if (capNames.has(t.name)) {
      return {
        ok: false,
        message: `Capability conflict: tool name "${t.name}" is contributed by a capability and also defined in tools/. Remove the user tool or remove the capability marker file.`,
      }
    }
    if (input.reservedNames.has(t.name)) {
      return {
        ok: false,
        message: `Reserved tool name: "${t.name}" is reserved by the Dawn harness and cannot be used as a user tool name.`,
      }
    }
  }
  return { ok: true }
}
