import { describe, expect, it } from "vitest"
import { matchPermission } from "../src/pattern-matching.js"

describe("matchPermission", () => {
  it("returns unknown when no entries match", () => {
    expect(matchPermission("bash", "npm install", {}, {})).toBe("unknown")
  })
  it("returns allow when candidate matches an allow prefix", () => {
    expect(matchPermission("bash", "npm install react", { bash: ["npm install"] }, {})).toBe(
      "allow",
    )
  })
  it("returns deny when candidate matches a deny prefix", () => {
    expect(matchPermission("bash", "rm -rf /tmp", {}, { bash: ["rm -rf"] })).toBe("deny")
  })
  it("deny wins over allow when both match", () => {
    expect(matchPermission("bash", "rm -rf /tmp", { bash: ["rm -rf"] }, { bash: ["rm -rf"] })).toBe(
      "deny",
    )
  })
  it("does NOT match an allow entry that is not a prefix", () => {
    expect(matchPermission("bash", "npm test", { bash: ["npm install"] }, {})).toBe("unknown")
  })
  it("treats path candidates with absolute prefixes", () => {
    expect(
      matchPermission("readFile", "/Users/blove/.zshrc", { readFile: ["/Users/blove/"] }, {}),
    ).toBe("allow")
  })
  it("does not cross directory boundary when pattern ends with slash", () => {
    expect(
      matchPermission("readFile", "/var/logger/app.log", { readFile: ["/var/log/"] }, {}),
    ).toBe("unknown")
  })
  it("returns unknown for a tool with no entries in either list", () => {
    expect(
      matchPermission("runUnknownTool", "anything", { bash: ["ls"] }, { writeFile: ["/tmp/"] }),
    ).toBe("unknown")
  })
})

describe('reserved "tool" key uses exact matching', () => {
  it("does not prefix-match tool names", () => {
    expect(matchPermission("tool", "deployProd", { tool: ["deploy"] }, {})).toBe("unknown")
  })
  it("matches an exact tool name", () => {
    expect(matchPermission("tool", "deployProd", { tool: ["deployProd"] }, {})).toBe("allow")
  })
  it("deny wins for an exact tool name", () => {
    expect(
      matchPermission("tool", "deployProd", { tool: ["deployProd"] }, { tool: ["deployProd"] }),
    ).toBe("deny")
  })
  it("commands keep prefix matching", () => {
    expect(matchPermission("bash", "ls -la", { bash: ["ls"] }, {})).toBe("allow")
  })

  it("an empty pattern does not wildcard the tool key (unlike prefix keys)", () => {
    // For prefix-matched keys an empty pattern matches everything; the exact-match
    // carve-out means it can only match an (impossible) empty tool name.
    expect(matchPermission("tool", "deployProd", { tool: [""] }, {})).toBe("unknown")
    expect(matchPermission("bash", "anything", { bash: [""] }, {})).toBe("allow")
  })
})

describe("memory key (prefix + terminator convention)", () => {
  // Callers match memory candidates as `namespace + "|"` so a /a rule can
  // never prefix-match a /ab namespace. matchPermission itself is unchanged.
  const allow = { memory: ["workspace=app|route=/a|"] }

  it("allows the exact route (terminated candidate)", () => {
    expect(matchPermission("memory", "workspace=app|route=/a|", allow, {})).toBe("allow")
  })

  it("allows deeper namespaces under the route", () => {
    expect(
      matchPermission("memory", "workspace=app|route=/a|tenant=acme|", allow, {}),
    ).toBe("allow")
  })

  it("does NOT match a sibling route sharing the prefix", () => {
    expect(matchPermission("memory", "workspace=app|route=/ab|", allow, {})).toBe("unknown")
  })

  it("deny wins over allow for the memory key", () => {
    const deny = { memory: ["workspace=app|route=/a|"] }
    expect(matchPermission("memory", "workspace=app|route=/a|", allow, deny)).toBe("deny")
  })
})
