import type { DawnResumeRequest } from "@dawn-ai/ag-ui"
import {
  Annotation,
  Command,
  END,
  interrupt,
  MemorySaver,
  START,
  StateGraph,
} from "@langchain/langgraph"
import type { BaseCheckpointSaver, CheckpointTuple } from "@langchain/langgraph-checkpoint"
import { describe, expect, test, vi } from "vitest"

import {
  type PendingInterrupt,
  type PendingInterruptSnapshot,
  type PermissionDecision,
  readPendingInterrupts,
  resolveAgUiResume,
} from "../src/lib/dev/pending-interrupts.js"

const TASK_UUID_1 = "33a12321-3ec2-56a7-b4d7-0337886c4386"
const TASK_UUID_2 = "44b23432-4fd3-67b8-c5e8-1448997d5497"
const RESUME_KEY_1 = "3336d0e0a2d4f198ef9aecd09cd7ac27"
const RESUME_KEY_2 = "4447e1f1b3e5a209fa0bfde10de8bd38"

describe("resolveAgUiResume", () => {
  test.each([
    undefined,
    [],
  ] as const)("starts a turn with no pending interrupts and resume %j", (resume) => {
    expect(resolveAgUiResume(resume, snapshot([]))).toEqual({ ok: true, mode: "turn" })
  })

  test.each([
    undefined,
    [],
  ] as const)("rejects resume %j when a checkpoint interrupt is pending", (resume) => {
    expect(resolveAgUiResume(resume, snapshot([pending("perm-1", RESUME_KEY_1)]))).toMatchObject({
      code: "resume_required",
      ok: false,
      status: 409,
    })
  })

  test("rejects supplied resume entries when no checkpoint interrupt is pending", () => {
    expect(
      resolveAgUiResume([{ interruptId: "perm-1", status: "cancelled" }], snapshot([])),
    ).toMatchObject({ code: "stale_interrupt", ok: false, status: 409 })
  })

  test.each<PermissionDecision>([
    "once",
    "always",
    "deny",
  ])("preserves the resolved %s decision under the outer resume key", (decision) => {
    expect(
      resolveAgUiResume(
        [{ interruptId: "perm-1", payload: decision, status: "resolved" }],
        snapshot([pending("perm-1", RESUME_KEY_1)]),
      ),
    ).toEqual({ ok: true, mode: "resume", resume: { [RESUME_KEY_1]: decision } })
  })

  test("maps a cancelled entry to deny", () => {
    expect(
      resolveAgUiResume(
        [{ interruptId: "perm-1", status: "cancelled" }],
        snapshot([pending("perm-1", RESUME_KEY_1)]),
      ),
    ).toEqual({ ok: true, mode: "resume", resume: { [RESUME_KEY_1]: "deny" } })
  })

  test("maps two exact pending entries by outer resume key", () => {
    expect(
      resolveAgUiResume(
        [
          { interruptId: "perm-1", payload: "always", status: "resolved" },
          { interruptId: "perm-2", status: "cancelled" },
        ],
        snapshot([pending("perm-1", RESUME_KEY_1), pending("perm-2", RESUME_KEY_2)]),
      ),
    ).toEqual({
      ok: true,
      mode: "resume",
      resume: { [RESUME_KEY_1]: "always", [RESUME_KEY_2]: "deny" },
    })
  })

  test.each([
    {
      name: "missing pending ID",
      pending: [pending("perm-1", RESUME_KEY_1), pending("perm-2", RESUME_KEY_2)],
      resume: [{ interruptId: "perm-1", status: "cancelled" }],
    },
    {
      name: "unknown ID",
      pending: [pending("perm-1", RESUME_KEY_1)],
      resume: [{ interruptId: "perm-unknown", status: "cancelled" }],
    },
    {
      name: "duplicate resume ID",
      pending: [pending("perm-1", RESUME_KEY_1)],
      resume: [
        { interruptId: "perm-1", status: "cancelled" },
        { interruptId: "perm-1", status: "cancelled" },
      ],
    },
  ] satisfies ReadonlyArray<{
    name: string
    pending: PendingInterrupt[]
    resume: DawnResumeRequest[]
  }>)("rejects an inexact resume set: $name", ({ pending: entries, resume }) => {
    expect(resolveAgUiResume(resume, snapshot(entries))).toMatchObject({
      code: "interrupt_set_mismatch",
      ok: false,
      status: 409,
    })
  })

  test.each([
    { interruptId: "perm-1", status: "resolved" },
    { interruptId: "perm-1", payload: "sometimes", status: "resolved" },
    { interruptId: "perm-1", payload: { decision: "once" }, status: "resolved" },
  ] satisfies DawnResumeRequest[])("rejects a resolved entry with missing or unsupported payload: %j", (entry) => {
    expect(resolveAgUiResume([entry], snapshot([pending("perm-1", RESUME_KEY_1)]))).toMatchObject({
      code: "invalid_resume_payload",
      ok: false,
      status: 400,
    })
  })

  test.each([
    undefined,
    [{ interruptId: "perm-1", payload: "once", status: "resolved" }],
  ] satisfies ReadonlyArray<
    readonly DawnResumeRequest[] | undefined
  >)("rejects malformed checkpoint state before starting or resuming: %j", (resume) => {
    expect(
      resolveAgUiResume(resume, {
        interrupts: [pending("perm-1", RESUME_KEY_1)],
        malformed: true,
      }),
    ).toMatchObject({ code: "malformed_checkpoint", ok: false, status: 409 })
  })
})

