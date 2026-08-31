#!/usr/bin/env node

import { spawn } from "node:child_process"
import {
  appendFileSync,
  chmodSync,
  closeSync,
  constants as fsConstants,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  writeFileSync,
  writeSync,
} from "node:fs"
import { join } from "node:path"

const SIGNAL_STATUS = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143,
}

const [mode, runDirectory, requestFifo, responseFifo, ...unexpected] = process.argv.slice(2)
if (
  mode !== "--server" ||
  !runDirectory ||
  !requestFifo ||
  !responseFifo ||
  unexpected.length > 0
) {
  process.stderr.write("usage: run-bounded.mjs --server RUN_DIR REQUEST_FIFO RESPONSE_FIFO\n")
  process.exit(2)
}

const eventLogPath = process.env.SMOKE_RUN_BOUNDED_EVENT_LOG
const record = (event, signal) => {
  if (!eventLogPath) return
  appendFileSync(eventLogPath, `${JSON.stringify(signal ? { event, signal } : { event })}\n`)
}

const writePrivate = (path, value = "") => {
  writeFileSync(path, value, { encoding: "utf8", mode: 0o600 })
  chmodSync(path, 0o600)
}

const wrapperPath = join(runDirectory, "wrapper.sh")
const serverReadyPath = join(runDirectory, "server-ready")
const serverStoppedPath = join(runDirectory, "server-stopped")
const wrapperSource = `#!/bin/sh
set +m

call_directory=$1
shift
stdout_path=$call_directory/stdout
stderr_path=$call_directory/stderr
decision_path=$call_directory/decision
owner_path=$call_directory/owner
status_path=$call_directory/status
ready_path=$call_directory/ready
signal_received_path=$call_directory/signal-received

monitor_server_lease() {
  trap 'exit 0' HUP INT TERM
  IFS= read -r _ <&3 || kill -KILL 0
}

stop_server_lease_monitor() {
  kill -TERM "$server_lease_monitor_pid" 2>/dev/null || :
  wait "$server_lease_monitor_pid" 2>/dev/null || :
}

block_for_kill() {
  trap '' HUP INT TERM
  if [ "\${SMOKE_RUN_BOUNDED_TEST_SKIP_SIGNAL_MARKER:-0}" != "1" ]; then
    printf 'signal-received\\n' >"$signal_received_path"
  fi
  while :; do
    /bin/sleep 2147483647 &
    wait "$!" 2>/dev/null || :
  done
}

trap 'block_for_kill' HUP INT TERM

monitor_server_lease &
server_lease_monitor_pid=$!

"$@" 3<&- >"$stdout_path" 2>"$stderr_path" &
command_pid=$!
printf 'ready\\n' >"$ready_path"

command_status=0
wait "$command_pid" || command_status=$?
if mkdir "$decision_path" 2>/dev/null; then
  printf 'normal\\n' >"$owner_path"
  printf '%s\\n' "$command_status" >"$status_path"
  stop_server_lease_monitor
  exit "$command_status"
fi

block_for_kill
`

writePrivate(wrapperPath, wrapperSource)

const delay = (milliseconds) =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds)
  })

const fileHasContent = (path) => {
  try {
    return readFileSync(path, "utf8").length > 0
  } catch (error) {
    if (error.code === "ENOENT") return false
    throw error
  }
}

const readPositiveInteger = (text, description) => {
  if (!/^[1-9][0-9]*$/.test(text)) {
    throw new Error(`${description} must be a positive integer`)
  }
  const value = Number(text)
  if (!Number.isSafeInteger(value)) throw new Error(`${description} is too large`)
  return value
}

const readCommand = (callDirectory) => {
  const argc = readPositiveInteger(readFileSync(join(callDirectory, "argc"), "utf8").trim(), "argc")
  const command = []
  for (let index = 0; index < argc; index += 1) {
    const argument = readFileSync(join(callDirectory, `arg.${index}`), "utf8")
    if (argument.includes("\0")) throw new Error(`arg.${index} contains a NUL byte`)
    command.push(argument)
  }
  return command
}

let activeCall
const signalHandlers = new Map()
for (const signal of Object.keys(SIGNAL_STATUS)) {
  const handler = () => activeCall?.requestSignal(signal)
  signalHandlers.set(signal, handler)
  process.on(signal, handler)
}

