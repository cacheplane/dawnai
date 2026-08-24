/**
 * Where the thread rail gets its threads.
 *
 * Dawn's server can create and fetch a thread by id but cannot enumerate
 * threads — there is no list endpoint, and adding one is a thread-access
 * authorization question rather than a UI one. So the rail keeps its own list.
 *
 * CopilotKit's `useThreads` is deliberately unused: it fetches from a platform
 * with thread endpoints and folds "runtime without thread endpoints" into its
 * error channel, which is what a Dawn backend would produce.
 *
 * The planned second implementation is LangGraph Platform, which Dawn already
 * deploys to (`dawn build --target langsmith`) and which can enumerate threads.
 * An earlier version of this note predicted the interface would have to go
 * async for that backend; that has now come true for `hydrate` and
 * `pendingInterrupts`, which are network reads for EVERY backend — the rail's
 * list lives in the browser while the conversation lives in the server.
 * `list`/`create` are still synchronous — LangGraph Platform will make those
 * async too (or add a cached-read variant), and callers change with it.
 *
 * Known limitation: the localStorage backend below does read-modify-write with
 * no merge, so concurrent tabs can clobber each other's writes (e.g. a
 * `create()` in one tab can erase a `touch()` title from another).
 */
import type { PermissionMetadata } from "../components/PermissionPrompt"
import { type HydratedThread, hydrateThreadState } from "./hydrate"

export interface WorkbenchThread {
  readonly id: string
  readonly title?: string
  readonly lastActiveAt: number
}

export interface ThreadSource {
  list(): WorkbenchThread[]
  create(): WorkbenchThread
  touch(id: string, firstUserMessage?: string): void
  /**
   * The thread's stored history. Async because it is a network read even for
   * the localStorage source: the rail's list lives in the browser, but the
   * conversation lives in the Dawn server's checkpoint.
   */
  hydrate(id: string): Promise<HydratedThread>
  /**
   * The permission gates the backend is holding for this thread right now.
   *
   * The second backend read, and it lives on the seam for the same reason
   * `hydrate` does: a reloaded page has no idea a run is parked, only the
   * server does. Keeping it here is what makes the LangGraph Platform
   * implementation a swap rather than a rewrite — that backend answers the
   * same question at a different URL with a different body, and nothing above
   * this line should know which one it is talking to.
   *
   * Empty is the ordinary answer, and every *expected* failure resolves to it
   * (see the implementation). `signal` aborts the in-flight read when the user
   * switches away; a genuine network failure rejects.
   */
  pendingInterrupts(id: string, signal?: AbortSignal): Promise<ParkedInterrupt[]>
}

/**
 * One parked permission gate, ready for the card to render.
 *
 * `metadata` is typed by the CARD rather than here, and the import is
 * type-only. The Dawn envelope has no shape of its own on this side of the
 * wire — it is whatever `PermissionPrompt` reads out of it — so letting the
 * consumer own the type keeps one definition instead of a lib-side copy that
 * can drift from the component actually rendering it.
 */
export interface ParkedInterrupt {
  readonly interruptId: string
  readonly metadata: PermissionMetadata
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * `GET /threads/:id/pending_interrupts` -> what the card needs.
 *
 * `entry.value` IS the Dawn interrupt envelope — the same object
 * `@dawn-ai/ag-ui`'s `toAguiInterrupt` parks under `Interrupt.metadata` on the
 * live path — so a hydrated gate and a live one reach `PermissionPrompt` as
 * the same shape. (`toAguiInterrupt` itself is not exported from the package
 * root, only its envelope types are, and widening a package's public API for
 * an example is the wrong direction. Reading an id and passing the rest
 * through is the whole of what this consumer needs from it.)
 *
 * The id comes off the ENTRY, not off `value`. The server already decided it,
 * as `innerId ?? outerId` in `packages/cli/src/lib/dev/pending-interrupts.ts`,
 * and it is the id the resume path matches against — re-deriving that
 * precedence here would be a second copy of the rule, free to drift into
 * resuming an id the server does not recognize.
 *
 * Total rather than throwing: an entry with no usable id cannot be resumed, so
 * a card for it would be a button that can only fail. Dropping it leaves the
 * thread exactly as stranded as it already was, which is only worse than the
 * alternative if the alternative works — and it cannot.
 */
export function readParkedInterrupts(body: unknown): ParkedInterrupt[] {
  if (!isRecord(body) || !Array.isArray(body.interrupts)) return []
  const parked: ParkedInterrupt[] = []
  for (const entry of body.interrupts) {
    if (!isRecord(entry)) continue
    const interruptId = entry.interruptId
    if (typeof interruptId !== "string" || interruptId.length === 0) continue
    const value = entry.value
    parked.push({ interruptId, metadata: (isRecord(value) ? value : {}) as PermissionMetadata })
  }
  return parked
}

const STORAGE_KEY = "dawn.workbench.threads"
const MAX_TITLE_LENGTH = 80

function read(storage: Storage): WorkbenchThread[] {
  try {
    const raw = storage.getItem(STORAGE_KEY)
    if (raw === null) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (entry): entry is WorkbenchThread =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as { id?: unknown }).id === "string" &&
        typeof (entry as { lastActiveAt?: unknown }).lastActiveAt === "number",
    )
  } catch {
    // A corrupt or unavailable store costs the rail its history, never the run.
    return []
  }
}

