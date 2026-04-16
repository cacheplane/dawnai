import { defineTool, type ToolDefinition } from "@dawn/sdk";

export default defineTool({
  name: "greet",
  run: async (input: unknown) => {
    const { tenant } = input as { readonly tenant: string }

    return {
      greeting: `Hello, ${tenant}!`,
    }
  },
} satisfies ToolDefinition<
  { readonly tenant: string },
  { readonly greeting: string }
>);
