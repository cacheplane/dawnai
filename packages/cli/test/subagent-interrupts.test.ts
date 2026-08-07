import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createSubagentsMarker } from "@dawn-ai/core"
import {
  convertSubagentTaskToLangChain,
  type ResolvedSubagentGraph,
  type SubagentResolver,
  streamAgent,
} from "@dawn-ai/langchain"
import type { PermissionsStore } from "@dawn-ai/permissions"
import { createPermissionsStore } from "@dawn-ai/permissions/node"
import { AIMessage } from "@langchain/core/messages"
import type { RunnableConfig } from "@langchain/core/runnables"
import {
  Annotation,
  Command,
  END,
  interrupt,
  MemorySaver,
  START,
  StateGraph,
} from "@langchain/langgraph"
import { ToolNode } from "@langchain/langgraph/prebuilt"
import { afterEach, describe, expect, it, vi } from "vitest"

import { readPendingInterrupts, resolvePendingResume } from "../src/lib/dev/pending-interrupts.js"
import { buildGuardedSubagentResolver } from "../src/lib/runtime/execute-route.js"

const signal = new AbortController().signal
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })))
})

describe("subagent interrupt replay", () => {
  it("parks parent approval, resumes once exactly once, and asks again on the next call", async () => {
    const permissions = await permissionStore()
    let childStarts = 0
    const child = completingChild("reviewed", () => childStarts++)
    const prepareChild = vi.fn(async () => childHandle(child))
    const resolver = guardedResolver({
      child,
      parentRouteId: "/parent",
      permissions,
      prepareChild,
      rule: { action: "approve" },
    })
    const task = await taskTool(resolver)
    const saver = new MemorySaver()
    const root = taskRoot(task, saver)
    const config = rootConfig("parent-once")

    const first = await root.invoke(taskInput("parent-call-1", "researcher", "Review"), config)
    expect(interruptValues(first)).toEqual([
      expect.objectContaining({
        callId: "parent-call-1",
        kind: "subagent",
        detail: expect.objectContaining({
          parentRouteId: "/parent",
          subagentName: "researcher",
        }),
      }),
    ])
    expect(childStarts).toBe(0)

    const resolution = await resolveThread(saver, "parent-once", [
      {
        interruptId: publicInterruptIds(first)[0] as string,
        payload: "once",
        status: "resolved",
      },
    ])
    const resumed = await root.invoke(new Command({ resume: resolution }), config)
    expect(toolContents(resumed)).toContain("reviewed")
    expect(childStarts).toBe(1)
    expect(prepareChild).toHaveBeenCalledTimes(1)

    const second = await root.invoke(
      taskInput("parent-call-2", "researcher", "Review again"),
      config,
    )
    expect(interruptValues(second)).toEqual([
      expect.objectContaining({ callId: "parent-call-2", kind: "subagent" }),
    ])
    expect(childStarts).toBe(1)
  })

  it("persists always for only the exact parent/name tuple and honors it after reload", async () => {
    const appRoot = await tempRoot()
    const permissions = await permissionStore(appRoot)
    const child = completingChild("persisted")
    const resolver = guardedResolver({
      child,
      parentRouteId: "/parent",
      permissions,
      rule: { action: "approve" },
    })
    const saver = new MemorySaver()
    const root = taskRoot(await taskTool(resolver), saver)
    const config = rootConfig("parent-always")
    const first = await root.invoke(taskInput("always-call", "researcher", "Review"), config)

    const resolution = await resolveThread(saver, "parent-always", [
      {
        interruptId: publicInterruptIds(first)[0] as string,
        payload: "always",
        status: "resolved",
      },
    ])
    await root.invoke(new Command({ resume: resolution }), config)

    const pattern = JSON.stringify(["/parent", "researcher"])
    const persisted = JSON.parse(await readFile(join(appRoot, ".dawn", "permissions.json"), "utf8"))
    expect(persisted).toEqual({
      version: 1,
      allow: { subagent: [pattern] },
      deny: {},
    })

    const reloaded = await permissionStore(appRoot)
    expect(reloaded.match("subagent", pattern)).toBe("allow")
    expect(reloaded.match("subagent", JSON.stringify(["/other", "researcher"]))).toBe("unknown")
    expect(reloaded.match("subagent", JSON.stringify(["/parent", "writer"]))).toBe("unknown")

    const restartedSaver = new MemorySaver()
    const restarted = taskRoot(
      await taskTool(
        guardedResolver({
          child,
          parentRouteId: "/parent",
          permissions: reloaded,
          rule: { action: "approve" },
        }),
      ),
      restartedSaver,
    )
    const result = await restarted.invoke(
      taskInput("reloaded-call", "researcher", "Review after reload"),
      rootConfig("parent-after-reload"),
    )
    expect(interruptValues(result)).toEqual([])
    expect(toolContents(result)).toContain("persisted")
  })

  it("evaluates a child's outbound delegation policy independently", async () => {
    const permissions = await permissionStore()
    let grandchildStarts = 0
    const grandchild = completingChild("nested complete", () => grandchildStarts++)
    const childResolver = guardedResolver({
      child: grandchild,
      name: "writer",
      parentRouteId: "/parent/subagents/researcher",
      permissions,
      routeId: "/parent/subagents/researcher/subagents/writer",
      rule: { action: "approve", reason: "Child review required." },
    })
    const childTask = await taskTool(childResolver)
    const ChildState = Annotation.Root({ messages: Annotation<unknown[]>() })
    const child = new StateGraph(ChildState)
      .addNode("delegate", async (_state, config) => ({
        messages: [
          new AIMessage(
            await childTask.func({ input: "Draft", subagent: "writer" }, undefined, {
              ...config,
              toolCall: { id: "child-writer-call" },
            } as RunnableConfig),
          ),
        ],
      }))
      .addEdge(START, "delegate")
      .addEdge("delegate", END)
      .compile()
    const parentResolver = guardedResolver({
      child,
      parentRouteId: "/parent",
      permissions,
      rule: { action: "allow" },
    })
    const saver = new MemorySaver()
    const root = taskRoot(await taskTool(parentResolver), saver)
    const first = await root.invoke(
      taskInput("parent-research-call", "researcher", "Research"),
      rootConfig("nested-policy"),
    )

    expect(interruptValues(first)).toEqual([
      expect.objectContaining({
        callId: "child-writer-call",
        kind: "subagent",
        detail: expect.objectContaining({
          parentRouteId: "/parent/subagents/researcher",
          reason: "Child review required.",
          subagentName: "writer",
        }),
      }),
    ])
    expect(grandchildStarts).toBe(0)

    const resolution = await resolveThread(saver, "nested-policy", [
      {
        interruptId: publicInterruptIds(first)[0] as string,
        payload: "once",
        status: "resolved",
      },
    ])
    const resumed = await root.invoke(
      new Command({ resume: resolution }),
      rootConfig("nested-policy"),
    )
    expect(toolContents(resumed)).toContain("nested complete")
    expect(grandchildStarts).toBe(1)
  })

  it.each(["tool", "path", "memory"] as const)(
    "surfaces and resumes a child-owned %s approval with the child call id",
    async (kind) => {
      const saver = new MemorySaver()
      let childStarts = 0
      const child = interruptingChild(kind, () => childStarts++)
      const resolver = guardedResolver({
        child,
        parentRouteId: "/parent",
        rule: { action: "allow" },
      })
      const root = taskRoot(await taskTool(resolver), saver)
      const firstChunks = await collectStream(
        root,
        saver,
        taskInput("child-call", "researcher", kind),
        {
          threadId: `child-${kind}`,
        },
      )
      const interrupts = firstChunks.filter(({ type }) => type === "interrupt")

      expect(interrupts).toEqual([
        {
          type: "interrupt",
          data: expect.objectContaining({
            callId: "child-call",
            interruptId: `perm-child-${kind}`,
            kind,
          }),
        },
      ])
      expect(firstChunks).not.toContainEqual({
        type: "subagent.end",
        data: expect.objectContaining({ error: expect.anything() }),
      })
      expect(childStarts).toBe(1)

      const resolution = await resolveThread(saver, `child-${kind}`, [
        {
          interruptId: `perm-child-${kind}`,
          payload: "once",
          status: "resolved",
        },
      ])
      const resumedChunks = await collectStream(root, saver, new Command({ resume: resolution }), {
        threadId: `child-${kind}`,
      })
      expect([...resumedChunks].reverse().find(({ type }) => type === "done")?.data).toEqual(
        expect.objectContaining({ messages: expect.any(Array) }),
      )
      expect(childStarts).toBe(1)
    },
  )

  it("resumes two parallel child interrupts only from a complete ID-addressed set", async () => {
    const child = parallelInterruptingChild()
    const resolver = guardedResolver({
      child,
      parentRouteId: "/parent",
      rule: { action: "allow" },
    })
    const saver = new MemorySaver()
    const root = parallelTaskRoot(await taskTool(resolver), saver)
    const config = rootConfig("parallel-children")
    const first = await root.invoke({}, config)
    expect(new Set(publicInterruptIds(first))).toEqual(new Set(["perm-child-A", "perm-child-B"]))

    const snapshot = requireSnapshot(await readPendingInterrupts(saver, "parallel-children"))
    expect(snapshot.interrupts).toHaveLength(2)
    expect(new Set(snapshot.interrupts.map(({ resumeKey }) => resumeKey)).size).toBe(2)

    const publicIds = snapshot.interrupts.map(({ interruptId }) => interruptId)
    const nativeIds = snapshot.interrupts.map(({ resumeKey }) => resumeKey as string)
    expect(
      resolvePendingResume(
        [{ interruptId: publicIds[0] as string, status: "cancelled" }],
        snapshot,
      ),
    ).toMatchObject({
      code: "interrupt_set_mismatch",
      ok: false,
    })
    expect(
      resolvePendingResume(
        [
          { interruptId: publicIds[0] as string, status: "cancelled" },
          { interruptId: publicIds[0] as string, status: "cancelled" },
        ],
        snapshot,
      ),
    ).toMatchObject({ code: "interrupt_set_mismatch", ok: false })
    expect(
      resolvePendingResume(
        [
          { interruptId: "perm-stale", status: "cancelled" },
          { interruptId: publicIds[1] as string, status: "cancelled" },
        ],
        snapshot,
      ),
    ).toMatchObject({ code: "interrupt_set_mismatch", ok: false })
    expect(
      resolvePendingResume(
        [...nativeIds].reverse().map((interruptId) => ({
          interruptId,
          status: "cancelled" as const,
        })),
        snapshot,
      ),
    ).toMatchObject({ code: "interrupt_set_mismatch", ok: false })

    const complete = resolvePendingResume(
      [
        { interruptId: "perm-child-A", payload: "once", status: "resolved" },
        { interruptId: "perm-child-B", payload: "always", status: "resolved" },
      ],
      snapshot,
    )
    expect(complete).toMatchObject({ ok: true, mode: "resume" })
    if (!complete.ok || complete.mode !== "resume") throw new Error("Expected complete resume map")
    expect(new Set(Object.keys(complete.resume))).toEqual(new Set(nativeIds))

    const resumed = await root.invoke(new Command({ resume: complete.resume }), config)
    expect([...(resumed.results as string[])].sort()).toEqual(["child:A:once", "child:B:always"])
  })

  it("fails closed without a root thread id before emitting an unresumable interrupt", async () => {
    const child = completingChild("must not run")
    const prepareChild = vi.fn(async () => childHandle(child))
    const resolver = guardedResolver({
      child,
      parentRouteId: "/parent",
      permissions: await permissionStore(),
      prepareChild,
      rule: { action: "approve" },
    })
    const root = taskRoot(await taskTool(resolver))
    const result = await root.invoke(taskInput("no-thread-call", "researcher", "Review"), {
      signal,
    })

    expect(interruptValues(result)).toEqual([])
    expect(toolContents(result)).toEqual([
      expect.stringContaining(
        '[DAWN_E3002] Permission denied: subagent "researcher" requires approval',
      ),
    ])
    expect(prepareChild).not.toHaveBeenCalled()
  })
})