function write(storage: Storage, threads: readonly WorkbenchThread[]): void {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(threads))
  } catch {
    // A failed write (e.g. private-mode quota) still leaves the mutator
    // returning/completing as if it persisted: the conversation is
    // unaffected, but the rail's in-memory state is now ahead of storage
    // and that history is what's lost.
  }
}

function byMostRecent(threads: readonly WorkbenchThread[]): WorkbenchThread[] {
  return [...threads].sort((left, right) => right.lastActiveAt - left.lastActiveAt)
}

/**
 * The useful half of a failed response, or "".
 *
 * The proxy's own 502 body is `{ error: "Cannot reach the Dawn server at
 * http://127.0.0.1:3002: ECONNREFUSED..." }` and the Dawn server's is
 * `{ error: { kind, message } }` — both are written to be shown, and a bare
 * "HTTP 502" throws away the only part that says what to do about it. Any
 * failure to read or parse the body degrades to "" rather than replacing the
 * status with a SyntaxError: an error path that can itself error is how a
 * proxy's HTML error page ends up in the UI as "Unexpected token '<'".
 */
async function failureDetail(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json()
    if (typeof body !== "object" || body === null) return ""
    const error = (body as { error?: unknown }).error
    if (typeof error === "string") return error
    if (typeof error === "object" && error !== null) {
      const message = (error as { message?: unknown }).message
      if (typeof message === "string") return message
    }
    return ""
  } catch {
    return ""
  }
}

/**
 * `fetchFn` is a parameter rather than a bare `globalThis.fetch` call so a test
 * can inject one without patching a global. It defaults to `fetch` bound to
 * `globalThis`: an unbound reference would throw "Illegal invocation" in the
 * browser.
 */
export function createLocalThreadSource(
  storage: Storage,
  fetchFn: typeof fetch = (...args) => globalThis.fetch(...args),
): ThreadSource {
  return {
    list() {
      return byMostRecent(read(storage))
    },
    create() {
      const thread: WorkbenchThread = {
        id: globalThis.crypto.randomUUID(),
        lastActiveAt: Date.now(),
      }
      write(storage, [thread, ...read(storage)])
      return thread
    },
    touch(id, firstUserMessage) {
      const threads = read(storage)
      const existing = threads.find((thread) => thread.id === id)
      if (existing === undefined) return
      const title =
        existing.title ??
        (firstUserMessage === undefined || firstUserMessage.trim().length === 0
          ? undefined
          : firstUserMessage.trim().slice(0, MAX_TITLE_LENGTH))
      const updated: WorkbenchThread = {
        id,
        lastActiveAt: Date.now(),
        ...(title !== undefined ? { title } : {}),
      }
      write(storage, [updated, ...threads.filter((thread) => thread.id !== id)])
    },
    async hydrate(id) {
      const response = await fetchFn(`/api/dawn/threads/${encodeURIComponent(id)}/state`)
      // A 404 is the ORDINARY answer, not a failure: the Dawn server returns
      // it both for a thread it has never heard of and for one that exists in
      // the rail but has never run, and a freshly created thread is in that
      // second state until its first turn finishes. A fresh literal per call,
      // never a shared constant — the caller owns what it gets back.
      if (response.status === 404) return { messages: [], todos: [] }
      if (!response.ok) {
        const detail = await failureDetail(response)
        throw new Error(
          `Could not load this conversation (HTTP ${response.status})${detail === "" ? "" : `: ${detail}`}`,
        )
      }
      return hydrateThreadState(await response.json())
    },
    async pendingInterrupts(id, signal) {
      const response = await fetchFn(
        `/api/dawn/threads/${encodeURIComponent(id)}/pending_interrupts`,
        signal === undefined ? undefined : { signal },
      )
      // EVERY non-2xx is an empty list, and none of them is worth telling the
      // user about. A 404 is a thread with no checkpoint row, a 409 a thread
      // that has never run or whose route is gone, a 403 the proxy refusing a
      // path outside its allowlist — and the ordinary answer for a healthy
      // thread that simply is not parked is a 200 with an empty array, which
      // this deliberately cannot be distinguished from. There is nothing the
      // reader could do with any of it: the worst case is that a prompt which
      // may well not exist is not restored, and the transcript's own restore
      // already reports a server that is genuinely unreachable, in a message
      // about something the reader can actually see.
      if (!response.ok) return []
      return readParkedInterrupts(await response.json())
    },
  }
}
