const IDENTIFIER_PATTERN = /[A-Za-z_$][A-Za-z0-9_$]*/g
const UNICODE_ESCAPE_PATTERN = /\\u(?:([0-9A-Fa-f]{4})|\{([0-9A-Fa-f]{1,6})\})/g

function canonicalizeUnicodeEscapes(source: string): string {
  return source.replace(UNICODE_ESCAPE_PATTERN, (match, fixed: string, braced: string) => {
    const codePoint = Number.parseInt(fixed || braced, 16)
    return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : match
  })
}

export function createGeneratedIdentifierAllocator(source: string): (base: string) => string {
  const canonicalSource = canonicalizeUnicodeEscapes(source)
  const used = new Set(canonicalSource.match(IDENTIFIER_PATTERN) ?? [])

  return (base) => {
    let identifier = base
    let suffix = 2
    while (used.has(identifier)) {
      identifier = `${base}${suffix}`
      suffix += 1
    }
    used.add(identifier)
    return identifier
  }
}
