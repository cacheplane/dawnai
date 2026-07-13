import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createPermissionsStore } from "@dawn-ai/permissions"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  gateMemorySupersede,
  gatePathOp,
  gateToolOp,
  wrapToolWithApproval,
  wrapToolWithConstraint,
} from "../../src/capabilities/permission-gate.js"

describe("gatePathOp interrupt suppression", () => {
  let appRoot: string

  beforeEach(() => {
    appRoot = mkdtempSync(join(tmpdir(), "dawn-gate-test-"))
  })

  afterEach(() => {
    rmSync(appRoot, { recursive: true, force: true })
  })

  it("fails closed with guidance when interactive but interrupts unavailable", async () => {
    // Interactive mode with no config => match() returns "unknown" for outside paths.
    // Without interruptCapable:false the gate would call interrupt() and throw a LangGraph error.
    const permissions = createPermissionsStore({
      appRoot,
      config: undefined,
      mode: "interactive",
    })
    await permissions.load()

    const result = await gatePathOp(permissions, "readFile", "/outside/x", "/ws", {
      interruptCapable: false,
    })
    expect(result.allowed).toBe(false)
    if (!result.allowed) {
      expect(result.reason).toMatch(/allow rule/)
      expect(result.reason).toMatch(/dawn\.config/)
    }
  })

  it("still allows inside-workspace paths without consulting the store", async () => {
    const permissions = createPermissionsStore({
      appRoot,
      config: undefined,
      mode: "interactive",
    })
    await permissions.load()

    const result = await gatePathOp(permissions, "readFile", "/ws/notes.md", "/ws", {
      interruptCapable: false,
    })
    expect(result.allowed).toBe(true)
  })
})

describe("gateToolOp", () => {
  let appRoot: string
  beforeEach(() => {
    appRoot = mkdtempSync(join(tmpdir(), "dawn-gate-tool-test-"))
  })
  afterEach(() => {
    rmSync(appRoot, { recursive: true, force: true })
  })

  async function store(
    mode: "interactive" | "non-interactive" | "bypass",
    config?: {
      allow?: Record<string, readonly string[]>
      deny?: Record<string, readonly string[]>
    },
  ) {
    const permissions = createPermissionsStore({
      appRoot,
      config: config
        ? { version: 1, allow: config.allow ?? {}, deny: config.deny ?? {} }
        : undefined,
      mode,
    })
    await permissions.load()
    return permissions
  }

  it("allows when no permissions store is present", async () => {
    expect((await gateToolOp(undefined, "deployProd", "{}")).allowed).toBe(true)
  })

  it("allows in bypass mode without consulting the store", async () => {
    const permissions = await store("bypass")
    expect((await gateToolOp(permissions, "deployProd", "{}")).allowed).toBe(true)
  })

  it("allows a config-pre-approved tool (allow.tool exact name)", async () => {
    const permissions = await store("interactive", { allow: { tool: ["deployProd"] } })
    expect((await gateToolOp(permissions, "deployProd", "{}")).allowed).toBe(true)
  })

  it("blocks a config-denied tool with a reason", async () => {
    const permissions = await store("interactive", { deny: { tool: ["deployProd"] } })
    const result = await gateToolOp(permissions, "deployProd", "{}")
    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.reason).toMatch(/denied.*deployProd/i)
  })

  it("fails closed on unknown in non-interactive mode", async () => {
    const permissions = await store("non-interactive")
    const result = await gateToolOp(permissions, "deployProd", "{}")
    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.reason).toMatch(/fail-closed/)
  })

  it("fails closed with guidance when interactive but interrupts unavailable", async () => {
    const permissions = await store("interactive")
    const result = await gateToolOp(permissions, "deployProd", "{}", { interruptCapable: false })
    expect(result.allowed).toBe(false)
    if (!result.allowed) {
      expect(result.reason).toMatch(/allow rule/)
      expect(result.reason).toMatch(/dawn\.config/)
    }
  })
})

