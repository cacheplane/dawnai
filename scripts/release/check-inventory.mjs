import { fileURLToPath } from "node:url"

import {
  assertValidReleaseInventory,
  ReleaseInventoryError,
  readReleaseInventory,
} from "./inventory.mjs"

class UsageError extends Error {}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2))
    const inventory = await readReleaseInventory({ root: process.cwd(), ref: options.ref })
    const result = assertValidReleaseInventory(inventory)
    printSuccess(result, options.json)
  } catch (error) {
    if (error instanceof ReleaseInventoryError || error instanceof UsageError) {
      printExpectedError(error, process.argv.includes("--json"))
    } else {
      console.error(error)
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
    "duplicates",
    "extra",
    "missing",
    "privateMembers",
    "unknownMembers",
    "versionMismatches",
  ]) {
    if (error.details[category].length > 0) {
      console.error(`${category}: ${error.details[category].join(", ")}`)
    }
  }
}
