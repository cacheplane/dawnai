import type { RuntimeContext, RuntimeTool, ToolRegistry, WorkspaceFs } from "@dawn-ai/sdk"

const _registry: ToolRegistry = {}
void _registry

const _tool: RuntimeTool<{ name: string }, { greeting: string }> = async (input) => ({
  greeting: `hi ${input.name}`,
})
void _tool

const _fs: WorkspaceFs = {
  readFile: async () => "",
  readBinaryFile: async () => Uint8Array.from([]),
  writeFile: async () => ({ bytesWritten: 0 }),
  listDir: async () => [],
}

const _context: RuntimeContext<{
  readonly greet: RuntimeTool<{ readonly name: string }, { readonly greeting: string }>
}> = {
  signal: new AbortController().signal,
  tools: {
    greet: async (input) => ({ greeting: `hi ${input.name}` }),
  },
  fs: _fs,
}
void _context