describe("wrapToolWithApproval", () => {
  let appRoot: string
  beforeEach(() => {
    appRoot = mkdtempSync(join(tmpdir(), "dawn-wrap-tool-test-"))
  })
  afterEach(() => {
    rmSync(appRoot, { recursive: true, force: true })
  })

  const signal = new AbortController().signal

  it("delegates untouched when the tool is pre-approved", async () => {
    const permissions = createPermissionsStore({
      appRoot,
      config: { version: 1, allow: { tool: ["deployProd"] }, deny: {} },
      mode: "interactive",
    })
    await permissions.load()
    const tool = {
      name: "deployProd",
      description: "deploys",
      filePath: "/app/src/app/ops/tools/deployProd.ts",
      run: async (input: unknown) => `deployed:${JSON.stringify(input)}`,
    }
    const wrapped = wrapToolWithApproval(tool, permissions)
    expect(wrapped.name).toBe("deployProd")
    expect(wrapped.description).toBe("deploys")
    expect(wrapped.filePath).toBe(tool.filePath)
    expect(await wrapped.run({ env: "prod" }, { signal })).toBe('deployed:{"env":"prod"}')
  })

  it("blocks with the denial reason as the tool result when denied", async () => {
    const permissions = createPermissionsStore({
      appRoot,
      config: { version: 1, allow: {}, deny: { tool: ["deployProd"] } },
      mode: "interactive",
    })
    await permissions.load()
    let ran = false
    const wrapped = wrapToolWithApproval(
      {
        name: "deployProd",
        run: async () => {
          ran = true
          return "deployed"
        },
      },
      permissions,
    )
    const result = await wrapped.run({}, { signal })
    expect(ran).toBe(false)
    expect(String(result)).toMatch(/denied.*deployProd/i)
  })

  it("fails closed (as a result string) in non-interactive mode", async () => {
    const permissions = createPermissionsStore({
      appRoot,
      config: undefined,
      mode: "non-interactive",
    })
    await permissions.load()
    const wrapped = wrapToolWithApproval({ name: "x", run: async () => "ran" }, permissions)
    expect(String(await wrapped.run({}, { signal }))).toMatch(/fail-closed/)
  })

  it("prefixes the denial tool result with the [DAWN_E3001] code", async () => {
    const permissions = createPermissionsStore({
      appRoot,
      config: { version: 1, allow: {}, deny: { tool: ["deployProd"] } },
      mode: "interactive",
    })
    await permissions.load()
    const wrapped = wrapToolWithApproval(
      { name: "deployProd", run: async () => "ran" },
      permissions,
    )
    const result = String(await wrapped.run({}, { signal }))
    expect(result.startsWith("[DAWN_E3001] ")).toBe(true)
    // The original reason is preserved after the code prefix.
    expect(result).toMatch(/denied.*deployProd/i)
  })
})

describe("wrapToolWithConstraint", () => {
  let appRoot: string
  beforeEach(() => {
    appRoot = mkdtempSync(join(tmpdir(), "dawn-constrain-test-"))
  })
  afterEach(() => {
    rmSync(appRoot, { recursive: true, force: true })
  })
  const signal = new AbortController().signal
  const runCtx = { signal }

  it("allows (runs the real tool) when the predicate returns true", async () => {
    const tool = { name: "deployProd", run: async (i: unknown) => `ran:${JSON.stringify(i)}` }
    const wrapped = wrapToolWithConstraint(tool, () => true, undefined, "/ops#agent")
    expect(await wrapped.run({ env: "staging" }, runCtx)).toBe('ran:{"env":"staging"}')
  })

  it("denies with the reason string as the tool result", async () => {
    let ran = false
    const tool = {
      name: "deployProd",
      run: async () => {
        ran = true
        return "ran"
      },
    }
    const wrapped = wrapToolWithConstraint(
      tool,
      () => "prod not allowed here",
      undefined,
      "/ops#agent",
    )
    const result = await wrapped.run({ env: "prod" }, runCtx)
    expect(ran).toBe(false)
    expect(String(result)).toBe("prod not allowed here")
  })

  it("passes toolName/routeId and live threadId/params to the predicate", async () => {
    let seen: { toolName?: string; routeId?: string; threadId?: string; params?: unknown } = {}
    const tool = { name: "deployProd", run: async () => "ran" }
    const wrapped = wrapToolWithConstraint(
      tool,
      (_args, ctx) => {
        seen = {
          toolName: ctx.toolName,
          routeId: ctx.routeId,
          threadId: ctx.threadId,
          params: ctx.params,
        }
        return true
      },
      undefined,
      "/ops#agent",
    )
    await wrapped.run({}, { signal, threadId: "t-9", params: { tenant: "acme" } })
    expect(seen).toEqual({
      toolName: "deployProd",
      routeId: "/ops#agent",
      threadId: "t-9",
      params: { tenant: "acme" },
    })
  })

  it("fails closed (deny result) when the predicate throws", async () => {
    let ran = false
    const tool = {
      name: "deployProd",
      run: async () => {
        ran = true
        return "ran"
      },
    }
    const wrapped = wrapToolWithConstraint(
      tool,
      () => {
        throw new Error("boom")
      },
      undefined,
      "/ops#agent",
    )
    const result = await wrapped.run({}, runCtx)
    expect(ran).toBe(false)
    expect(String(result)).toMatch(/constraint check failed/i)
  })

  it("awaits an async predicate", async () => {
    const tool = { name: "deployProd", run: async () => "ran" }
    const wrapped = wrapToolWithConstraint(
      tool,
      async () => await Promise.resolve("async denied"),
      undefined,
      "/ops#agent",
    )
    expect(String(await wrapped.run({}, runCtx))).toBe("async denied")
  })

  it("{approve} escalates through gateToolOp — pre-approved tool runs", async () => {
    const permissions = createPermissionsStore({
      appRoot,
      config: { version: 1, allow: { tool: ["deployProd"] }, deny: {} },
      mode: "interactive",
    })
    await permissions.load()
    const tool = { name: "deployProd", run: async () => "deployed" }
    const wrapped = wrapToolWithConstraint(
      tool,
      () => ({ approve: true }),
      permissions,
      "/ops#agent",
    )
    expect(await wrapped.run({ env: "prod" }, runCtx)).toBe("deployed")
  })

  it("{approve} escalates through gateToolOp — denied tool returns the gate reason", async () => {
    const permissions = createPermissionsStore({
      appRoot,
      config: { version: 1, allow: {}, deny: { tool: ["deployProd"] } },
      mode: "interactive",
    })
    await permissions.load()
    let ran = false
    const tool = {
      name: "deployProd",
      run: async () => {
        ran = true
        return "deployed"
      },
    }
    const wrapped = wrapToolWithConstraint(
      tool,
      () => ({ approve: true }),
      permissions,
      "/ops#agent",
    )
    const result = await wrapped.run({ env: "prod" }, runCtx)
    expect(ran).toBe(false)
    expect(String(result)).toMatch(/denied.*deployProd/i)
  })

  it("fails closed on an off-contract verdict (false / undefined / {approve:false})", async () => {
    for (const bad of [() => false, () => undefined, () => ({ approve: false })]) {
      let ran = false
      const tool = {
        name: "deployProd",
        run: async () => {
          ran = true
          return "ran"
        },
      }
      // permissions omitted (undefined) — if this WRONGLY escalated it would still
      // not throw, but the result would not be the constraint-failed string.
      const wrapped = wrapToolWithConstraint(tool, bad as never, undefined, "/ops#agent")
      const result = await wrapped.run({}, { signal: new AbortController().signal })
      expect(ran).toBe(false)
      expect(String(result)).toMatch(/constraint check failed/i)
    }
  })
})

