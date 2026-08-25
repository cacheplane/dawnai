#!/usr/bin/env node

import { spawn } from "node:child_process"
import { lstat, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"

const DESCRIPTOR_FIELDS = Object.freeze([
  "schemaVersion",
  "command",
  "args",
  "cwd",
  "env",
  "readyPath",
  "gatePath",
])
const MAX_DESCRIPTOR_BYTES = 512 * 1024
const MAX_ENVIRONMENT_BYTES = 256 * 1024
const MAX_ARGUMENT_BYTES = 64 * 1024
const MAX_ARGUMENTS = 4_096

export function parseSmokeCommandDescriptor(value) {
  if (
    !(value instanceof Uint8Array) ||
    value.byteLength < 1 ||
    value.byteLength > MAX_DESCRIPTOR_BYTES
  ) {
    throw new TypeError("Smoke command descriptor bytes are missing or exceed their bound")
  }
  const bytes = Buffer.from(value)
  let source
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch (error) {
    throw new TypeError("Smoke command descriptor must be valid UTF-8", { cause: error })
  }
  let descriptor
  try {
    descriptor = JSON.parse(source)
  } catch (error) {
    throw new TypeError("Smoke command descriptor must be valid JSON", { cause: error })
  }
  validateDescriptor(descriptor)
  const canonical = canonicalSmokeCommandDescriptor(descriptor)
  if (!bytes.equals(canonical)) {
    throw new Error("Smoke command descriptor bytes must be canonical")
  }
  return deepFreeze(descriptor)
}

export function canonicalSmokeCommandDescriptor(value) {
  validateDescriptor(value)
  const env = Object.fromEntries(
    Object.keys(value.env)
      .sort()
      .map((key) => [key, value.env[key]]),
  )
  return Buffer.from(
    `${JSON.stringify({
      schemaVersion: 1,
      command: value.command,
      args: [...value.args],
      cwd: value.cwd,
      env,
      readyPath: value.readyPath,
      gatePath: value.gatePath,
    })}\n`,
    "utf8",
  )
}

async function main() {
  if (process.argv.length !== 3) throw new Error("Smoke command shim requires one descriptor path")
  const descriptorPath = process.argv[2]
  if (!path.isAbsolute(descriptorPath) || path.basename(descriptorPath) !== "command.json") {
    throw new Error("Smoke command descriptor path must be exact and absolute")
  }
  const status = await lstat(descriptorPath)
  const uid = typeof process.getuid === "function" ? process.getuid() : null
  if (
    !status.isFile() ||
    status.nlink !== 1 ||
    (status.mode & 0o777) !== 0o600 ||
    !Number.isSafeInteger(uid) ||
    status.uid !== uid
  ) {
    throw new Error("Smoke command descriptor must be an owned mode-0600 regular file")
  }
  const descriptor = parseSmokeCommandDescriptor(await readFile(descriptorPath))
  const directory = path.dirname(descriptorPath)
  if (
    descriptor.readyPath !== path.join(directory, "ready") ||
    descriptor.gatePath !== path.join(directory, "gate")
  ) {
    throw new Error("Smoke command descriptor gate paths escape the control directory")
  }
  await writeFile(descriptor.readyPath, "ready\n", { flag: "wx", mode: 0o600 })
  await waitForGate(descriptor.gatePath, uid)
  const child = spawn(descriptor.command, descriptor.args, {
    cwd: descriptor.cwd,
    env: descriptor.env,
    shell: false,
    stdio: "inherit",
  })
  const result = await new Promise((resolvePromise, rejectPromise) => {
    child.once("error", rejectPromise)
    child.once("close", (code, signal) => resolvePromise({ code, signal }))
  })
  if (Number.isSafeInteger(result.code)) {
    process.exitCode = result.code
    return
  }
  throw new Error(`Smoke command was terminated by ${result.signal ?? "an unknown signal"}`)
}

async function waitForGate(gatePath, uid) {
  for (;;) {
    try {
      const status = await lstat(gatePath)
      if (
        !status.isFile() ||
        status.nlink !== 1 ||
        (status.mode & 0o777) !== 0o600 ||
        status.uid !== uid ||
        (await readFile(gatePath, "utf8")) !== "go\n"
      ) {
        throw new Error("Smoke command gate is malformed")
      }
      return
    } catch (error) {
      if (error?.code !== "ENOENT") throw error
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25))
  }
}

function validateDescriptor(value) {
  if (
    value === null ||
    Array.isArray(value) ||
    typeof value !== "object" ||
    Object.keys(value).sort().join(",") !== [...DESCRIPTOR_FIELDS].sort().join(",") ||
    value.schemaVersion !== 1 ||
    typeof value.command !== "string" ||
    value.command.length < 1 ||
    value.command.length > 4_096 ||
    /\0/u.test(value.command) ||
    !Array.isArray(value.args) ||
    value.args.length > MAX_ARGUMENTS ||
    typeof value.cwd !== "string" ||
    !path.isAbsolute(value.cwd) ||
    typeof value.readyPath !== "string" ||
    !path.isAbsolute(value.readyPath) ||
    typeof value.gatePath !== "string" ||
    !path.isAbsolute(value.gatePath) ||
    value.env === null ||
    Array.isArray(value.env) ||
    typeof value.env !== "object"
  ) {
    throw new TypeError("Smoke command descriptor shape is invalid")
  }
  for (const argument of value.args) {
    if (
      typeof argument !== "string" ||
      Buffer.byteLength(argument, "utf8") > MAX_ARGUMENT_BYTES ||
      /\0/u.test(argument)
    ) {
      throw new TypeError("Smoke command descriptor argument is invalid")
    }
  }
  let environmentBytes = 0
  const keys = Object.keys(value.env)
  if (keys.length > 512) throw new TypeError("Smoke command descriptor environment is too large")
  for (const key of keys) {
    const entry = value.env[key]
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || typeof entry !== "string" || /\0/u.test(entry)) {
      throw new TypeError("Smoke command descriptor environment entry is invalid")
    }
    environmentBytes += Buffer.byteLength(key, "utf8") + Buffer.byteLength(entry, "utf8") + 2
  }
  if (environmentBytes > MAX_ENVIRONMENT_BYTES) {
    throw new TypeError("Smoke command descriptor environment exceeds its byte bound")
  }
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const child of Object.values(value)) deepFreeze(child)
  return value
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href

if (invokedDirectly) {
  try {
    await main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
