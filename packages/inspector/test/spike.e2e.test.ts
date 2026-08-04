import { join } from "node:path"
import { sqliteMemoryStore } from "@dawn-ai/memory"
import { afterAll, beforeAll, expect, it } from "vitest"
import {
  gated,
  type InspectorServer,
  pkgRoot,
  removeDawnDir,
  resetDawnDir,
  startInspector,
} from "./harness"

const fixtureApp = join(pkgRoot, "test/fixtures/app")

let server: InspectorServer | undefined

beforeAll(async () => {
  if (!gated) return
  resetDawnDir(fixtureApp)
  const store = sqliteMemoryStore({ path: join(fixtureApp, ".dawn", "memory.sqlite") })
  await store.put({
    id: "memory_spike_1",
    kind: "semantic",
    namespace: "route=/notes",
    content: "spike memory row",
    data: { subject: "spike", predicate: "works", value: "yes" },
    source: { type: "tool", id: "remember" },
    confidence: 1,
    tags: [],
    status: "candidate",
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
  })
  server = await startInspector(fixtureApp)
})

afterAll(async () => {
  await server?.stop()
  removeDawnDir(fixtureApp)
})

it.skipIf(!gated)("serves the live config-defined store through the API", async () => {
  const res = await fetch(`${server?.base}/api/memory/list`)
  expect(res.status).toBe(200)
  const body = (await res.json()) as { records: { id: string; content: string }[] }
  expect(body.records.map((r) => r.id)).toContain("memory_spike_1")
})