type DelegationRule =
  | { readonly action: "allow" }
  | { readonly action: "approve"; readonly reason?: string }

function guardedResolver(options: {
  readonly child: ResolvedSubagentGraph["graph"]
  readonly name?: string
  readonly parentRouteId: string
  readonly permissions?: PermissionsStore
  readonly prepareChild?: (entry: unknown, context: unknown) => Promise<ResolvedSubagentGraph>
  readonly routeId?: string
  readonly rule: DelegationRule
}): SubagentResolver {
  const name = options.name ?? "researcher"
  const routeId = options.routeId ?? `/parent/subagents/${name}`
  return buildGuardedSubagentResolver({
    fallbackSignal: signal,
    interruptCapable: true,
    parentRouteId: options.parentRouteId,
    ...(options.permissions ? { permissions: options.permissions } : {}),
    prepareChild:
      options.prepareChild ??
      (async () => ({
        graph: options.child,
        routeId,
      })),
    registry: [
      {
        description: `${name} fixture.`,
        name,
        routeId,
        rule: options.rule,
        source: "explicit",
      },
    ],
  })
}

async function taskTool(resolver: SubagentResolver) {
  const contribution = await createSubagentsMarker().load("/fixture", {
    subagentRegistry: [
      {
        description: "Fixture child.",
        name: "researcher",
        routeId: "/fixture/subagents/researcher",
        rule: { action: "allow" },
        source: "convention",
      },
    ],
  } as never)
  const placeholder = contribution.tools?.find(({ name }) => name === "task")
  if (!placeholder) throw new Error("Expected task placeholder")
  return convertSubagentTaskToLangChain(placeholder, resolver)
}

