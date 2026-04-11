import { constants } from "node:fs"
import { access, readFile } from "node:fs/promises"
import { join } from "node:path"

import type { DawnConfig, LoadDawnConfigOptions, LoadedDawnConfig } from "./types.js"

export const DAWN_CONFIG_FILE = "dawn.config.ts"

type Token =
  | {
      readonly type:
        | "const"
        | "default"
        | "export"
        | "eof"
        | "equals"
        | "lbrace"
        | "rbrace"
        | "colon"
        | "comma"
        | "semicolon"
    }
  | { readonly type: "identifier"; readonly value: string }
  | { readonly type: "string"; readonly value: string }

type TokenType = Token["type"]
type TokenOfType<TType extends TokenType> = Extract<Token, { readonly type: TType }>

export async function loadDawnConfig(options: LoadDawnConfigOptions): Promise<LoadedDawnConfig> {
  const configPath = join(options.appRoot, DAWN_CONFIG_FILE)

  await access(configPath, constants.F_OK)

  const source = await readFile(configPath, "utf8")

  return {
    appRoot: options.appRoot,
    config: parseDawnConfig(source),
    configPath,
  }
}

function parseDawnConfig(source: string): DawnConfig {
  const parser = new DawnConfigParser(source)

  return parser.parse()
}

class DawnConfigParser {
  private readonly tokens: Token[]
  private currentIndex = 0
  private readonly stringBindings = new Map<string, string>()

  constructor(source: string) {
    this.tokens = tokenize(source)
  }

  parse(): DawnConfig {
    while (this.match("const")) {
      this.parseConstDeclaration()
      this.consumeOptional("semicolon")
    }

    this.consume("export")
    this.consume("default")

    const config = this.parseConfigObject()

    this.consumeOptional("semicolon")
    this.consume("eof")

    return config
  }

  private parseConstDeclaration(): void {
    const identifier = this.consume("identifier")
    this.consume("equals")
    const value = this.consume("string")
    this.stringBindings.set(identifier.value, value.value)
  }

  private parseConfigObject(): DawnConfig {
    this.consume("lbrace")

    let appDir: string | undefined

    while (!this.check("rbrace")) {
      const property = this.consume("identifier")

      if (property.value !== "appDir") {
        throw unsupportedConfig(`unsupported property "${property.value}"`)
      }

      const resolvedValue = this.match("colon")
        ? this.parsePropertyValue()
        : this.resolveIdentifier(property.value)

      appDir = resolvedValue

      if (!this.match("comma")) {
        break
      }
    }

    this.consume("rbrace")

    return appDir ? { appDir } : {}
  }

  private parsePropertyValue(): string {
    if (this.check("string")) {
      return this.consume("string").value
    }

    if (this.check("identifier")) {
      return this.resolveIdentifier(this.consume("identifier").value)
    }

    throw unsupportedConfig("property values must be string literals or const identifiers")
  }

  private resolveIdentifier(identifier: string): string {
    const resolved = this.stringBindings.get(identifier)

    if (!resolved) {
      throw unsupportedConfig(`unknown identifier "${identifier}"`)
    }

    return resolved
  }

  private match(type: TokenType): boolean {
    if (!this.check(type)) {
      return false
    }

    this.currentIndex += 1
    return true
  }

  private consume<TType extends TokenType>(type: TType): TokenOfType<TType> {
    const token = this.peek()

    if (token.type !== type) {
      throw unsupportedConfig(`expected ${type} but found ${describeToken(token)}`)
    }

    this.currentIndex += 1
    return token as TokenOfType<TType>
  }

  private consumeOptional(type: TokenType): void {
    this.match(type)
  }

  private check(type: TokenType): boolean {
    return this.peek().type === type
  }

  private peek(): Token {
    return this.tokens[this.currentIndex] ?? { type: "eof" }
  }
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = []
  let index = source.startsWith("\uFEFF") ? 1 : 0

  while (index < source.length) {
    const character = source[index]

    if (!character) {
      break
    }

    if (isWhitespace(character)) {
      index += 1
      continue
    }

    if (character === "/" && source[index + 1] === "/") {
      index += 2
      while (index < source.length && source[index] !== "\n") {
        index += 1
      }
      continue
    }

    if (character === "/" && source[index + 1] === "*") {
      const commentEnd = source.indexOf("*/", index + 2)

      if (commentEnd === -1) {
        throw unsupportedConfig("unterminated block comment")
      }

      index = commentEnd + 2
      continue
    }

    if (character === "{") {
      tokens.push({ type: "lbrace" })
      index += 1
      continue
    }

    if (character === "}") {
      tokens.push({ type: "rbrace" })
      index += 1
      continue
    }

    if (character === ":") {
      tokens.push({ type: "colon" })
      index += 1
      continue
    }

    if (character === ",") {
      tokens.push({ type: "comma" })
      index += 1
      continue
    }

    if (character === "=") {
      tokens.push({ type: "equals" })
      index += 1
      continue
    }

    if (character === ";") {
      tokens.push({ type: "semicolon" })
      index += 1
      continue
    }

    if (character === '"' || character === "'") {
      const [value, nextIndex] = readStringLiteral(source, index, character)
      tokens.push({ type: "string", value })
      index = nextIndex
      continue
    }

    if (isIdentifierStart(character)) {
      const [identifier, nextIndex] = readIdentifier(source, index)
      index = nextIndex

      if (identifier === "const" || identifier === "export" || identifier === "default") {
        tokens.push({ type: identifier })
      } else {
        tokens.push({ type: "identifier", value: identifier })
      }

      continue
    }

    throw unsupportedConfig(`unexpected token "${character}"`)
  }

  tokens.push({ type: "eof" })

  return tokens
}

function readStringLiteral(source: string, startIndex: number, quote: '"' | "'"): [string, number] {
  let index = startIndex + 1
  let value = ""

  while (index < source.length) {
    const character = source[index]

    if (!character) {
      break
    }

    if (character === "\\") {
      throw unsupportedConfig("escaped string literals are not supported")
    }

    if (character === quote) {
      return [value, index + 1]
    }

    value += character
    index += 1
  }

  throw unsupportedConfig("unterminated string literal")
}

function readIdentifier(source: string, startIndex: number): [string, number] {
  let index = startIndex + 1

  while (index < source.length && isIdentifierPart(source[index] ?? "")) {
    index += 1
  }

  return [source.slice(startIndex, index), index]
}

function isIdentifierStart(character: string): boolean {
  return /[A-Za-z_$]/.test(character)
}

function isIdentifierPart(character: string): boolean {
  return /[A-Za-z0-9_$]/.test(character)
}

function isWhitespace(character: string): boolean {
  return /\s/.test(character)
}

function describeToken(token: Token): string {
  return token.type === "identifier" || token.type === "string"
    ? `${token.type} "${token.value}"`
    : token.type
}

function unsupportedConfig(reason: string): Error {
  return new Error(
    `Unsupported dawn.config.ts syntax: ${reason}. Supported subset: optional const string declarations followed by export default { appDir } or export default { appDir: "..." }.`,
  )
}
