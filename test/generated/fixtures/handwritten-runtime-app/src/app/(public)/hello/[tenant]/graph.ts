import { defineEntry } from "@dawn/langgraph"

import type { HelloState } from "./state.js"

const entry = defineEntry({
  graph: async (state: HelloState): Promise<HelloState> => ({
    ...state,
    greeting: `Hello, ${state.tenant}!`,
  }),
})

export const graph = entry.graph