function taskRoot(task: Awaited<ReturnType<typeof taskTool>>, checkpointer?: MemorySaver) {
  const RootState = Annotation.Root({ messages: Annotation<unknown[]>() })
  return new StateGraph(RootState)
    .addNode("tools", new ToolNode([task]))
    .addEdge(START, "tools")
    .addEdge("tools", END)
    .compile(checkpointer ? { checkpointer } : undefined)
}

function parallelTaskRoot(task: Awaited<ReturnType<typeof taskTool>>, checkpointer: MemorySaver) {
  const RootState = Annotation.Root({
    results: Annotation<string[]>({
      reducer: (left, right) => [...left, ...right],
      default: () => [],
    }),
  })
  const dispatch =
    (callId: string, input: string) => async (_state: unknown, config: RunnableConfig) => ({
      results: [
        await task.func({ input, subagent: "researcher" }, undefined, {
          ...config,
          toolCall: { id: callId },
        } as RunnableConfig),
      ],
    })
  return new StateGraph(RootState)
    .addNode("first", dispatch("parallel-a", "A"))
    .addNode("second", dispatch("parallel-b", "B"))
    .addEdge(START, "first")
    .addEdge(START, "second")
    .addEdge("first", END)
    .addEdge("second", END)
    .compile({ checkpointer })
}

