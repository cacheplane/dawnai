import { ChatPromptTemplate } from "@langchain/core/prompts"
import { ChatOpenAI } from "@langchain/openai"
import { convertToolToLangChain } from "@dawn-ai/langchain"

import greet from "./tools/greet.js"

const model = new ChatOpenAI({
  modelName: "gpt-4o-mini",
  temperature: 0,
})

const prompt = ChatPromptTemplate.fromMessages([
  [
    "system",
    "You are a helpful assistant for the {tenant} organization. Use the available tools to look up tenant information before responding.",
  ],
  ["human", "{message}"],
])

const greetTool = convertToolToLangChain({
  name: "greet",
  description: "Look up information about a tenant",
  run: greet,
})

export const chain = prompt.pipe(model.bindTools([greetTool]))
