import type { RuntimeContext, RuntimeTool } from "@dawn/sdk";

import type { HelloState } from "./state.js";

type HelloTools = {
  readonly greet: RuntimeTool<
    { readonly tenant: string },
    { readonly greeting: string }
  >;
};

export async function workflow(
  state: HelloState,
  context: RuntimeContext<HelloTools>,
): Promise<HelloState> {
  const result = await context.tools.greet({ tenant: state.tenant });

  return {
    ...state,
    greeting: result.greeting,
  };
}