async function executeCall(sequence, timeoutMs, graceMs) {
  const deadline = Date.now() + timeoutMs
  const callDirectory = join(runDirectory, `call.${sequence}`)
  chmodSync(callDirectory, 0o700)
  const paths = {
    complete: join(callDirectory, "complete"),
    decision: join(callDirectory, "decision"),
    helperPid: join(callDirectory, "helper-pid"),
    owner: join(callDirectory, "owner"),
    ready: join(callDirectory, "ready"),
    responseReady: join(callDirectory, "response-ready"),
    result: join(callDirectory, "result"),
    signal: join(callDirectory, "signal"),
    signalReceived: join(callDirectory, "signal-received"),
    signalRequest: join(callDirectory, "signal-request"),
    status: join(callDirectory, "status"),
    stderr: join(callDirectory, "stderr"),
    stdout: join(callDirectory, "stdout"),
    supervisorReady: join(callDirectory, "supervisor-ready"),
    timeout: join(callDirectory, "timeout"),
    wrapperPid: join(callDirectory, "wrapper-pid"),
  }
  const command = readCommand(callDirectory)

  for (const path of [
    paths.complete,
    paths.helperPid,
    paths.owner,
    paths.ready,
    paths.responseReady,
    paths.result,
    paths.signal,
    paths.signalReceived,
    paths.status,
    paths.stderr,
    paths.stdout,
    paths.supervisorReady,
    paths.timeout,
    paths.wrapperPid,
  ]) {
    writePrivate(path)
  }
  writePrivate(paths.helperPid, `${process.pid}\n`)

  let requestedSignal = ""
  let wrapper
  let wrapperPid
  let wrapperReaped = false
  let decisionOwner = ""
  let shutdownPromise
  let timeoutTimer
  let requestPoller
  let requestLease
  let callError
  let asyncError
  let resultStatus
  let termSent = false
  let killSent = false
  let exceptionRecorded = false

  let resolveWrapperStarted
  let wrapperStartedResolved = false
  const wrapperStarted = new Promise((resolve) => {
    resolveWrapperStarted = resolve
  })
  const markWrapperStarted = (pid) => {
    if (wrapperStartedResolved) return
    wrapperStartedResolved = true
    resolveWrapperStarted(pid)
  }

  const requestSignal = (signal) => {
    if (!Object.hasOwn(SIGNAL_STATUS, signal) || requestedSignal) return
    requestedSignal = signal
    if (wrapperPid !== undefined) startDecision("signal", signal)
  }
  activeCall = { requestSignal }

  let resolveWrapperClose
  const wrapperClose = new Promise((resolve) => {
    resolveWrapperClose = resolve
  })

  const waitForMarker = async (path, maximumWaitMs) => {
    const markerDeadline =
      maximumWaitMs === undefined ? undefined : Date.now() + Math.max(0, maximumWaitMs)
    while (!wrapperReaped && !fileHasContent(path)) {
      if (markerDeadline !== undefined && Date.now() >= markerDeadline) return false
      await delay(2)
    }
    return fileHasContent(path)
  }

  const signalGroup = (signal) => {
    if (wrapperReaped || wrapperPid === undefined) return
    if (signal === "SIGTERM") {
      if (termSent) return
      termSent = true
    }
    if (signal === "SIGKILL") {
      if (killSent) return
      killSent = true
    }
    record("signal-group", signal)
    try {
      process.kill(-wrapperPid, signal)
    } catch (error) {
      if (error.code !== "ESRCH") throw error
    }
  }

  const settleDecision = async (owner, signal) => {
    const startedPid = await wrapperStarted
    if (startedPid === undefined) {
      if (owner === "timeout") return 124
      if (owner === "signal") return SIGNAL_STATUS[signal]
      return 125
    }
    signalGroup("SIGTERM")
    let markerError
    try {
      if (await waitForMarker(paths.signalReceived, graceMs)) record("signal-received")
    } catch (error) {
      markerError = error
    }
    await delay(graceMs)
    signalGroup("SIGKILL")
    await wrapperClose
    if (markerError) throw markerError
    if (owner === "timeout") return 124
    if (owner === "signal") return SIGNAL_STATUS[signal]
    return 125
  }

  function startDecision(owner, signal = "") {
    if (wrapperReaped || decisionOwner) return false
    try {
      mkdirSync(paths.decision, { mode: 0o700 })
    } catch (error) {
      if (error.code === "EEXIST") return false
      throw error
    }

    decisionOwner = owner
    writePrivate(paths.owner, `${owner}\n`)
    if (owner === "timeout") writePrivate(paths.timeout, "timeout\n")
    if (owner === "signal") writePrivate(paths.signal, `${signal}\n`)
    record("decision", owner === "signal" ? signal : owner)
    shutdownPromise = settleDecision(owner, signal)
    return true
  }

  const readSignalRequest = () => {
    try {
      const signal = readFileSync(paths.signalRequest, "utf8").trim()
      if (signal) requestSignal(signal)
    } catch (error) {
      if (error.code !== "ENOENT") throw error
    }
  }

  const recordException = () => {
    if (exceptionRecorded) return
    exceptionRecorded = true
    record("call-exception")
  }

  const captureAsyncError = (error) => {
    if (asyncError) return
    asyncError = error
    recordException()
    try {
      startDecision("error")
    } catch (decisionError) {
      asyncError = decisionError
    }
  }

  try {
    timeoutTimer = setTimeout(
      () => {
        try {
          startDecision("timeout")
        } catch (error) {
          captureAsyncError(error)
        }
      },
      Math.max(0, deadline - Date.now()),
    )
    requestPoller = setInterval(() => {
      try {
        readSignalRequest()
      } catch (error) {
        captureAsyncError(error)
      }
    }, 2)
    readSignalRequest()

    wrapper = spawn("/bin/sh", [wrapperPath, callDirectory, ...command], {
      detached: true,
      stdio: ["ignore", "ignore", "ignore", "pipe"],
    })
    requestLease = wrapper.stdio[3]
    requestLease.resume()
    wrapper.once("error", (error) => {
      captureAsyncError(error)
      process.stderr.write(`run-bounded.mjs: wrapper spawn failed: ${error.message}\n`)
    })
    wrapper.once("close", (code, signal) => {
      requestLease?.destroy()
      wrapperReaped = true
      wrapperPid = undefined
      record("wrapper-reaped")
      resolveWrapperClose({ code, signal })
    })
    wrapperPid = wrapper.pid
    if (wrapperPid === undefined) {
      markWrapperStarted(undefined)
      throw new Error("bounded wrapper did not expose a process ID")
    }
    markWrapperStarted(wrapperPid)
    writePrivate(paths.wrapperPid, `${wrapperPid}\n`)

    if (requestedSignal) startDecision("signal", requestedSignal)
    const becameReady = await waitForMarker(paths.ready)
    if (becameReady) {
      record("wrapper-ready")
      if (process.env.SMOKE_RUN_BOUNDED_TEST_FAIL_AFTER_READY === "1") {
        throw new Error("injected failure after wrapper readiness")
      }
      readSignalRequest()
      if (requestedSignal) startDecision("signal", requestedSignal)
      writePrivate(paths.supervisorReady, "supervisor-ready\n")
    }
    if (asyncError) throw asyncError

    const closeOutcome = await wrapperClose
    if (asyncError) throw asyncError
    if (shutdownPromise) {
      resultStatus = await shutdownPromise
    } else {
      const owner = readFileSync(paths.owner, "utf8").trim()
      const rawStatus = readFileSync(paths.status, "utf8").trim()
      if (owner !== "normal" || !/^\d+$/.test(rawStatus)) {
        process.stderr.write(
          `run-bounded.mjs: wrapper exited without a normal decision (code=${closeOutcome.code}, signal=${closeOutcome.signal ?? "none"})\n`,
        )
        resultStatus = 125
      } else {
        resultStatus = Number(rawStatus)
      }
    }
  } catch (error) {
    callError = error
    recordException()
    if (!wrapperReaped) {
      try {
        startDecision("error")
      } catch (decisionError) {
        callError = decisionError
      }
    }
  } finally {
    if (timeoutTimer !== undefined) clearTimeout(timeoutTimer)
    if (requestPoller !== undefined) clearInterval(requestPoller)
    activeCall = undefined
    markWrapperStarted(undefined)

    if (!wrapperReaped && wrapper !== undefined) {
      if (!shutdownPromise) {
        try {
          startDecision("error")
        } catch (error) {
          callError ??= error
        }
      }
      if (shutdownPromise) {
        try {
          const shutdownStatus = await shutdownPromise
          resultStatus ??= shutdownStatus
        } catch (error) {
          callError ??= error
        }
      }
      if (!wrapperReaped) {
        signalGroup("SIGTERM")
        await delay(graceMs)
        signalGroup("SIGKILL")
        await wrapperClose
      }
    }
    requestLease?.destroy()
  }

  if (callError) throw callError
  writePrivate(paths.result, `${resultStatus}\n`)
  writePrivate(paths.complete, "complete\n")
  return resultStatus
}