function completingChild(text: string, onStart: () => void = () => undefined) {
  const ChildState = Annotation.Root({ messages: Annotation<unknown[]>() })
  return new StateGraph(ChildState)
    .addNode("complete", () => {
      onStart()
      return { messages: [new AIMessage(text)] }
    })
    .addEdge(START, "complete")
    .addEdge("complete", END)
    .compile()
}

function interruptingChild(kind: "memory" | "path" | "tool", onStart: () => void) {
  const ChildState = Annotation.Root({ messages: Annotation<unknown[]>() })
  return new StateGraph(ChildState)
    .addNode("started", () => {
      onStart()
      return {}
    })
    .addNode("approval", () => {
      const decision = interrupt({
        interruptId: `perm-child-${kind}`,
        type: "permission-request",
        kind,
        detail: { suggestedPattern: kind },
      })
      return { messages: [new AIMessage(`child:${kind}:${decision}`)] }
    })
    .addEdge(START, "started")
    .addEdge("started", "approval")
    .addEdge("approval", END)
    .compile()
}

function parallelInterruptingChild() {
  const ChildState = Annotation.Root({ messages: Annotation<unknown[]>() })
  return new StateGraph(ChildState)
    .addNode("approval", (state) => {
      const input = String((state.messages[0] as { content?: unknown } | undefined)?.content)
      const decision = interrupt({
        interruptId: `perm-child-${input}`,
        type: "permission-request",
        kind: "tool",
        detail: { suggestedPattern: input, toolName: "fixture" },
      })
      return { messages: [new AIMessage(`child:${input}:${decision}`)] }
    })
    .addEdge(START, "approval")
    .addEdge("approval", END)
    .compile()
}

