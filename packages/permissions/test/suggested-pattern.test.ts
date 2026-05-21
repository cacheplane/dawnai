import { describe, expect, it } from "vitest"
import {
  suggestedCommandPattern,
  suggestedPathPattern,
} from "../src/suggested-pattern.js"

describe("suggestedCommandPattern", () => {
  it("returns the first two tokens for a multi-word command", () => {
    expect(suggestedCommandPattern("npm install react")).toBe("npm install")
  })
  it("returns the single token for a one-word command", () => {
    expect(suggestedCommandPattern("ls")).toBe("ls")
  })
  it("returns first two tokens even when the second is short", () => {
    expect(suggestedCommandPattern("git status")).toBe("git status")
    expect(suggestedCommandPattern("git push origin main")).toBe("git push")
  })
  it("strips leading/trailing whitespace before tokenizing", () => {
    expect(suggestedCommandPattern("  npm  install  react  ")).toBe("npm install")
  })
  it("handles empty input as empty pattern", () => {
    expect(suggestedCommandPattern("")).toBe("")
    expect(suggestedCommandPattern("   ")).toBe("")
  })
})

describe("suggestedPathPattern", () => {
  it("returns the parent directory with trailing slash", () => {
    expect(suggestedPathPattern("/Users/blove/.zshrc")).toBe("/Users/blove/")
    expect(suggestedPathPattern("/var/log/app.log")).toBe("/var/log/")
  })
  it("returns the dir itself with trailing slash when input ends with slash", () => {
    expect(suggestedPathPattern("/Users/blove/Documents/")).toBe("/Users/blove/Documents/")
  })
  it("returns root when input is a top-level file", () => {
    expect(suggestedPathPattern("/etc")).toBe("/")
  })
  it("handles relative paths", () => {
    expect(suggestedPathPattern("notes/agenda.md")).toBe("notes/")
  })
})
