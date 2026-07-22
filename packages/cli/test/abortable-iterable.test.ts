import { EventType } from "@ag-ui/core"
import { type DawnAgentStreamChunk, toAguiEvents } from "@dawn-ai/ag-ui"
import { expect, test } from "vitest"

import { abortableAsyncIterable } from "../src/lib/dev/abortable-iterable.js"

test("aborting a pending next rejects and closes the source iterator", async () => {
  let sourceClosed = false
  const source: AsyncIterable<string> = {
    [Symbol.asyncIterator]() {
      return {
        next: () => new Promise<IteratorResult<string>>(() => undefined),
        return: async () => {
          sourceClosed = true
          return { done: true, value: undefined }
        },
      }
    },
  }
  const controller = new AbortController()
  const iterator = abortableAsyncIterable(source, controller.signal)[Symbol.asyncIterator]()

  const next = iterator.next()
  controller.abort(new Error("client disconnected"))

  await expect(next).rejects.toThrow("client disconnected")
  expect(sourceClosed).toBe(true)
})

test("aborting a native async generator with a blocked next rejects promptly", async () => {
  const source = (async function* () {
    yield await new Promise<string>(() => undefined)
  })()
  const originalReturn = source.return.bind(source)
  let returnCalled = false
  source.return = (value) => {
    returnCalled = true
    return originalReturn(value)
  }
  const controller = new AbortController()
  const reason = new Error("native generator aborted")
  const iterator = abortableAsyncIterable(source, controller.signal)[Symbol.asyncIterator]()
  let outcome: unknown
  void iterator.next().then(
    () => {
      outcome = new Error("iteration unexpectedly resolved")
    },
    (error: unknown) => {
      outcome = error
    },
  )

  controller.abort(reason)
  await new Promise<void>((resolve) => setImmediate(resolve))

  expect(returnCalled).toBe(true)
  expect(outcome).toBe(reason)
})

test("a rejecting source cleanup cannot append RUN_ERROR after RUN_FINISHED", async () => {
  let emittedDone = false
  const source: AsyncIterable<DawnAgentStreamChunk> = {
    [Symbol.asyncIterator]() {
      return {
        next: async () => {
          if (emittedDone) return { done: true, value: undefined }
          emittedDone = true
          return { done: false, value: { type: "done", data: { ok: true } } as const }
        },
        return: async () => {
          throw new Error("cleanup failed")
        },
      }
    },
  }
  const events = []

  for await (const event of toAguiEvents(
    abortableAsyncIterable(source, new AbortController().signal),
    { threadId: "thread-1", runId: "run-1" },
  )) {
    events.push(event)
  }

  expect(events.map((event) => event.type)).toEqual([EventType.RUN_STARTED, EventType.RUN_FINISHED])
})

test("a source next failure propagates even when cleanup also rejects", async () => {
  const nextError = new Error("next failed")
  const source: AsyncIterable<string> = {
    [Symbol.asyncIterator]() {
      return {
        next: async () => {
          throw nextError
        },
        return: async () => {
          throw new Error("cleanup failed")
        },
      }
    },
  }
  const iterator = abortableAsyncIterable(source, new AbortController().signal)[
    Symbol.asyncIterator
  ]()

  await expect(iterator.next()).rejects.toBe(nextError)
})
