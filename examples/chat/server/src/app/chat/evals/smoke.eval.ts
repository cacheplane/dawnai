import { contains, defineEval } from "@dawn-ai/evals"
import { script } from "@dawn-ai/testing"

export default defineEval({
  name: "chat smoke",
  dataset: [
    {
      name: "greets the user",
      input: "hello",
      fixtures: script().user("hello").replies("Hi! How can I help?"),
    },
  ],
  scorers: [contains("help", { threshold: 1 })],
  threshold: 1,
})
