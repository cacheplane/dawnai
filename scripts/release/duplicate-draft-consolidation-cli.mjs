import { EventEmitter } from "node:events"
import path from "node:path"
import { Writable } from "node:stream"
import {
  clearTimeout as clearTimer,
  setImmediate as scheduleImmediate,
  setTimeout as startTimer,
} from "node:timers"
import { setTimeout as waitFor } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { types as utilTypes } from "node:util"
import {
  inspectDuplicateDrafts,
  performDuplicateDraftConsolidation,
} from "./duplicate-draft-consolidation.mjs"
import { createDuplicateDraftConsolidationAdapters } from "./duplicate-draft-consolidation-adapters.mjs"

const INSPECT_EXPECTED = Object.freeze([
  "inspect",
  "--version",
  "0.8.22",
  "--commit-sha",
  "2a80deece2ff958fe7fde8fddeb4f99bed70a1c8",
  "--survivor",
  "379991871",
  "--duplicates",
  "379982100,379986168",
  "--output",
  ".dawn/release/duplicate-draft-consolidation.proposed.json",
])
const PERFORM_PREFIX = Object.freeze([
  "perform",
  "--proposal",
  ".dawn/release/duplicate-draft-consolidation.proposed.json",
  "--journal",
  ".dawn/release/duplicate-draft-consolidation.journal.json",
  "--receipt",
  "scripts/release/duplicate-draft-consolidation.json",
  "--confirmation",
])
const CONFIRMATION_PATTERN =
  /^CONSOLIDATE v0\.8\.22 2a80deece2ff958fe7fde8fddeb4f99bed70a1c8 SURVIVOR 379991871 DELETE 379982100,379986168 PROPOSAL ([0-9a-f]{64})$/u

export async function runDuplicateDraftConsolidationCli(options = {}) {
  let invocation
  try {
    invocation = normalizeOptions(options)
    const input = parseArguments(invocation.argv)
    const now = invocation.dependencies.now ?? (() => new Date().toISOString())
    const wait =
      invocation.dependencies.wait ??
      ((milliseconds, { signal }) => waitFor(milliseconds, undefined, { signal }))
    const createAdapters =
      invocation.dependencies.createAdapters ?? createDuplicateDraftConsolidationAdapters
    const inspect = invocation.dependencies.inspect ?? inspectDuplicateDrafts
    const perform = invocation.dependencies.perform ?? performDuplicateDraftConsolidation
    for (const operation of [now, wait, createAdapters, inspect, perform]) {
      if (typeof operation !== "function" || utilTypes.isProxy(operation))
        throw new InvocationError()
    }
    const repositoryRootIdentity = await inspectionRootCapture()(invocation.cwd)
    const result =
      input.mode === "inspect"
        ? await inspect(input.value, {
            repositoryRoot: invocation.cwd,
            adapters: await createAdapters({
              cwd: invocation.cwd,
              environment: invocation.environment,
              dependencies: { now },
            }),
            now,
            wait,
            repositoryRootIdentity,
          })
        : await perform(input.value, {
            repositoryRoot: invocation.cwd,
            createAdapters: () =>
              createAdapters({
                cwd: invocation.cwd,
                environment: invocation.environment,
                dependencies: { now },
              }),
            now,
            wait,
          })
    const summary =
      input.mode === "inspect" ? safeSummary(result, input.value) : safePerformSummary(result)
    if (!(await writeSink(invocation.stdout, `${JSON.stringify(summary)}\n`))) {
      await writeSink(invocation.stderr, `Duplicate-draft ${operationLabel(input.mode)} failed.\n`)
      return 1
    }
    return 0
  } catch (error) {
    const target = invocation?.stderr ?? safeInvocationStderr(options) ?? bindSink(process.stderr)
    await writeSink(
      target,
      error instanceof InvocationError
        ? "Invalid duplicate-draft consolidation invocation.\n"
        : `Duplicate-draft ${operationLabel(invocation?.mode)} failed.\n`,
    )
    return error instanceof InvocationError ? 2 : 1
  }
}