describe("readPendingInterrupts", () => {
  test("returns null when the checkpoint tuple does not exist", async () => {
    const checkpointer = fakeCheckpointer(undefined)

    await expect(readPendingInterrupts(checkpointer, "thread-1")).resolves.toBeNull()
    expect(checkpointer.getTuple).toHaveBeenCalledWith({
      configurable: { checkpoint_ns: "", thread_id: "thread-1" },
    })
  })

  test("uses the inner client ID, outer resume key, and both AP aliases", async () => {
    const checkpointer = fakeCheckpointer([
      [TASK_UUID_1, "__interrupt__", { id: RESUME_KEY_1, value: { interruptId: "perm-1" } }],
      [TASK_UUID_2, "__interrupt__", { id: RESUME_KEY_2, value: { kind: "permission" } }],
      ["55c34543-50e4-78c9-d6f9-2559008e6508", "messages", { id: "not-an-interrupt" }],
    ])

    await expect(readPendingInterrupts(checkpointer, "thread-2")).resolves.toEqual({
      interrupts: [
        {
          aliases: ["perm-1", RESUME_KEY_1],
          interruptId: "perm-1",
          resumeKey: RESUME_KEY_1,
        },
        {
          aliases: [RESUME_KEY_2],
          interruptId: RESUME_KEY_2,
          resumeKey: RESUME_KEY_2,
        },
      ],
      malformed: false,
    })
  })

  test("retains AP aliases but marks an invalid outer resume key malformed", async () => {
    const snapshot = await readPendingInterrupts(
      fakeCheckpointer([
        [TASK_UUID_1, "__interrupt__", { id: "outer-ap-id", value: { interruptId: "perm-1" } }],
      ]),
      "thread-3",
    )

    expect(snapshot).toEqual({
      interrupts: [
        {
          aliases: ["perm-1", "outer-ap-id"],
          interruptId: "perm-1",
          resumeKey: null,
        },
      ],
      malformed: true,
    })
    expect(resolveAgUiResume(undefined, requireSnapshot(snapshot))).toMatchObject({
      code: "malformed_checkpoint",
      ok: false,
      status: 409,
    })
  })

  test("marks malformed interrupt writes and blocks a subset resume", async () => {
    const snapshot = await readPendingInterrupts(
      fakeCheckpointer([
        [TASK_UUID_1, "__interrupt__", { id: RESUME_KEY_1, value: { interruptId: "perm-1" } }],
        [TASK_UUID_2, "__interrupt__", null],
      ]),
      "thread-4",
    )

    expect(snapshot).toMatchObject({ malformed: true })
    expect(
      resolveAgUiResume(
        [{ interruptId: "perm-1", payload: "once", status: "resolved" }],
        requireSnapshot(snapshot),
      ),
    ).toMatchObject({ code: "malformed_checkpoint", ok: false, status: 409 })
  })

  test.each([
    {
      name: "duplicate outer resume keys",
      writes: [
        [TASK_UUID_1, "__interrupt__", { id: RESUME_KEY_1, value: { interruptId: "perm-1" } }],
        [TASK_UUID_2, "__interrupt__", { id: RESUME_KEY_1, value: { interruptId: "perm-2" } }],
      ],
    },
    {
      name: "duplicate client interrupt IDs",
      writes: [
        [TASK_UUID_1, "__interrupt__", { id: RESUME_KEY_1, value: { interruptId: "perm-1" } }],
        [TASK_UUID_2, "__interrupt__", { id: RESUME_KEY_2, value: { interruptId: "perm-1" } }],
      ],
    },
  ])("rejects $name as malformed checkpoint state", async ({ writes }) => {
    const snapshot = await readPendingInterrupts(fakeCheckpointer(writes), "thread-5")

    expect(snapshot).toMatchObject({ malformed: true })
    expect(resolveAgUiResume(undefined, requireSnapshot(snapshot))).toMatchObject({
      code: "malformed_checkpoint",
      ok: false,
      status: 409,
    })
  })
})

