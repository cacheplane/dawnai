import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { loadFixtures, writeFixtures } from "../src/fixture-file.js"
import { script } from "../src/fixture-builder.js"

let dir = ""
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })
function tmp(): string { dir = mkdtempSync(join(tmpdir(), "dt-fx-")); return dir }

it("writeFixtures + loadFixtures round-trips a script() builder", () => {
  const path = join(tmp(), "x.fixture.json")
  writeFixtures(path, script().user("hi").callsTool("greet", { tenant: "acme" }).replies("hello"))
  expect(loadFixtures(path)).toEqual(script().user("hi").callsTool("greet", { tenant: "acme" }).replies("hello").build())
})
it("writeFixtures accepts a bare FixtureSet", () => {
  const path = join(tmp(), "y.fixture.json")
  const set = [{ match: { userMessage: "a" }, response: { content: "b" } }]
  writeFixtures(path, set as never)
  expect(loadFixtures(path)).toEqual(set)
})
it("loadFixtures reads a bare-array file too", () => {
  const path = join(tmp(), "z.json")
  writeFileSync(path, JSON.stringify([{ match: {}, response: { content: "bare" } }]))
  expect(loadFixtures(path)).toEqual([{ match: {}, response: { content: "bare" } }])
})
it("loadFixtures throws a clear error on a missing file", () => {
  expect(() => loadFixtures("/no/such/file.json")).toThrow(/fixture file/i)
})
it("loadFixtures throws on JSON that isn't fixtures", () => {
  const path = join(tmp(), "bad.json")
  writeFileSync(path, JSON.stringify({ nope: true }))
  expect(() => loadFixtures(path)).toThrow(/fixture/i)
})