function inspectionRootCapture() {
  const descriptor = Object.getOwnPropertyDescriptor(
    inspectDuplicateDrafts,
    "captureRepositoryRoot",
  )
  if (
    descriptor?.enumerable !== false ||
    descriptor.writable !== false ||
    descriptor.configurable !== false ||
    typeof descriptor.value !== "function" ||
    utilTypes.isProxy(descriptor.value) ||
    !Object.isFrozen(descriptor.value)
  ) {
    throw new Error("Inspection root capture is unavailable")
  }
  return descriptor.value
}

async function writeSink(sink, chunk) {
  try {
    await sink.write(chunk)
    return true
  } catch {
    return false
  }
}

function safeInvocationStderr(options) {
  if (options === null || typeof options !== "object" || utilTypes.isProxy(options)) return null
  const descriptor = Object.getOwnPropertyDescriptor(options, "stderr")
  if (descriptor?.enumerable !== true || !("value" in descriptor)) return null
  try {
    return bindSink(descriptor.value)
  } catch {
    return null
  }
}

function parseArguments(argv) {
  const snapshot = snapshotArguments(argv)
  if (snapshot.length === INSPECT_EXPECTED.length) {
    for (const [index, expected] of INSPECT_EXPECTED.entries()) {
      if (snapshot[index] !== expected) throw new InvocationError()
    }
    return {
      mode: "inspect",
      value: {
        version: INSPECT_EXPECTED[2],
        commitSha: INSPECT_EXPECTED[4],
        survivor: INSPECT_EXPECTED[6],
        duplicates: INSPECT_EXPECTED[8].split(","),
        output: INSPECT_EXPECTED[10],
      },
    }
  }
  if (snapshot.length === PERFORM_PREFIX.length + 1) {
    for (const [index, expected] of PERFORM_PREFIX.entries()) {
      if (snapshot[index] !== expected) throw new InvocationError()
    }
    const confirmation = snapshot.at(-1)
    const match = CONFIRMATION_PATTERN.exec(confirmation)
    if (match === null) throw new InvocationError()
    return {
      mode: "perform",
      value: {
        proposal: PERFORM_PREFIX[2],
        proposalSha256: match[1],
        journal: PERFORM_PREFIX[4],
        receipt: PERFORM_PREFIX[6],
        confirmation,
      },
    }
  }
  throw new InvocationError()
}

function operationLabel(mode) {
  return mode === "perform" ? "perform" : "inspection"
}

function snapshotArguments(argv) {
  if (
    !Array.isArray(argv) ||
    utilTypes.isProxy(argv) ||
    Object.getOwnPropertySymbols(argv).length !== 0 ||
    Object.getOwnPropertyNames(argv).length !== argv.length + 1
  )
    throw new InvocationError()
  const output = []
  for (let index = 0; index < argv.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(argv, String(index))
    if (descriptor?.enumerable !== true || !("value" in descriptor)) throw new InvocationError()
    const value = descriptor.value
    if (typeof value !== "string") throw new InvocationError()
    output.push(value)
  }
  return output
}

function normalizeOptions(options) {
  const values = snapshotDataOptions(options, [
    "argv",
    "cwd",
    "environment",
    "stdout",
    "stderr",
    "dependencies",
  ])
  const cwd = values.cwd ?? process.cwd()
  if (typeof cwd !== "string" || !path.isAbsolute(cwd) || path.normalize(cwd) !== cwd)
    throw new InvocationError()
  const dependencies = snapshotDataOptions(values.dependencies ?? {}, [
    "createAdapters",
    "inspect",
    "perform",
    "now",
    "wait",
  ])
  const stdout = bindSink(values.stdout ?? process.stdout)
  const stderr = bindSink(values.stderr ?? process.stderr)
  const result = {
    argv: values.argv ?? process.argv.slice(2),
    cwd,
    environment: values.environment ?? process.env,
    stdout,
    stderr,
    dependencies,
  }
  try {
    const parsed = parseArguments(result.argv)
    result.mode = parsed.mode
  } catch {
    result.mode = null
  }
  return result
}

