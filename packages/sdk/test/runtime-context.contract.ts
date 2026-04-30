import type { RuntimeContext, RuntimeTool, ToolRegistry } from "@dawn-ai/sdk"

const _registry: ToolRegistry = {}
void _registry

const _tool: RuntimeTool<{ name: string }, { greeting: string }> = async (input) => ({
  greeting: `hi ${input.name}`,
})
void _tool

const _context: RuntimeContext<{
  readonly greet: RuntimeTool<{ readonly name: string }, { readonly greeting: string }>
}> = {
  signal: new AbortController().signal,
  tools: {
    greet: async (input) => ({ greeting: `hi ${input.name}` }),
  },
}
void _context
