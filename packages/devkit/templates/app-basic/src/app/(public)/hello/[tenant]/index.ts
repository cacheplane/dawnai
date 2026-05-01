import { RunnableLambda } from "@langchain/core/runnables"

import greet from "./tools/greet.js"

export const chain = new RunnableLambda({
  func: async (input: { tenant: string }) => {
    return await greet(input)
  },
})