function bindSink(value) {
  if (value === null || typeof value !== "object" || utilTypes.isProxy(value)) {
    throw new InvocationError()
  }
  let owner = value
  let descriptor
  while (owner !== null) {
    descriptor = Object.getOwnPropertyDescriptor(owner, "write")
    if (descriptor !== undefined) break
    owner = Object.getPrototypeOf(owner)
  }
  if (
    descriptor === undefined ||
    !("value" in descriptor) ||
    typeof descriptor.value !== "function" ||
    utilTypes.isProxy(descriptor.value)
  ) {
    throw new InvocationError()
  }
  const write = descriptor.value
  const isNodeWritable = value instanceof Writable && write === Writable.prototype.write
  return Object.freeze({
    write(chunk) {
      if (isNodeWritable) return writeNodeWritable(value, write, chunk)
      return Reflect.apply(write, value, [chunk])
    },
  })
}

function writeNodeWritable(stream, write, chunk) {
  return new Promise((resolve, reject) => {
    let settled = false
    let scheduled = false
    let succeeded = false
    const cleanup = () => {
      Reflect.apply(EventEmitter.prototype.removeListener, stream, ["error", onError])
      clearTimer(deadline)
    }
    const finish = () => {
      if (settled) return
      settled = true
      cleanup()
      if (succeeded) resolve()
      else reject(new Error("Output sink failed"))
    }
    const schedule = (success) => {
      if (!success) succeeded = false
      else if (!scheduled) succeeded = true
      if (scheduled) return
      scheduled = true
      scheduleImmediate(finish)
    }
    const onError = () => schedule(false)
    Reflect.apply(EventEmitter.prototype.on, stream, ["error", onError])
    const deadline = startTimer(() => schedule(false), 5_000)
    deadline.unref?.()
    try {
      const result = Reflect.apply(write, stream, [
        chunk,
        (error) => {
          schedule(error === undefined || error === null)
        },
      ])
      if (result !== null && (typeof result === "object" || typeof result === "function")) {
        Promise.resolve(result).catch(onError)
      }
    } catch {
      schedule(false)
    }
  })
}

function snapshotDataOptions(value, allowed) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    utilTypes.isProxy(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Object.getOwnPropertySymbols(value).length !== 0
  )
    throw new InvocationError()
  const names = Object.getOwnPropertyNames(value)
  if (names.some((name) => !allowed.includes(name))) throw new InvocationError()
  const output = {}
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name)
    if (
      descriptor?.enumerable !== true ||
      !("value" in descriptor) ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined
    )
      throw new InvocationError()
    output[name] = descriptor.value
  }
  return output
}

function safeSummary(value, input) {
  if (value === null || typeof value !== "object" || !/^[0-9a-f]{64}$/u.test(value.proposalSha256))
    throw new Error("Inspection summary is invalid")
  for (const field of ["version", "commitSha", "survivor", "output"]) {
    if (value[field] !== input[field]) throw new Error("Inspection summary identity is invalid")
  }
  if (
    !Array.isArray(value.duplicates) ||
    value.duplicates.length !== 2 ||
    value.duplicates.some((id, index) => id !== input.duplicates[index])
  ) {
    throw new Error("Inspection summary duplicate identity is invalid")
  }
  return {
    proposalSha256: value.proposalSha256,
    version: input.version,
    commitSha: input.commitSha,
    survivor: input.survivor,
    duplicates: [...input.duplicates],
    output: input.output,
  }
}

function safePerformSummary(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    value.status !== "complete" ||
    value.survivor !== "379991871" ||
    value.receipt !== "scripts/release/duplicate-draft-consolidation.json" ||
    !/^[0-9a-f]{64}$/u.test(value.receiptSha256) ||
    !Array.isArray(value.deleted) ||
    value.deleted.length !== 2 ||
    value.deleted[0] !== "379982100" ||
    value.deleted[1] !== "379986168"
  ) {
    throw new Error("Perform summary is invalid")
  }
  return {
    status: value.status,
    survivor: value.survivor,
    deleted: [...value.deleted],
    receipt: value.receipt,
    receiptSha256: value.receiptSha256,
  }
}

class InvocationError extends Error {}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await runDuplicateDraftConsolidationCli()
}
