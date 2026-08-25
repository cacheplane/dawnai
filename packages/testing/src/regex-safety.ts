import safeRegex from "safe-regex2"

const MAX_REGEX_INPUT_CODE_UNITS = 65_536
const UNSAFE_REGEX_MESSAGE = "Regular expression is unsafe for synchronous matching"
const OVERSIZED_REGEX_INPUT_MESSAGE = "Regular expression input exceeds 65536 UTF-16 code units"

export function createSafeRegexTester(expression: RegExp): (input: string) => boolean {
  // safe-regex2 is a structural screen complemented by the input bound, not a
  // proof of the expression's runtime complexity.
  if (!safeRegex(expression)) {
    throw new TypeError(UNSAFE_REGEX_MESSAGE)
  }

  return (input) => {
    if (input.length > MAX_REGEX_INPUT_CODE_UNITS) {
      throw new RangeError(OVERSIZED_REGEX_INPUT_MESSAGE)
    }
    return new RegExp(expression.source, expression.flags).test(input)
  }
}
