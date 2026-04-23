import type { RuntimeContext } from "@dawnai.org/sdk"

import type { HelloState } from "./state.js"

export const graph = {
  invoke: async (state: HelloState, _ctx: RuntimeContext): Promise<HelloState> => {
    return { ...state, greeting: `Hello, ${state.tenant}!` }
  },
}