test("resumes a real LangGraph interrupt with the parsed outer resume key", async () => {
  const State = Annotation.Root({ answer: Annotation<PermissionDecision>() })
  const checkpointer = new MemorySaver()
  const graph = new StateGraph(State)
    .addNode("permission", () => ({
      answer: interrupt<{ interruptId: string }, PermissionDecision>({ interruptId: "perm-real" }),
    }))
    .addEdge(START, "permission")
    .addEdge("permission", END)
    .compile({ checkpointer })
  const config = { configurable: { checkpoint_ns: "", thread_id: "thread-real" } }

  await graph.invoke({}, config)
  const tuple = await checkpointer.getTuple(config)
  const interruptWrite = tuple?.pendingWrites?.find(([, channel]) => channel === "__interrupt__")
  expect(interruptWrite?.[0]).toMatch(/^[0-9a-f-]{36}$/)

  const snapshot = await readPendingInterrupts(checkpointer, "thread-real")
  const resolution = resolveAgUiResume(
    [{ interruptId: "perm-real", payload: "once", status: "resolved" }],
    requireSnapshot(snapshot),
  )
  expect(resolution).toMatchObject({ ok: true, mode: "resume" })
  if (!resolution.ok || resolution.mode !== "resume") throw new Error("Expected resume resolution")
  expect(Object.keys(resolution.resume)).toEqual([expect.stringMatching(/^[0-9a-f]{32}$/)])
  expect(Object.keys(resolution.resume)).not.toContain(interruptWrite?.[0])

  await expect(graph.invoke(new Command({ resume: resolution.resume }), config)).resolves.toEqual({
    answer: "once",
  })
})

function pending(interruptId: string, resumeKey: string): PendingInterrupt {
  return { aliases: [interruptId, resumeKey], interruptId, resumeKey }
}

function snapshot(interrupts: readonly PendingInterrupt[]): PendingInterruptSnapshot {
  return { interrupts, malformed: false }
}

function requireSnapshot(value: PendingInterruptSnapshot | null): PendingInterruptSnapshot {
  if (!value) throw new Error("Expected checkpoint snapshot")
  return value
}

function fakeCheckpointer(pendingWrites: readonly unknown[] | undefined) {
  const tuple =
    pendingWrites === undefined ? undefined : ({ pendingWrites } as unknown as CheckpointTuple)
  return {
    getTuple: vi.fn(async () => tuple),
  } as unknown as BaseCheckpointSaver & {
    getTuple: ReturnType<typeof vi.fn>
  }
}
