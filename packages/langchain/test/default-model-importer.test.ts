import { describe, expect, test } from "vitest"

import { defaultModelImporter as nodeDefaultModelImporter } from "../src/default-model-importer.js"
import { defaultModelImporter as staticDefaultModelImporter } from "../src/static-model-importer.js"

describe("default model importer branches", () => {
  test("the ordinary Node default dynamically imports a runtime specifier", async () => {
    const module = await nodeDefaultModelImporter(
      "data:text/javascript,export const branch = 'node-default'",
    )

    expect(module.branch).toBe("node-default")
  })

  test("the static branch explains model construction before provider seeding", async () => {
    await expect(staticDefaultModelImporter("@langchain/openai")).rejects.toThrow(
      /@langchain\/openai.*before.*provider importer.*module scope/is,
    )
  })
})
