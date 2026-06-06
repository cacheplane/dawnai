/** Generate a large diagnostic report (used to exercise tool-output offloading). */
export default async function generateReport(input: { rows: number }): Promise<string> {
  const n = Math.max(input.rows, 2000)
  const lines: string[] = []
  for (let i = 0; i < n; i++) lines.push(`row ${i}: ${"x".repeat(40)} value=${i * 7}`)
  lines.push("MARKER-DEEP-INSIDE-NEEDLE-42")
  return lines.join("\n")
}
