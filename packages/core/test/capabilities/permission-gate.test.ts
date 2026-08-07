import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createPermissionsStore } from "@dawn-ai/permissions/node"
import { Annotation, Command, END, MemorySaver, START, StateGraph } from "@langchain/langgraph"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  type GateResult,
  gateMemorySupersede,
  gatePathOp,
  gateSubagentOp,
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
    const permissions = await store("interactive", {
      allow: { tool: ["deployProd"] },
    })
    expect((await gateToolOp(permissions, "deployProd", "{}")).allowed).toBe(true)
  })

  it("blocks a config-denied tool with a reason", async () => {
    const permissions = await store("interactive", {
      deny: { tool: ["deployProd"] },
    })
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
    const result = await gateToolOp(permissions, "deployProd", "{}", {
      interruptCapable: false,
    })
    expect(result.allowed).toBe(false)
    if (!result.allowed) {
      expect(result.reason).toMatch(/allow rule/)
      expect(result.reason).toMatch(/dawn\.config/)
    }
  })
})

describe("gateSubagentOp", () => {
  let appRoot: string
  beforeEach(() => {
    appRoot = mkdtempSync(join(tmpdir(), "dawn-gate-subagent-test-"))
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

  const request = {
    callId: "task-1",
    input: "write a draft",
    parentRouteId: "/parent",
    reason: "Drafts require review.",
    subagentName: "writer",
    subagentRouteId: "/parent/subagents/writer",
    threadId: "thread-1",
  }
  const { reason: _reason, threadId: _threadId, ...requestWithoutReasonOrThread } = request
  const pattern = JSON.stringify(["/parent", "writer"])

  it("allows a pre-approved exact parent/name edge", async () => {
    const permissions = await store("interactive", {
      allow: { subagent: [pattern] },
    })
    await expect(gateSubagentOp(permissions, request, { interruptCapable: true })).resolves.toEqual(
      { allowed: true },
    )
  })

  it("lets an exact deny override an exact allow", async () => {
    const permissions = await store("interactive", {
      allow: { subagent: [pattern] },
      deny: { subagent: [pattern] },
    })
    const result = await gateSubagentOp(permissions, request, {
      interruptCapable: true,
    })
    expect(result).toEqual({
      allowed: false,
      code: "DAWN_E3002",
      reason: "Permission denied by user: subagent writer",
    })
  })

  it("fails closed on unknown approval in non-interactive mode", async () => {
    const permissions = await store("non-interactive")
    const result = await gateSubagentOp(permissions, request, {
      interruptCapable: true,
    })
    expect(result.allowed).toBe(false)
    if (!result.allowed) {
      expect(result.code).toBe("DAWN_E3002")
      expect(result.reason).toMatch(/fail-closed.*writer/i)
    }
  })

  it.each([
    { interruptCapable: false, threadId: "thread-1" },
    { interruptCapable: true, threadId: undefined },
    { interruptCapable: true, threadId: "" },
    { interruptCapable: true, threadId: "   " },
  ])("fails closed without resumable interrupt context: $interruptCapable / $threadId", async ({
    interruptCapable,
    threadId,
  }) => {
    const permissions = await store("interactive")
    const result = await gateSubagentOp(
      permissions,
      threadId !== undefined ? { ...request, threadId } : requestWithoutReasonOrThread,
      { interruptCapable },
    )
    expect(result.allowed).toBe(false)
    if (!result.allowed) {
      expect(result.code).toBe("DAWN_E3002")
      expect(result.reason).toMatch(/thread ID.*interrupt support.*allow rule/i)
    }
  })

  it("allows bypass approval without consulting interrupt prerequisites", async () => {
    const permissions = await store("bypass")
    await expect(
      gateSubagentOp(permissions, requestWithoutReasonOrThread, {
        interruptCapable: false,
      }),
    ).resolves.toEqual({ allowed: true })
  })

  async function interruptCase(decision: "once" | "always" | "deny", input = request.input) {
    const permissions = await store("interactive")
    const State = Annotation.Root({
      result: Annotation<GateResult | undefined>(),
    })
    const checkpointer = new MemorySaver()
    const graph = new StateGraph(State)
      .addNode("permission", async () => ({
        result: await gateSubagentOp(
          permissions,
          { ...request, input },
          { interruptCapable: true },
        ),
      }))
      .addEdge(START, "permission")
      .addEdge("permission", END)
      .compile({ checkpointer })
    const config = {
      configurable: { checkpoint_ns: "", thread_id: request.threadId },
    }

    await graph.invoke({}, config)
    const pending = await graph.getState(config)
    const payload = pending.tasks[0]?.interrupts[0]?.value
    const resumed = await graph.invoke(new Command({ resume: decision }), config)
    return { payload, permissions, result: resumed.result }
  }

  it.each([
    ["once", { allowed: true }],
    [
      "deny",
      {
        allowed: false,
        code: "DAWN_E3002",
        reason: "Permission denied by user: subagent writer",
      },
    ],
  ] as const)("resumes an interactive %s decision", async (decision, expected) => {
    const { result } = await interruptCase(decision)
    expect(result).toEqual(expected)
  })

  it("emits the exact subagent envelope with reason, call identity, and bounded preview", async () => {
    const longInput = "x".repeat(600)
    const { payload } = await interruptCase("once", longInput)
    expect(payload).toEqual({
      interruptId: expect.stringMatching(/^perm-/),
      type: "permission-request",
      kind: "subagent",
      threadId: "thread-1",
      callId: "task-1",
      detail: {
        parentRouteId: "/parent",
        subagentName: "writer",
        subagentRouteId: "/parent/subagents/writer",
        inputPreview: `${"x".repeat(500)}…`,
        reason: "Drafts require review.",
        suggestedPattern: pattern,
      },
    })
  })

  it("omits an absent reason from the interrupt detail", async () => {
    const permissions = await store("interactive")
    const withoutReason = {
      ...requestWithoutReasonOrThread,
      threadId: request.threadId,
    }
    const State = Annotation.Root({
      result: Annotation<GateResult | undefined>(),
    })
    const graph = new StateGraph(State)
      .addNode("permission", async () => ({
        result: await gateSubagentOp(permissions, withoutReason, {
          interruptCapable: true,
        }),
      }))
      .addEdge(START, "permission")
      .addEdge("permission", END)
      .compile({ checkpointer: new MemorySaver() })
    const config = { configurable: { thread_id: request.threadId } }
    await graph.invoke({}, config)
    const payload = (await graph.getState(config)).tasks[0]?.interrupts[0]?.value as {
      detail?: Record<string, unknown>
    }
    expect(payload.detail).not.toHaveProperty("reason")
  })

  it("persists always for only the exact parent/name edge", async () => {
    const { permissions, result } = await interruptCase("always")
    expect(result).toEqual({ allowed: true })
    expect(permissions.match("subagent", pattern)).toBe("allow")
    expect(permissions.match("subagent", JSON.stringify(["/parent", "writer-extra"]))).toBe(
      "unknown",
    )
    expect(permissions.match("subagent", JSON.stringify(["/other", "writer"]))).toBe("unknown")
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
    const tool = {
      name: "deployProd",
      run: async (i: unknown) => `ran:${JSON.stringify(i)}`,
    }
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
    let seen: {
      toolName?: string
      routeId?: string
      threadId?: string
      params?: unknown
    } = {}
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
