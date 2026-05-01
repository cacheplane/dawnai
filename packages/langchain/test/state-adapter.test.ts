import { describe, expect, test } from "vitest"

import { materializeStateSchema } from "../src/state-adapter"

describe("materializeStateSchema", () => {
  test("produces an annotation root with messages + custom fields", () => {
    const fields = [
      { name: "context", reducer: "replace" as const, default: "" },
      { name: "results", reducer: "append" as const, default: [] },
    ]

    const annotation = materializeStateSchema(fields)

    expect(annotation).toBeDefined()
    expect(annotation.spec).toBeDefined()
    expect("messages" in annotation.spec).toBe(true)
    expect("context" in annotation.spec).toBe(true)
    expect("results" in annotation.spec).toBe(true)
  })

  test("returns annotation with messages when no custom fields", () => {
    const annotation = materializeStateSchema([])

    expect(annotation.spec).toBeDefined()
    expect("messages" in annotation.spec).toBe(true)
  })

  test("handles custom function reducer", () => {
    const customReducer = (current: unknown, incoming: unknown) => incoming
    const fields = [
      { name: "data", reducer: customReducer, default: null },
    ]

    const annotation = materializeStateSchema(fields)
    expect(annotation.spec).toBeDefined()
    expect("data" in annotation.spec).toBe(true)
  })
})
