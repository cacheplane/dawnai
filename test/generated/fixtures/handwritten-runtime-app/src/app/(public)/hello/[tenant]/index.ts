import type { RuntimeContext } from "@dawn-ai/sdk"

import type { HelloState } from "./state.js"

export const graph = {
  invoke: async (state: HelloState, _ctx: RuntimeContext): Promise<HelloState> => {
    return { ...state, greeting: `Hello, ${state.tenant}!` }
  },
}