function childHandle(graph: ResolvedSubagentGraph["graph"]): ResolvedSubagentGraph {
  return { graph, routeId: "/parent/subagents/researcher" }
}

function taskInput(callId: string, subagent: string, input: string): { messages: AIMessage[] } {
  return {
    messages: [
      new AIMessage({
        content: "",
        tool_calls: [
          {
            args: { input, subagent },
            id: callId,
            name: "task",
            type: "tool_call",
          },
        ],
      }),
    ],
  }
}

function rootConfig(threadId: string): RunnableConfig {
  return { configurable: { thread_id: threadId }, signal }
}

async function collectStream(
  root: ReturnType<typeof taskRoot>,
  saver: MemorySaver,
  input: unknown,
  options: { readonly threadId: string },
) {
  const chunks: Array<{ type: string; data: unknown }> = []
  const entry = {
    invoke: root.invoke.bind(root),
    streamEvents: (_ignored: unknown, config: Record<string, unknown>) =>
      root.streamEvents(input as never, { ...config, version: "v2" }),
  }
  for await (const chunk of streamAgent({
    checkpointer: saver,
    entry,
    input,
    routeParamNames: [],
    signal,
    threadId: options.threadId,
    tools: [],
  })) {
    chunks.push(chunk)
  }
  return chunks
}

async function resolveThread(
  saver: MemorySaver,
  threadId: string,
  resume: readonly {
    readonly interruptId: string
    readonly payload?: "always" | "deny" | "once"
    readonly status: "cancelled" | "resolved"
  }[],
): Promise<Record<string, "always" | "deny" | "once">> {
  const resolution = resolvePendingResume(
    resume,
    requireSnapshot(await readPendingInterrupts(saver, threadId)),
  )
  if (!resolution.ok || resolution.mode !== "resume") throw new Error("Expected resume map")
  return resolution.resume
}

function requireSnapshot<T>(value: T | null): T {
  if (!value) throw new Error("Expected pending interrupt snapshot")
  return value
}

function interruptValues(result: unknown): unknown[] {
  const entries = (result as { __interrupt__?: readonly { value?: unknown }[] }).__interrupt__ ?? []
  return entries.map(({ value }) => value)
}

function publicInterruptIds(result: unknown): string[] {
  return interruptValues(result).flatMap((value) => {
    const interruptId = (value as { interruptId?: unknown } | undefined)?.interruptId
    return typeof interruptId === "string" ? [interruptId] : []
  })
}

function toolContents(result: unknown): string[] {
  const messages = (result as { messages?: unknown[] } | undefined)?.messages ?? []
  return messages.flatMap((message) => {
    const content = (message as { content?: unknown } | undefined)?.content
    return typeof content === "string" ? [content] : []
  })
}

async function permissionStore(appRoot?: string): Promise<PermissionsStore> {
  const root = appRoot ?? (await tempRoot())
  const permissions = createPermissionsStore({
    appRoot: root,
    config: undefined,
    mode: "interactive",
  })
  await permissions.load()
  return permissions
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dawn-subagent-interrupts-"))
  tempDirs.push(root)
  return root
}
