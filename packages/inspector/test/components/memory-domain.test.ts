import { describe, expect, it } from "vitest"
import {
  isMemoryKind,
  isMemoryStatus,
  KINDS,
  STATUSES,
} from "../../src/components/memory/memory-domain"

describe("memory domain sets", () => {
  it("spells out every status and kind the store defines", () => {
    expect([...STATUSES]).toEqual(["candidate", "active", "superseded"])
    expect([...KINDS]).toEqual(["semantic", "episodic", "procedural", "reflection"])
  })

  it("guards accept members and reject anything else", () => {
    expect(isMemoryStatus("candidate")).toBe(true)
    expect(isMemoryStatus("actve")).toBe(false)
    expect(isMemoryKind("reflection")).toBe(true)
    expect(isMemoryKind("")).toBe(false)
  })
})
