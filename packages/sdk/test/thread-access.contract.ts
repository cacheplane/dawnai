import {
  type DawnThreadAccess,
  defineThreadAccess,
  deny,
  permit,
  THREAD_ACCESS_METADATA_KEY,
  type ThreadAccessAllow,
  type ThreadAccessDeny,
  type ThreadAccessPolicy,
  type ThreadAccessRequest,
  type ThreadAccessResult,
  type ThreadAction,
  type ThreadOperation,
  type ThreadSubject,
} from "@dawn-ai/sdk"

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? true
    : false

type Expect<Value extends true> = Value

// The published unions, pinned member-for-member: adding or dropping one is a
// breaking change for every `switch` an app writes over them.
type _Action = Expect<Equal<ThreadAction, "create" | "read" | "update" | "delete">>
type _Operation = Expect<
  Equal<
    ThreadOperation,
    | "thread.create"
    | "thread.get"
    | "thread.state"
    | "thread.delete"
    | "thread.cancel"
    | "thread.pending_interrupts"
    | "run.stream"
    | "run.wait"
    | "run.resume"
    | "run.agui"
  >
>

type _HandlerInput = Expect<Equal<Parameters<DawnThreadAccess>[0], ThreadAccessRequest>>
type _HandlerOutput = Expect<Equal<Awaited<ReturnType<DawnThreadAccess>>, ThreadAccessResult>>
type _ResultUnion = Expect<Equal<ThreadAccessResult, ThreadAccessAllow | ThreadAccessDeny>>
type _Stamp = Expect<Equal<ThreadAccessAllow["stamp"], Record<string, unknown> | undefined>>
type _Status = Expect<Equal<ThreadAccessDeny["status"], 403 | 404 | undefined>>
type _Access = Expect<Equal<ThreadSubject["access"], Readonly<Record<string, unknown>> | undefined>>
type _Fallback = Expect<Equal<ThreadAccessPolicy["fallback"], DawnThreadAccess>>
type _PermitReturn = Expect<Equal<ReturnType<typeof permit>, ThreadAccessAllow>>
type _DenyReturn = Expect<Equal<ReturnType<typeof deny>, ThreadAccessDeny>>
// The reserved key must reach consumers as a literal, not as `string` — that is
// what lets store migrations and the operator backfill lift it out by name.
type _ReservedKey = Expect<Equal<typeof THREAD_ACCESS_METADATA_KEY, "dawn:access">>

const stored: Record<string, unknown> = {
  [THREAD_ACCESS_METADATA_KEY]: { ownerId: "u-1" },
  title: "untrusted, client-supplied",
}
const { [THREAD_ACCESS_METADATA_KEY]: lifted, ...withoutReserved } = stored
void lifted
void withoutReserved

// Every field is required, several as `T | undefined`: a runtime that forgets to
// pass one must not compile.
const subject: ThreadSubject = {
  thread_id: "t-1",
  created_at: "2026-08-10T00:00:00.000Z",
  updated_at: "2026-08-10T00:00:00.000Z",
  status: "interrupted",
  metadata: { title: "untrusted, client-supplied" },
  access: { ownerId: "u-1" },
}
void subject

const request: ThreadAccessRequest = {
  action: "read",
  operation: "thread.state",
  threadId: "t-1",
  thread: subject,
  headers: { "x-user-id": "u-1" },
  method: "GET",
  url: "/threads/t-1/state",
  requestedMetadata: undefined,
  resuming: false,
}
void request

// Required and a plain boolean, never `boolean | undefined`: a policy that
// treats resumes differently must be able to write `if (req.resuming)` with no
// `?? false`, and a runtime that forgets to pass it must not compile.
type _Resuming = Expect<Equal<ThreadAccessRequest["resuming"], boolean>>

// A resume-aware policy: the AG-UI door reports `run.agui` whether or not it is
// resuming, so `operation` cannot answer this question and `resuming` must.
const stepUpOnResume: DawnThreadAccess = (req) =>
  req.resuming && req.headers["x-step-up"] === undefined ? deny({ status: 403 }) : permit()
void stepUpOnResume

declare function sessionFor(
  token: string | undefined,
): Promise<{ readonly userId: string } | undefined>

// A sync handler: header-only, no await, the hot-path shape.
const owned: DawnThreadAccess = (req) => {
  const caller = req.headers["x-user-id"]
  return caller !== undefined && req.thread?.access?.ownerId === caller ? permit() : deny()
}

const policy: ThreadAccessPolicy = defineThreadAccess({
  create: (req) => {
    const caller = req.headers["x-user-id"]
    return caller === undefined ? deny({ status: 403 }) : permit({ ownerId: caller, org: "acme" })
  },
  // An async handler is equally correct.
  read: async (req) => {
    const session = await sessionFor(req.headers.authorization)
    if (session === undefined) return deny({ body: { error: "not found" }, status: 404 })
    return req.thread?.access?.ownerId === session.userId ? permit() : deny({ status: 404 })
  },
  update: owned,
  delete: owned,
  fallback: owned,
})
void policy

// The result union narrows on `decision`.
declare const result: ThreadAccessResult
if (result.decision === "allow") {
  const _stamp: Record<string, unknown> | undefined = result.stamp
  void _stamp
} else {
  const _status: 403 | 404 | undefined = result.status
  void _status
}

// @ts-expect-error `fallback` is required, so forgetting an action cannot silently allow.
const _noFallback: ThreadAccessPolicy = { read: () => permit() }
void _noFallback

// @ts-expect-error a policy that forgets `fallback` fails at the helper too.
defineThreadAccess({ delete: owned })

// @ts-expect-error only 403 and 404 are accepted.
deny({ status: 500 })

// @ts-expect-error the discriminant is `decision`; a copy-pasted middleware body must not compile.
const _wrongDiscriminant: DawnThreadAccess = () => ({ action: "continue" })
void _wrongDiscriminant

// @ts-expect-error the operation union is closed.
const _unknownOperation: ThreadOperation = "run.cancel"
void _unknownOperation
