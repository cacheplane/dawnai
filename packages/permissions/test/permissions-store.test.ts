import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createPermissionsStore } from "../src/permissions-store.js"

describe("createPermissionsStore — load + match", () => {
  let appRoot: string
  beforeEach(() => {
    appRoot = mkdtempSync(join(tmpdir(), "dawn-perms-"))
  })
  afterEach(() => {
    rmSync(appRoot, { recursive: true, force: true })
  })

  it("returns unknown when no file and no config", async () => {
    const store = createPermissionsStore({ appRoot, config: undefined, mode: "interactive" })
    await store.load()
    expect(store.match("bash", "npm install")).toBe("unknown")
  })

  it("matches entries from .dawn/permissions.json", async () => {
    mkdirSync(join(appRoot, ".dawn"), { recursive: true })
    writeFileSync(
      join(appRoot, ".dawn", "permissions.json"),
      JSON.stringify({ version: 1, allow: { bash: ["npm install"] }, deny: {} }),
    )
    const store = createPermissionsStore({ appRoot, config: undefined, mode: "interactive" })
    await store.load()
    expect(store.match("bash", "npm install react")).toBe("allow")
    expect(store.match("bash", "rm -rf /")).toBe("unknown")
  })

  it("merges config + runtime file (both contribute allows)", async () => {
    mkdirSync(join(appRoot, ".dawn"), { recursive: true })
    writeFileSync(
      join(appRoot, ".dawn", "permissions.json"),
      JSON.stringify({ version: 1, allow: { bash: ["ls"] }, deny: {} }),
    )
    const store = createPermissionsStore({
      appRoot,
      config: { version: 1, allow: { bash: ["npm install"] }, deny: {} },
      mode: "interactive",
    })
    await store.load()
    expect(store.match("bash", "ls -la")).toBe("allow")
    expect(store.match("bash", "npm install react")).toBe("allow")
  })

  it("deny from config wins over allow from runtime file", async () => {
    mkdirSync(join(appRoot, ".dawn"), { recursive: true })
    writeFileSync(
      join(appRoot, ".dawn", "permissions.json"),
      JSON.stringify({ version: 1, allow: { bash: ["rm"] }, deny: {} }),
    )
    const store = createPermissionsStore({
      appRoot,
      config: { version: 1, allow: {}, deny: { bash: ["rm -rf"] } },
      mode: "interactive",
    })
    await store.load()
    expect(store.match("bash", "rm -rf /tmp")).toBe("deny")
  })

  it("ignores the runtime file in non-interactive mode", async () => {
    mkdirSync(join(appRoot, ".dawn"), { recursive: true })
    writeFileSync(
      join(appRoot, ".dawn", "permissions.json"),
      JSON.stringify({ version: 1, allow: { bash: ["npm install"] }, deny: {} }),
    )
    const store = createPermissionsStore({
      appRoot,
      config: { version: 1, allow: { bash: ["ls"] }, deny: {} },
      mode: "non-interactive",
    })
    await store.load()
    expect(store.match("bash", "npm install react")).toBe("unknown")
    expect(store.match("bash", "ls -la")).toBe("allow")
  })

  it("ignores everything in bypass mode", async () => {
    mkdirSync(join(appRoot, ".dawn"), { recursive: true })
    writeFileSync(
      join(appRoot, ".dawn", "permissions.json"),
      JSON.stringify({ version: 1, allow: {}, deny: { bash: ["rm"] } }),
    )
    const store = createPermissionsStore({
      appRoot,
      config: { version: 1, allow: {}, deny: { bash: ["rm"] } },
      mode: "bypass",
    })
    await store.load()
    expect(store.match("bash", "rm -rf /")).toBe("unknown")
  })

  it("throws on malformed JSON in the runtime file", async () => {
    mkdirSync(join(appRoot, ".dawn"), { recursive: true })
    writeFileSync(join(appRoot, ".dawn", "permissions.json"), "{ not valid json")
    const store = createPermissionsStore({ appRoot, config: undefined, mode: "interactive" })
    await expect(store.load()).rejects.toThrow(/permissions\.json/i)
  })
})

describe("createPermissionsStore — addAllow", () => {
  let appRoot: string
  beforeEach(() => {
    appRoot = mkdtempSync(join(tmpdir(), "dawn-perms-"))
  })
  afterEach(() => {
    rmSync(appRoot, { recursive: true, force: true })
  })

  it("persists an allow entry and updates the in-memory cache atomically", async () => {
    const store = createPermissionsStore({ appRoot, config: undefined, mode: "interactive" })
    await store.load()
    expect(store.match("bash", "npm install")).toBe("unknown")
    await store.addAllow("bash", "npm install")
    expect(store.match("bash", "npm install react")).toBe("allow")
    const raw = readFileSync(join(appRoot, ".dawn", "permissions.json"), "utf8")
    const parsed = JSON.parse(raw)
    expect(parsed.allow.bash).toContain("npm install")
  })

  it("appends .dawn/ to .gitignore on first write (idempotent)", async () => {
    writeFileSync(join(appRoot, ".gitignore"), "node_modules/\n.next/\n")
    const store = createPermissionsStore({ appRoot, config: undefined, mode: "interactive" })
    await store.load()
    await store.addAllow("bash", "ls")
    const gi = readFileSync(join(appRoot, ".gitignore"), "utf8")
    expect(gi).toContain(".dawn/")
    expect(gi).toContain("node_modules/")
  })

  it("creates .gitignore with .dawn/ when none exists", async () => {
    const store = createPermissionsStore({ appRoot, config: undefined, mode: "interactive" })
    await store.load()
    await store.addAllow("bash", "ls")
    const gi = readFileSync(join(appRoot, ".gitignore"), "utf8")
    expect(gi).toBe(".dawn/\n")
  })

  it("does not duplicate .dawn/ if already in .gitignore", async () => {
    writeFileSync(join(appRoot, ".gitignore"), "node_modules/\n.dawn/\n")
    const store = createPermissionsStore({ appRoot, config: undefined, mode: "interactive" })
    await store.load()
    await store.addAllow("bash", "ls")
    const gi = readFileSync(join(appRoot, ".gitignore"), "utf8")
    expect(gi.match(/\.dawn\//g)?.length).toBe(1)
  })

  it("serializes concurrent addAllow calls", async () => {
    const store = createPermissionsStore({ appRoot, config: undefined, mode: "interactive" })
    await store.load()
    await Promise.all([
      store.addAllow("bash", "ls"),
      store.addAllow("bash", "pwd"),
      store.addAllow("bash", "cat"),
    ])
    const raw = readFileSync(join(appRoot, ".dawn", "permissions.json"), "utf8")
    const parsed = JSON.parse(raw)
    expect([...parsed.allow.bash].sort()).toEqual(["cat", "ls", "pwd"])
  })

  it("exposes the resolved mode", () => {
    const store = createPermissionsStore({ appRoot, config: undefined, mode: "non-interactive" })
    expect(store.mode).toBe("non-interactive")
  })
})