describe("gateMemorySupersede", () => {
  let appRoot: string
  beforeEach(() => {
    appRoot = mkdtempSync(join(tmpdir(), "dawn-gate-memory-test-"))
  })
  afterEach(() => {
    rmSync(appRoot, { recursive: true, force: true })
  })

  async function store(
    mode: "interactive" | "non-interactive" | "bypass",
    config?: {
      allow?: Record<string, readonly string[]>
      deny?: Record<string, readonly string[]>
    },
  ) {
    const permissions = createPermissionsStore({
      appRoot,
      config: config
        ? { version: 1, allow: config.allow ?? {}, deny: config.deny ?? {} }
        : undefined,
      mode,
    })
    await permissions.load()
    return permissions
  }

  const detail = {
    namespace: "workspace=app|route=/support",
    identity: "acme / payment-terms",
    oldId: "memory_abc123",
    oldContent: "acme prefers net-30",
    newContent: "acme prefers net-45",
  }

  it("allows when no permissions store is present (legacy context ≡ auto)", async () => {
    expect((await gateMemorySupersede(undefined, detail)).allowed).toBe(true)
  })

  it("allows in bypass mode", async () => {
    const permissions = await store("bypass")
    expect((await gateMemorySupersede(permissions, detail)).allowed).toBe(true)
  })

  it("allows a config-pre-approved route prefix (terminated)", async () => {
    const permissions = await store("interactive", {
      allow: { memory: ["workspace=app|route=/support|"] },
    })
    expect((await gateMemorySupersede(permissions, detail)).allowed).toBe(true)
  })

  it("does not let a sibling-route rule leak (route=/s vs route=/support)", async () => {
    // /s is a string prefix of /support; the terminator must prevent the match.
    // "unknown" in non-interactive mode → allow-through, so use the deny list
    // to make leakage observable.
    const permissions = await store("non-interactive", {
      deny: { memory: ["workspace=app|route=/s|"] },
    })
    expect((await gateMemorySupersede(permissions, detail)).allowed).toBe(true)
  })

  it("blocks an explicitly denied route prefix with a reason (honored headless)", async () => {
    const permissions = await store("non-interactive", {
      deny: { memory: ["workspace=app|route=/support|"] },
    })
    const result = await gateMemorySupersede(permissions, detail)
    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.reason).toMatch(/denied/i)
  })

  it("allows through on unknown in non-interactive mode (ask ≡ auto headless)", async () => {
    const permissions = await store("non-interactive")
    expect((await gateMemorySupersede(permissions, detail)).allowed).toBe(true)
  })
})
