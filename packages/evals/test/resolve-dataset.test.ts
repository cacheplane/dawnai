import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { resolveDataset } from "../src/resolve-dataset.js"

describe("resolveDataset", () => {
  it("returns inline arrays as-is", async () => {
    expect(await resolveDataset([{ input: "a" }], "/tmp")).toEqual([{ input: "a" }])
  })
  it("awaits a function dataset", async () => {
    expect(await resolveDataset(async () => [{ input: "b" }], "/tmp")).toEqual([{ input: "b" }])
  })
  it("reads a .json array relative to baseDir", async () => {
    const dir = mkdtempSync(join(tmpdir(), "evals-ds-"))
    writeFileSync(join(dir, "cases.json"), JSON.stringify([{ input: "c" }]))
    expect(await resolveDataset("cases.json", dir)).toEqual([{ input: "c" }])
  })
  it("reads a .jsonl file (one case per line)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "evals-ds-"))
    writeFileSync(join(dir, "cases.jsonl"), '{"input":"x"}\n{"input":"y"}\n')
    expect(await resolveDataset("cases.jsonl", dir)).toEqual([{ input: "x" }, { input: "y" }])
  })
  it("throws a clear error for a missing file", async () => {
    await expect(resolveDataset("nope.json", "/tmp")).rejects.toThrow(/nope\.json/)
  })
})
