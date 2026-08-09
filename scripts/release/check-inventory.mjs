import { fileURLToPath } from "node:url"

import { GitReadError } from "./adapters/git.mjs"
import {
  assertValidReleaseInventory,
  ReleaseInventoryError,
  readReleaseInventory,
} from "./inventory.mjs"

class UsageError extends Error {
  constructor(message) {
    super(message)
    this.name = "UsageError"
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2))
    const inventory = await readReleaseInventory({ root: process.cwd(), ref: options.ref })
    const result = assertValidReleaseInventory(inventory)
    printSuccess(result, options.json)
  } catch (error) {
    const json = process.argv.includes("--json")
    if (
      error instanceof ReleaseInventoryError ||
      error instanceof GitReadError ||
      error instanceof UsageError
    ) {
      printExpectedError(error, json)
    } else {
      printUnexpectedError(error, json)
    }
    process.exitCode = 1
  }
}

function parseArgs(args) {
  let ref = "HEAD"
  let json = false

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === "--json") {
      json = true
      continue
    }
    if (argument === "--ref") {
      const value = args[index + 1]
      if (value === undefined) {
        throw new UsageError("--ref requires a value")
      }
      ref = value
      index += 1
      continue
    }
    throw new UsageError(`Unknown argument: ${argument}`)
  }

  return { ref, json }
}

function printSuccess(result, json) {
  if (json) {
    console.log(JSON.stringify({ packages: result.packages, version: result.version }, null, 2))
    return
  }

  console.log(`Release version: ${result.version}`)
  console.log(`Packages (${result.packages.length}):`)
  for (const name of result.packages) {
    console.log(`- ${name}`)
  }
}

function printExpectedError(error, json) {
  if (json) {
    console.error(
      JSON.stringify({
        type: error.name,
        error: error.message,
        ...(error.details !== undefined ? { differences: error.details } : {}),
      }),
    )
    return
  }

  console.error(error.message)
  if (error.details === undefined) {
    return
  }
  for (const category of [
    "structuralErrors",
    "workspaceDuplicates",
    "duplicates",
    "extra",
    "missing",
    "privateMembers",
    "unknownMembers",
    "versionMismatches",
  ]) {
    if (error.details[category].length > 0) {
      console.error(`${category}: ${formatCategory(error.details[category])}`)
    }
  }
}

function formatCategory(values) {
  return values
    .map((value) =>
      typeof value === "string" ? value : `${value.name} (${value.manifests.join(", ")})`,
    )
    .join(", ")
}

function printUnexpectedError(error, json) {
  if (json) {
    console.error(
      JSON.stringify({
        type: error instanceof Error ? error.name : "UnknownError",
        error: error instanceof Error ? error.message : String(error),
        ...(error instanceof Error && error.stack !== undefined ? { stack: error.stack } : {}),
      }),
    )
    return
  }
  console.error(error)
}