const requestDescriptor = openSync(requestFifo, fsConstants.O_RDWR | fsConstants.O_NONBLOCK)
const responseDescriptor = openSync(responseFifo, fsConstants.O_RDWR | fsConstants.O_NONBLOCK)
let requestBuffer = ""

const readRequestLine = async () => {
  const chunk = Buffer.alloc(4_096)
  while (true) {
    const newlineIndex = requestBuffer.indexOf("\n")
    if (newlineIndex !== -1) {
      const line = requestBuffer.slice(0, newlineIndex).replace(/\r$/, "")
      requestBuffer = requestBuffer.slice(newlineIndex + 1)
      return line
    }
    try {
      const bytesRead = readSync(requestDescriptor, chunk, 0, chunk.length, null)
      if (bytesRead > 0) requestBuffer += chunk.subarray(0, bytesRead).toString("utf8")
      else await delay(2)
    } catch (error) {
      if (error.code !== "EAGAIN" && error.code !== "EWOULDBLOCK") throw error
      await delay(2)
    }
  }
}

const sendResponse = async (line) => {
  const output = Buffer.from(`${line}\n`)
  let offset = 0
  while (offset < output.length) {
    try {
      offset += writeSync(responseDescriptor, output, offset, output.length - offset)
    } catch (error) {
      if (error.code !== "EAGAIN" && error.code !== "EWOULDBLOCK") throw error
      await delay(2)
    }
  }
}

