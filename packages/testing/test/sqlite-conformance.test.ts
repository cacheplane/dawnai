import { sqliteMemoryStore } from "@dawn-ai/memory"
import { describe } from "vitest"
import { runMemoryStoreConformance } from "../src/memory-conformance.js"

runMemoryStoreConformance({
  name: "sqliteMemoryStore",
  makeStore: () => sqliteMemoryStore({ path: ":memory:" }),
  describe,
})
