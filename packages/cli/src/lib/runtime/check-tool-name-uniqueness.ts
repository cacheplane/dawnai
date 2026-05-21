export interface ToolNameCheckInput {
  readonly userTools: ReadonlyArray<{ readonly name: string }>
  readonly capabilityTools: ReadonlyArray<{
    readonly name: string
    readonly overridable?: boolean
  }>
  readonly reservedNames: ReadonlySet<string>
}

export type ToolNameCheckResult =
  | {
      readonly ok: true
      /**
       * Capability tools with overridable entries removed when shadowed by
       * a user tool. The runtime should use THIS list when composing the
       * final tool set, not the input `capabilityTools`.
       */
      readonly effectiveCapabilityTools: ReadonlyArray<{
        readonly name: string
        readonly overridable?: boolean
      }>
    }
  | { readonly ok: false; readonly message: string }

export function checkToolNameUniqueness(input: ToolNameCheckInput): ToolNameCheckResult {
  const userNames = new Set(input.userTools.map((t) => t.name))
  const effective: Array<{ readonly name: string; readonly overridable?: boolean }> = []

  for (const cap of input.capabilityTools) {
    if (userNames.has(cap.name)) {
      if (cap.overridable) {
        // User tool wins; drop the capability tool from the effective set.
        continue
      }
      return {
        ok: false,
        message: `Capability conflict: tool name "${cap.name}" is contributed by a capability and also defined in tools/. Remove the user tool or remove the capability marker file.`,
      }
    }
    effective.push(cap)
  }

  for (const t of input.userTools) {
    if (input.reservedNames.has(t.name)) {
      return {
        ok: false,
        message: `Reserved tool name: "${t.name}" is reserved by the Dawn harness and cannot be used as a user tool name.`,
      }
    }
  }

  return { ok: true, effectiveCapabilityTools: effective }
}
