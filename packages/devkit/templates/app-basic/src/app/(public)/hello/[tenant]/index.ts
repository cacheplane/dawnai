import { RunnableLambda } from "@langchain/core/runnables"

import greet from "./tools/greet.js"

const lookupTenant = new RunnableLambda({
  func: async (input: { tenant: string }) => await greet(input),
})

const formatResponse = new RunnableLambda({
  func: (info: { name: string; plan: string }) => ({
    greeting: `Hello, ${info.name}!`,
    tenant: info.name,
  }),
})

export const chain = lookupTenant.pipe(formatResponse)
