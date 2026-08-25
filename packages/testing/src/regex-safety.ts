import { Script } from "node:vm"

const MAX_REGEX_SOURCE_CODE_UNITS = 4_096
const MAX_REGEX_INPUT_CODE_UNITS = 65_536
const REGEX_EXECUTION_TIMEOUT_MS = 100
const OVERSIZED_REGEX_SOURCE_MESSAGE = "Regular expression source exceeds 4096 UTF-16 code units"
const OVERSIZED_REGEX_INPUT_MESSAGE = "Regular expression input exceeds 65536 UTF-16 code units"
const REGEX_TIMEOUT_MESSAGE = "Regular expression evaluation exceeded 100ms execution limit"
const REGEX_TEST_SCRIPT = new Script("new RegExp(source, flags).test(input)", {
  filename: "dawn-regex-evaluation.vm",
})

type RegExpGetter = (this: RegExp) => unknown

function intrinsicRegExpGetter(property: string): RegExpGetter {
  const getter = Object.getOwnPropertyDescriptor(RegExp.prototype, property)?.get
  if (getter === undefined) {
    throw new Error(`RegExp.prototype.${property} is unavailable`)
  }
  return getter
}

const REGEXP_SOURCE_GETTER = intrinsicRegExpGetter("source")
const REGEXP_FLAG_GETTERS: ReadonlyArray<readonly [RegExpGetter, string]> = [
  [intrinsicRegExpGetter("hasIndices"), "d"],
  [intrinsicRegExpGetter("global"), "g"],
  [intrinsicRegExpGetter("ignoreCase"), "i"],
  [intrinsicRegExpGetter("multiline"), "m"],
  [intrinsicRegExpGetter("dotAll"), "s"],
  [intrinsicRegExpGetter("unicode"), "u"],
  [intrinsicRegExpGetter("unicodeSets"), "v"],
  [intrinsicRegExpGetter("sticky"), "y"],
]

function snapshotFlags(expression: RegExp): string {
  let flags = ""
  for (const [getter, flag] of REGEXP_FLAG_GETTERS) {
    if (Reflect.apply(getter, expression, []) === true) flags += flag
  }
  return flags
}

function isScriptExecutionTimeout(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ERR_SCRIPT_EXECUTION_TIMEOUT"
  )
}

export function createSafeRegexTester(expression: RegExp): (input: string) => boolean {
  const source = Reflect.apply(REGEXP_SOURCE_GETTER, expression, []) as string
  const flags = snapshotFlags(expression)

  if (source.length > MAX_REGEX_SOURCE_CODE_UNITS) {
    throw new RangeError(OVERSIZED_REGEX_SOURCE_MESSAGE)
  }

  return (input) => {
    if (input.length > MAX_REGEX_INPUT_CODE_UNITS) {
      throw new RangeError(OVERSIZED_REGEX_INPUT_MESSAGE)
    }

    try {
      return (
        REGEX_TEST_SCRIPT.runInNewContext(
          { flags, input, source },
          {
            contextCodeGeneration: { strings: false, wasm: false },
            timeout: REGEX_EXECUTION_TIMEOUT_MS,
          },
        ) === true
      )
    } catch (error) {
      if (isScriptExecutionTimeout(error)) {
        throw new RangeError(REGEX_TIMEOUT_MESSAGE)
      }
      throw error
    }
  }
}
