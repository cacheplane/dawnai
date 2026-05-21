import { describe, expect, it } from "vitest"
import { matchPermission } from "../src/pattern-matching.js"

describe("matchPermission", () => {
  it("returns unknown when no entries match", () => {
    expect(matchPermission("bash", "npm install", {}, {})).toBe("unknown")
  })
  it("returns allow when candidate matches an allow prefix", () => {
    expect(matchPermission("bash", "npm install react", { bash: ["npm install"] }, {})).toBe("allow")
  })
  it("returns deny when candidate matches a deny prefix", () => {
    expect(matchPermission("bash", "rm -rf /tmp", {}, { bash: ["rm -rf"] })).toBe("deny")
  })
  it("deny wins over allow when both match", () => {
    expect(matchPermission("bash", "rm -rf /tmp", { bash: ["rm -rf"] }, { bash: ["rm -rf"] })).toBe("deny")
  })
  it("does NOT match an allow entry that is not a prefix", () => {
    expect(matchPermission("bash", "npm test", { bash: ["npm install"] }, {})).toBe("unknown")
  })
  it("treats path candidates with absolute prefixes", () => {
    expect(matchPermission("readFile", "/Users/blove/.zshrc", { readFile: ["/Users/blove/"] }, {})).toBe("allow")
  })
  it("does not cross directory boundary when pattern ends with slash", () => {
    expect(matchPermission("readFile", "/var/logger/app.log", { readFile: ["/var/log/"] }, {})).toBe("unknown")
  })
  it("returns unknown for a tool with no entries in either list", () => {
    expect(matchPermission("runUnknownTool", "anything", { bash: ["ls"] }, { writeFile: ["/tmp/"] })).toBe("unknown")
  })
})