await sendResponse("READY")
writePrivate(serverReadyPath, "ready\n")
record("server-ready")

let stopped = false
process.once("exit", () => {
  if (stopped) writePrivate(serverStoppedPath, "stopped\n")
})
try {
  while (true) {
    const line = await readRequestLine()
    if (line === "STOP") {
      await sendResponse("STOPPED")
      stopped = true
      record("server-stopping")
      break
    }

    const fields = line.split("\t")
    const [operation, sequenceText, timeoutText, graceText] = fields
    if (operation !== "RUN" || fields.length !== 4 || !/^[1-9][0-9]*$/.test(sequenceText)) {
      await sendResponse("ERROR\t0\tinvalid request")
      continue
    }

    const sequence = readPositiveInteger(sequenceText, "call sequence")
    try {
      const timeoutMs = readPositiveInteger(timeoutText, "timeout")
      const graceMs = readPositiveInteger(graceText, "grace")
      const status = await executeCall(sequence, timeoutMs, graceMs)
      await sendResponse(`RESULT\t${sequence}\t${status}`)
      writePrivate(join(runDirectory, `call.${sequence}`, "response-ready"), "ready\n")
    } catch (error) {
      activeCall = undefined
      process.stderr.write(`run-bounded.mjs: call ${sequence} failed: ${error.message}\n`)
      const callDirectory = join(runDirectory, `call.${sequence}`)
      writePrivate(join(callDirectory, "result"), "125\n")
      writePrivate(join(callDirectory, "complete"), "complete\n")
      await sendResponse(`RESULT\t${sequence}\t125`)
      writePrivate(join(callDirectory, "response-ready"), "ready\n")
    }
  }
} finally {
  closeSync(requestDescriptor)
  closeSync(responseDescriptor)
  record("response-ended")
  for (const [signal, handler] of signalHandlers) process.off(signal, handler)
  record("signal-handlers-removed")
}

if (!stopped) {
  process.stderr.write("run-bounded.mjs: request FIFO closed without STOP\n")
  process.exitCode = 1
}
