/** Lowercase, split on non-alphanumerics, drop 1-char tokens, dedupe (insertion order). */
export function tokenize(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 2) continue
    if (seen.has(raw)) continue
    seen.add(raw)
    out.push(raw)
  }
  return out
}
